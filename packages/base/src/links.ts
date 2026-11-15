// Saved links, the record's half (docs/product/features/projects-profiles-links.md). A Link note names a page the
// person saved; a `link` job reads it outside the record and the record writes what came back into the note's
// `synced:` block, as the links connector, through the mutation path. The first read at an address also takes the
// page's text (treg `web.extract`) and a PDF snapshot (Browser Rendering), the evidence of what it said when it was
// saved; after that the page is only checked for being there, weekly, which costs nothing. The detector in
// packages/core/src/review.ts raises a check when an open application relies on a link that is gone.
import { relationTo, type PatchOp, type YamlValue } from "@brainiac/core";

import { DAY_MS } from "./hold.ts";
import { finishJob } from "./jobs.ts";
import { mutate } from "./mutate.ts";
import { getNote, type NoteRow } from "./notes.ts";
import type { Sql } from "./sql.ts";
import { recordUpload } from "./vault.ts";

/** A link's health is checked again this long after its last check, and a failed job is tried again after it too. */
export const HEALTH_MS = 7 * DAY_MS;

/** Who the record says wrote a Link's `synced:` block. */
export const LINKS_ACTOR = "connector:links";

/** The most of a page's text the note keeps; the snapshot holds all of it. */
export const EXCERPT = 500;

/**
 * What a `link` job sends out: the address, and whether this read still has to take a snapshot (`capture`) and the
 * page's text (`extract`), which the first read at an address does. A sensitive note's address never goes to treg,
 * only to our own fetch and Browser Rendering.
 */
export interface LinkWork {
  readonly url: string;
  readonly capture: boolean;
  readonly extract: boolean;
}

/**
 * What the read found: the page answers (with its title and text, when this read took them), it is gone (404 or
 * 410), or it couldn't be told (blocked, unreachable, a server error) and why. Only a 404 or a 410 says a page is
 * gone: a page that refuses robots, or a server down for an hour, says nothing about it.
 */
export type LinkSeen =
  | { readonly status: "live"; readonly title?: string; readonly text?: string }
  | { readonly status: "dead"; readonly code: number }
  | { readonly status: "unchecked"; readonly why: string };

interface Due {
  readonly id: string;
  readonly rev: number;
  /** Now for an address never read; a week after the last check otherwise. */
  readonly dueAt: number;
}

/**
 * Every live Link with a text `url` and no job on its way, with when it is next due. A block filled for another
 * address (the person changed it) is due at once. A failed job waits a week, like a check that ran, so an address
 * that keeps failing is never fetched in a loop.
 */
const checks = (sql: Sql) =>
  sql.all<Due>(
    `SELECT id, rev, max(
       CASE WHEN fm ->> '$.synced.url' IS fm ->> '$.url'
         THEN coalesce(strftime('%s', fm ->> '$.synced.checked') * 1000, 0) + ? ELSE 0 END,
       coalesce((SELECT max(dispatchedAt) FROM jobs
         WHERE jobs.kind = 'link' AND jobs.noteId = notes.id AND jobs.status = 'failed'), -?) + ?
     ) AS dueAt
     FROM notes
     WHERE type = 'Link' AND deletedAt IS NULL AND json_type(fm, '$.url') = 'text'
       AND NOT EXISTS (SELECT 1 FROM jobs
         WHERE jobs.kind = 'link' AND jobs.noteId = notes.id AND jobs.status != 'failed')`,
    HEALTH_MS,
    HEALTH_MS,
    HEALTH_MS,
  );

/** The links to check now, for the caller to enqueue; any job that failed for one of them goes. */
export function linksDue(sql: Sql, now: number): { readonly id: string; readonly rev: number }[] {
  const due = checks(sql).filter((link) => link.dueAt <= now);
  for (const link of due) sql.all("DELETE FROM jobs WHERE kind = 'link' AND noteId = ?", link.id);
  return due;
}

/** When the next link is due a check, or null if there is none. One already due is due `now`. */
export function nextLinkCheck(sql: Sql, now: number): number | null {
  const times = checks(sql).map((link) => link.dueAt);
  return times.length > 0 ? Math.max(now, Math.min(...times)) : null;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What a link job sends out for `note`, or undefined if it no longer names a page we may fetch. */
export function linkWork(note: NoteRow): LinkWork | undefined {
  const data: Readonly<Record<string, unknown>> = JSON.parse(note.fm);
  const url = data["url"];
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) return undefined;
  const synced = isRecord(data["synced"]) && data["synced"]["url"] === url ? data["synced"] : {};
  return {
    url: url.trim(),
    capture: synced["snapshot"] === undefined,
    extract: synced["excerpt"] === undefined && note.class === "normal",
  };
}

const clip = (text: string) => (text.length > EXCERPT ? `${text.slice(0, EXCERPT - 1).trimEnd()}…` : text);

/**
 * The patch that sets the note's `synced:` block for `seen`, key by key. What the first read at this address took
 * (title, excerpt, snapshot) stays until the address changes; a weekly check only says whether the page is there.
 */
function syncedOps(
  data: Readonly<Record<string, unknown>>,
  seen: LinkSeen,
  snapshot: string | undefined,
  now: number,
): PatchOp[] {
  const url = String(data["url"]);
  const old = isRecord(data["synced"]) && data["synced"]["url"] === url ? data["synced"] : {};
  const text = seen.status === "live" ? seen.text?.replaceAll(/\s+/g, " ").trim() : undefined;
  const kept = (key: string) => (typeof old[key] === "string" ? old[key] : undefined);
  const block: Record<string, YamlValue | undefined> = {
    url,
    status: seen.status,
    ...(seen.status === "dead" && { code: seen.code }),
    ...(seen.status === "unchecked" && { why: seen.why }),
    title: (seen.status === "live" && seen.title?.trim()) || kept("title"),
    excerpt: text ? clip(text) : kept("excerpt"),
    snapshot: snapshot ?? kept("snapshot"),
    checked: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  const before = isRecord(data["synced"]) ? Object.keys(data["synced"]) : [];
  return [
    ...Object.entries(block)
      .filter((entry): entry is [string, YamlValue] => entry[1] !== undefined && entry[1] !== "")
      .map(([key, value]): PatchOp => ({ op: "set", path: ["synced", key], value })),
    ...before
      .filter((key) => block[key] === undefined || block[key] === "")
      .map((key): PatchOp => ({ op: "unset", path: ["synced", key] })),
  ];
}

/** A page's PDF snapshot as the record seals it into R2 before the install (`sealFile`). */
export interface Snapshot {
  readonly sha256: string;
  readonly r2Key: string;
  readonly bytes: number;
  /** The record's data key (`dataKey`), which recording an upload takes. */
  readonly key: Uint8Array;
}

/**
 * Writes a link job's answer as the links connector, only while the link is still at the job's revision; an edit
 * in the meantime drops it and the link is read again. A snapshot goes into the vault as any upload does, with a
 * sidecar note that starts sensitive and unclassified until the person says what it is, and the link names that
 * note. A write the record refuses (the person verified the block) leaves the job failed, so the link waits a week.
 */
export function installLink(
  sql: Sql,
  jobId: string,
  seen: LinkSeen,
  snapshot: Snapshot | undefined,
  now: number,
): "installed" | "dropped" {
  const ctx = { actor: LINKS_ACTOR, now };
  return finishJob(sql, jobId, (job) => {
    const note = getNote(sql, job.noteId);
    if (!note) return "failed";
    // No kind: from anyone but the person it would read as their confirmation of what the file is.
    const uploaded =
      snapshot &&
      recordUpload(
        sql,
        snapshot.key,
        {
          sha256: snapshot.sha256,
          r2Key: snapshot.r2Key,
          bytes: snapshot.bytes,
          mime: "application/pdf",
          text: undefined,
        },
        ctx,
      );
    const sidecar =
      uploaded && "sidecar" in uploaded && uploaded.sidecar !== undefined
        ? getNote(sql, uploaded.sidecar)
        : undefined;
    const ops = syncedOps(JSON.parse(note.fm), seen, sidecar && relationTo(note.path, sidecar.path), now);
    const result = mutate(sql, { op: "patch", noteId: note.id, baseRev: job.rev, ops }, ctx);
    return result.status === "applied" ? undefined : "failed";
  });
}
