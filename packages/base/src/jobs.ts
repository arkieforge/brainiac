import { ulid } from "@brainiac/core";

import { getNote, type NoteRow } from "./notes.ts";
import type { Sql } from "./sql.ts";

/** A dispatched job not acknowledged within this long is dispatched again. */
export const LEASE_MS = 5 * 60_000;
/**
 * After this many dispatches a job is marked failed.
 * shortcut: nothing shows or retries a failed job yet, so its note stays out of search at that revision until
 * the next edit; `brainiac doctor` (#8) and the site's record health should list them.
 */
export const MAX_ATTEMPTS = 5;
/** Deleted notes are tombstones this long, then purged, and undo works from revisions this old (contract §6). */
export const TOMBSTONE_MS = 30 * 24 * 60 * 60_000;
/** The change feed keeps this much history; an older cursor gets a snapshot. */
export const CHANGES_MS = 90 * 24 * 60 * 60_000;

/** Follow-up work for one revision of a note. `index` rebuilds its search chunks. */
export type JobKind = "index";

export interface Job {
  readonly id: string;
  readonly kind: JobKind;
  readonly noteId: string;
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
export function dueJobs(sql: Sql, now: number, limit = 100): Job[] {
  return sql.transaction(() => {
    sql.all(
      `DELETE FROM jobs WHERE NOT EXISTS (
         SELECT 1 FROM notes WHERE notes.id = jobs.noteId AND notes.rev = jobs.rev AND notes.deletedAt IS NULL)`,
    );
    sql.all(
      "UPDATE jobs SET status = 'failed' WHERE status = 'dispatched' AND attempts >= ? AND dispatchedAt <= ?",
      MAX_ATTEMPTS,
      now - LEASE_MS,
    );
    return sql.all<Job>(
      `SELECT * FROM jobs WHERE status = 'pending' OR (status = 'dispatched' AND dispatchedAt <= ?)
       ORDER BY id LIMIT ?`,
      now - LEASE_MS,
      limit,
    );
  });
}

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

/**
 * The note a job works on, at the job's revision. A job whose note has moved on is stale: it is dropped and
 * `undefined` returned, since the newer revision has its own job.
 */
export function jobInput(sql: Sql, jobId: string): { readonly job: Job; readonly note: NoteRow } | undefined {
  const [job] = sql.all<Job>("SELECT * FROM jobs WHERE id = ?", jobId);
  if (!job) return undefined;
  const note = getNote(sql, job.noteId);
  if (note && note.rev === job.rev && note.deletedAt === null) return { job, note };
  sql.all("DELETE FROM jobs WHERE id = ?", jobId);
  return undefined;
}

/**
 * Completes a job with `install`, but only while its note is still at the job's revision; otherwise the
 * result is dropped. Either way the job is done.
 */
export function finishJob(sql: Sql, jobId: string, install: (job: Job) => void): "installed" | "dropped" {
  return sql.transaction(() => {
    const [job] = sql.all<Job>(
      `SELECT jobs.* FROM jobs JOIN notes ON notes.id = jobs.noteId
       WHERE jobs.id = ? AND notes.rev = jobs.rev AND notes.deletedAt IS NULL`,
      jobId,
    );
    sql.all("DELETE FROM jobs WHERE id = ?", jobId);
    if (!job) return "dropped";
    install(job);
    return "installed";
  });
}

/** History older than its window waits up to this long, so an active record wakes for it at most daily. */
const HISTORY_GRACE_MS = 24 * 60 * 60_000;

/**
 * When the record next has background work: a job to dispatch or retry, a tombstone to purge, or history
 * (revisions, the change feed) past its window.
 */
export function nextWake(sql: Sql, now: number): number | null {
  const [row] = sql.all<{ at: number | null }>(
    `SELECT min(at) AS at FROM (
       SELECT CASE status WHEN 'pending' THEN ? ELSE dispatchedAt + ? END AS at
         FROM jobs WHERE status IN ('pending', 'dispatched')
       UNION ALL SELECT min(deletedAt) + ? FROM notes WHERE deletedAt IS NOT NULL
       UNION ALL SELECT min(at) + ? FROM revisions
       UNION ALL SELECT min(at) + ? FROM changes)`,
    now,
    LEASE_MS,
    TOMBSTONE_MS,
    TOMBSTONE_MS + HISTORY_GRACE_MS,
    CHANGES_MS + HISTORY_GRACE_MS,
  );
  return row?.at ?? null;
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
  });
}
