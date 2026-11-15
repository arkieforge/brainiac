import { ulid } from "@brainiac/core";

import { getNote, type NoteRow } from "./notes.ts";
import { PIPELINE } from "./pages.ts";
import { CHUNKS, EMBED_MODEL, fileOwner } from "./search.ts";
import type { Sql } from "./sql.ts";
import { getFile, needsJob, type FileRow } from "./vault.ts";

/** A dispatched job not acknowledged within this long is dispatched again. */
export const LEASE_MS = 5 * 60_000;
/**
 * After this many dispatches a job is marked failed.
 * shortcut: nothing shows or retries a failed job yet, so its note stays out of search at that revision until
 * the next edit, and a file stays unread (it looks like a scan) until the person confirms its kind again;
 * `brainiac doctor` (#8) and the site's record health should list them.
 */
export const MAX_ATTEMPTS = 5;
/** Deleted notes are tombstones this long, then purged, and undo works from revisions this old (contract §6). */
export const TOMBSTONE_MS = 30 * 24 * 60 * 60_000;
/** The change feed keeps this much history; an older cursor gets a snapshot. */
export const CHANGES_MS = 90 * 24 * 60 * 60_000;

/**
 * Follow-up work for one revision of a note or a file. `index` rebuilds a note's search chunks and vectors;
 * `file` extracts an upload's text, runs the vault's checks over it and, once the file is cleared, indexes its
 * pages.
 */
export type JobKind = "index" | "file";

export interface Job {
  readonly id: string;
  readonly kind: JobKind;
  /** The note's id, or for a `file` job its `fileOwner` (`file:<sha256>`). */
  readonly noteId: string;
  /** The note's revision, or the file's `rev`, which every confirmation bumps. */
  readonly rev: number;
  readonly status: "pending" | "dispatched" | "failed";
  readonly attempts: number;
  readonly dispatchedAt: number | null;
}

/**
 * Adds a job in the caller's transaction (the transactional outbox). A pending job of the same kind for an
 * older revision of the note is replaced; one already dispatched runs on, and its result is dropped.
 */
export function enqueue(sql: Sql, kind: JobKind, noteId: string, rev: number): void {
  sql.all("DELETE FROM jobs WHERE kind = ? AND noteId = ? AND status = 'pending'", kind, noteId);
  sql.all(
    "INSERT INTO jobs (id, kind, noteId, rev, status) VALUES (?, ?, ?, ?, 'pending')",
    ulid(),
    kind,
    noteId,
    rev,
  );
}

/**
 * The jobs to dispatch now: pending ones, and dispatched ones whose lease ran out. Drops jobs whose note has
 * moved to another revision or been deleted, and fails jobs that used up their attempts. Leaves due jobs as
 * they are, so a crash before `markDispatched` dispatches them again.
 */
export function dueJobs(sql: Sql, now: number): Job[] {
  return sql.transaction(() => {
    sql.all(`DELETE FROM jobs WHERE NOT (${CURRENT})`);
    sql.all(
      "UPDATE jobs SET status = 'failed' WHERE status = 'dispatched' AND attempts >= ? AND dispatchedAt <= ?",
      MAX_ATTEMPTS,
      now - LEASE_MS,
    );
    const room = IN_FLIGHT - inFlight(sql, now);
    if (room <= 0) return [];
    return sql.all<Job>(
      // Newest first, by when it was enqueued: an upload or edit goes out ahead of a re-index backlog (`reindex`),
      // which waits in the record rather than in the queue, since no more than `IN_FLIGHT` are out at once.
      `SELECT * FROM jobs WHERE status = 'pending' OR (status = 'dispatched' AND dispatchedAt <= ?)
       ORDER BY rowid DESC LIMIT ?`,
      now - LEASE_MS,
      room,
    );
  });
}

/**
 * The most jobs a record has on the queue at once. Each install makes room (the DO re-arms its alarm), so a
 * fresh upload waits for one job to finish, not for every job queued before it.
 */
export const IN_FLIGHT = 20;

const inFlight = (sql: Sql, now: number) =>
  sql.all<{ n: number }>(
    "SELECT count(*) AS n FROM jobs WHERE status = 'dispatched' AND dispatchedAt > ?",
    now - LEASE_MS,
  )[0]?.n ?? 0;

/** Records that jobs were handed to the queue; each one is due again when its lease runs out. */
export function markDispatched(sql: Sql, ids: readonly string[], now: number): void {
  sql.transaction(() => {
    for (const id of ids) {
      sql.all(
        "UPDATE jobs SET status = 'dispatched', dispatchedAt = ?, attempts = attempts + 1 WHERE id = ?",
        now,
        id,
      );
    }
  });
}

// A job is current while its note (live) or file is still at the job's revision; anything else is stale, since a
// newer revision has its own job. A file job's owner is `file:<sha256>`.
const CURRENT = `EXISTS (SELECT 1 FROM notes
    WHERE notes.id = jobs.noteId AND notes.rev = jobs.rev AND notes.deletedAt IS NULL)
  OR (jobs.kind = 'file' AND EXISTS (SELECT 1 FROM files
    WHERE files.sha256 = substr(jobs.noteId, 6) AND files.rev = jobs.rev))`;

/** What a job works on, as of its revision. */
export type JobInput =
  | { readonly job: Job & { readonly kind: "index" }; readonly note: NoteRow }
  | { readonly job: Job & { readonly kind: "file" }; readonly file: FileRow };

/** The note or file a job works on, at the job's revision; a stale job is dropped and `undefined` returned. */
export function jobInput(sql: Sql, jobId: string): JobInput | undefined {
  const [job] = sql.all<Job>(`SELECT * FROM jobs WHERE id = ? AND (${CURRENT})`, jobId);
  if (job?.kind === "index") {
    const note = getNote(sql, job.noteId);
    if (note) return { job: { ...job, kind: job.kind }, note };
  }
  if (job?.kind === "file") {
    const file = getFile(sql, job.noteId.slice("file:".length));
    if (file) return { job: { ...job, kind: job.kind }, file };
  }
  sql.all("DELETE FROM jobs WHERE id = ?", jobId);
  return undefined;
}

/**
 * Completes a job with `install`, but only while its note or file is still at the job's revision; otherwise the
 * result is dropped. Either way the job is done.
 */
export function finishJob(sql: Sql, jobId: string, install: (job: Job) => void): "installed" | "dropped" {
  return sql.transaction(() => {
    const [job] = sql.all<Job>(`SELECT * FROM jobs WHERE id = ? AND (${CURRENT})`, jobId);
    sql.all("DELETE FROM jobs WHERE id = ?", jobId);
    if (!job) return "dropped";
    install(job);
    return "installed";
  });
}

/**
 * What every chunk and vector is built with: the chunking, the file extraction and the embedding model. A record
 * whose index was built otherwise re-indexes every note and cleared file in the background, while the chunks it
 * has carry search. Bump `CHUNKS` when chunking changes.
 * shortcut: one version for all three, so a new `PIPELINE` re-embeds notes too; split it when that costs.
 */
export const INDEX_VERSION = `${CHUNKS} pipeline-${PIPELINE} ${EMBED_MODEL}`;

/**
 * Enqueues a re-index of the whole record if its index was built with another `INDEX_VERSION`, in one
 * transaction with the version it records; true if it did. Files an older extraction left unread are extracted
 * again with it. One read when the index is current, so the DO runs it
 * on every wake. A record from before vectors re-indexes once this way, which is how it gets them.
 */
export function reindex(sql: Sql): boolean {
  return sql.transaction(() => {
    const [row] = sql.all<{ value: string }>("SELECT value FROM meta WHERE key = 'index'");
    if (row?.value === INDEX_VERSION) return false;
    // Every job goes, dispatched ones too: one built the old way must not install over the new one's result.
    sql.all("DELETE FROM jobs");
    for (const note of sql.all<{ id: string; rev: number }>(
      "SELECT id, rev FROM notes WHERE deletedAt IS NULL",
    ))
      enqueue(sql, "index", note.id, note.rev);
    for (const file of sql.all<Pick<FileRow, "sha256" | "rev" | "mime" | "class" | "pipelineVersion">>(
      "SELECT sha256, rev, mime, class, pipelineVersion FROM files",
    ))
      if (needsJob(file)) enqueue(sql, "file", fileOwner(file.sha256), file.rev);
    sql.all(
      "INSERT INTO meta (key, value) VALUES ('index', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      INDEX_VERSION,
    );
    return true;
  });
}

/** History older than its window waits up to this long, so an active record wakes for it at most daily. */
const HISTORY_GRACE_MS = 24 * 60 * 60_000;

/**
 * When the record next has background work: a job to dispatch or retry, a tombstone to purge, history
 * (revisions, the change feed) past its window, or a held change whose hold runs out.
 */
export function nextWake(sql: Sql, now: number): number | null {
  const full = inFlight(sql, now) >= IN_FLIGHT;
  const [row] = sql.all<{ at: number | null }>(
    `SELECT min(at) AS at FROM (
       SELECT CASE WHEN status = 'pending' THEN ?
           WHEN ? AND dispatchedAt + ? <= ? THEN NULL ELSE dispatchedAt + ? END AS at
         FROM jobs WHERE status IN ('pending', 'dispatched')
       UNION ALL SELECT min(deletedAt) + ? FROM notes WHERE deletedAt IS NOT NULL
       UNION ALL SELECT min(at) + ? FROM revisions
       UNION ALL SELECT min(at) + ? FROM changes
       UNION ALL SELECT min(at) + ? FROM landed)`,
    // While the queue is full, nothing waiting can go: not a pending job, nor one whose lease already ran out. An
    // install, or a lease still running out, makes room.
    full ? null : now,
    full ? 1 : 0,
    LEASE_MS,
    now,
    LEASE_MS,
    TOMBSTONE_MS,
    TOMBSTONE_MS + HISTORY_GRACE_MS,
    CHANGES_MS + HISTORY_GRACE_MS,
    CHANGES_MS + HISTORY_GRACE_MS,
  );
  // Its own query: Durable Object SQLite allows no more terms in one compound SELECT.
  const [held] = sql.all<{ at: number | null }>(
    "SELECT min(autoApplyAt) AS at FROM proposals WHERE status = 'open' AND autoApplyAt IS NOT NULL",
  );
  const times = [row?.at, held?.at].filter((at) => typeof at === "number");
  return times.length > 0 ? Math.min(...times) : null;
}

/** Removes tombstones past 30 days with everything derived from them, and history past its window. */
export function purge(sql: Sql, now: number): void {
  sql.transaction(() => {
    const expired = "SELECT id FROM notes WHERE deletedAt <= ?";
    const before = now - TOMBSTONE_MS;
    for (const fts of ["chunks_fts_normal", "chunks_fts_sensitive"]) {
      sql.all(
        `DELETE FROM ${fts} WHERE rowid IN (SELECT id FROM chunks WHERE noteId IN (${expired}))`,
        before,
      );
    }
    sql.all(
      `DELETE FROM vectors WHERE chunkId IN (SELECT id FROM chunks WHERE noteId IN (${expired}))`,
      before,
    );
    for (const table of ["chunks", "revisions", "jobs", "checks", "questions", "proposals"]) {
      sql.all(`DELETE FROM ${table} WHERE noteId IN (${expired})`, before);
    }
    sql.all(`DELETE FROM edges WHERE fromId IN (${expired}) OR toId IN (${expired})`, before, before);
    sql.all("DELETE FROM notes WHERE deletedAt <= ?", before);
    sql.all("DELETE FROM revisions WHERE at <= ?", now - TOMBSTONE_MS);
    sql.all("DELETE FROM changes WHERE at <= ?", now - CHANGES_MS);
    sql.all("DELETE FROM landed WHERE at <= ?", now - CHANGES_MS);
  });
}
