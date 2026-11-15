// Papers fill from their DOI (docs/product/features/projects-profiles-links.md). A Paper note with a `doi` gets a
// `synced:` block the DOI connector owns: a `doi` job looks the DOI up outside the record (Crossref for the paper,
// OpenAlex for its citations), the record writes what came back through the mutation path, and the same happens
// again a week later so the citation count stays current. Everything else on the note stays the person's.
import type { PatchOp, YamlValue } from "@brainiac/core";

import { DAY_MS } from "./hold.ts";
import { finishJob } from "./jobs.ts";
import { mutate } from "./mutate.ts";
import { getNote } from "./notes.ts";
import type { Sql } from "./sql.ts";

/** A paper is looked up again this long after its last lookup, and a failed lookup is tried again after it too. */
export const LOOKUP_MS = 7 * DAY_MS;

/** Who the record says wrote a `synced:` block: the connector, never a connection or the person. */
export const DOI_ACTOR = "connector:doi";

/**
 * What a DOI lookup found: the paper as its registry describes it, each part only when the registry has it, or
 * `missing` when no registry knows the DOI (a typo, or not registered yet).
 */
export type Found =
  | {
      readonly title?: string;
      readonly venue?: string;
      /** As precise as the registry is: `2026-03-14`, `2026-03` or `2026`. */
      readonly published?: string;
      /** Every author's name, in the paper's order. */
      readonly authors?: readonly string[];
      readonly citations?: number;
    }
  | "missing";

interface Lookup {
  readonly id: string;
  readonly rev: number;
  /** When it is due: now for a DOI nobody looked up yet, a week after the last lookup otherwise. */
  readonly dueAt: number;
}

/**
 * Every live Paper with a text `doi` and no lookup on its way, with when it is next due. A block filled for another
 * DOI (the person changed it) is due at once. A failed lookup waits a week, like a successful one, so a DOI that
 * keeps failing is never fetched in a loop.
 */
const lookups = (sql: Sql) =>
  sql.all<Lookup>(
    `SELECT id, rev, max(
       CASE WHEN fm ->> '$.synced.doi' IS fm ->> '$.doi'
         THEN coalesce(strftime('%s', fm ->> '$.synced.checked') * 1000, 0) + ? ELSE 0 END,
       coalesce((SELECT max(dispatchedAt) FROM jobs
         WHERE jobs.kind = 'doi' AND jobs.noteId = notes.id AND jobs.status = 'failed'), -?) + ?
     ) AS dueAt
     FROM notes
     WHERE type = 'Paper' AND deletedAt IS NULL AND json_type(fm, '$.doi') = 'text'
       AND NOT EXISTS (SELECT 1 FROM jobs
         WHERE jobs.kind = 'doi' AND jobs.noteId = notes.id AND jobs.status != 'failed')`,
    LOOKUP_MS,
    LOOKUP_MS,
    LOOKUP_MS,
  );

/** The papers to look up now, for the caller to enqueue; any lookup that failed for one of them goes. */
export function papersDue(sql: Sql, now: number): { readonly id: string; readonly rev: number }[] {
  const due = lookups(sql).filter((paper) => paper.dueAt <= now);
  for (const paper of due) sql.all("DELETE FROM jobs WHERE kind = 'doi' AND noteId = ?", paper.id);
  return due;
}

/**
 * When the next paper is due a lookup, or null if none has a DOI. One already due is due `now`: an alarm set in the
 * past (0, for a DOI never looked up) never fires.
 */
export function nextLookup(sql: Sql, now: number): number | null {
  const times = lookups(sql).map((paper) => paper.dueAt);
  return times.length > 0 ? Math.max(now, Math.min(...times)) : null;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The patch that sets the note's `synced:` block to `found`, key by key, so the rest of the note keeps its bytes. */
function syncedOps(data: Readonly<Record<string, unknown>>, found: Found, now: number): PatchOp[] {
  const block: Record<string, YamlValue | undefined> = {
    // As the person wrote it, so the block says which DOI it was filled for even when they change it.
    doi: String(data["doi"]),
    ...(found === "missing" ? { missing: true } : { ...found, authors: found.authors && [...found.authors] }),
    checked: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  const old = isRecord(data["synced"]) ? Object.keys(data["synced"]) : [];
  return [
    ...Object.entries(block)
      .filter((entry): entry is [string, YamlValue] => entry[1] !== undefined)
      .map(([key, value]): PatchOp => ({ op: "set", path: ["synced", key], value })),
    // What the registry no longer says (a venue it dropped, `missing` once the DOI is found) goes.
    ...old
      .filter((key) => block[key] === undefined)
      .map((key): PatchOp => ({ op: "unset", path: ["synced", key] })),
  ];
}

/**
 * Writes a `doi` job's result as the DOI connector, only while the paper is still at the job's revision; an edit in
 * the meantime drops it and the paper is looked up again. A write the record refuses (it would change a value the
 * person verified, which needs their passkey) leaves the job failed, so the lookup waits a week.
 */
export function installLookup(sql: Sql, jobId: string, found: Found, now: number): "installed" | "dropped" {
  return finishJob(sql, jobId, (job) => {
    const note = getNote(sql, job.noteId);
    if (!note) return "failed";
    const ops = syncedOps(JSON.parse(note.fm), found, now);
    const result = mutate(
      sql,
      { op: "patch", noteId: note.id, baseRev: job.rev, ops },
      { actor: DOI_ACTOR, now },
    );
    return result.status === "applied" ? undefined : "failed";
  });
}
