// Drift checks, the record's half (docs/product/features/projects-profiles-links.md). A Profile note names one of
// the person's own public profiles; a `drift` job reads it through treg outside the record, and the record writes
// what came back into the note's `synced:` block, as the profiles connector, through the mutation path. The
// detectors in packages/core/src/profiles.ts compare the block with the record. A check costs money, so it runs
// only when the person starts it: once when a profile is added or its link changes, and again when they ask, at
// most once a day for a profile already read.
import {
  isSite,
  ownershipCode,
  paperTitle,
  titleKey,
  type PatchOp,
  type ProfileField,
  type ScholarSays,
  type Site,
  type YamlValue,
} from "@brainiac/core";

import { DAY_MS } from "./hold.ts";
import { enqueue, finishJob } from "./jobs.ts";
import { mutate } from "./mutate.ts";
import { getNote, type NoteRow } from "./notes.ts";
import type { Sql } from "./sql.ts";

/** Who the record says wrote a Profile's `synced:` block. */
export const PROFILES_ACTOR = "connector:profiles";

/** How long a profile's answer stands before asking again reads it again. */
export const CHECK_CACHE_MS = DAY_MS;

/** The most papers one Google Scholar check searches for, one paid search each. */
export const SCHOLAR_PAPERS = 20;

/**
 * What a `drift` job sends out: the link, and for LinkedIn and X the code that shows the profile is the person's.
 * Google Scholar is searched for the record's own paper titles (never a sensitive note's), not for a person.
 */
export type ProfileWork =
  | { readonly site: Exclude<Site, "scholar">; readonly url: string; readonly code: string }
  | {
      readonly site: "scholar";
      readonly url: string;
      readonly papers: readonly { readonly id: string; readonly title: string }[];
    };

/**
 * What the site showed: the profile's fields, Google Scholar's answer per paper, or `unchecked` with why when it
 * couldn't be read (blocked, not found, not set up). An unchecked answer is never filled in from a guess.
 */
export type ProfileSeen =
  | { readonly unchecked: string }
  | { readonly says: Readonly<Partial<Record<ProfileField, string>>> }
  | {
      readonly papers: Readonly<Record<string, { readonly title: string; readonly says: ScholarSays }>>;
    };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface ProfileRow {
  readonly id: string;
  readonly rev: number;
  readonly fm: string;
  /** A drift job pending or out for it. */
  readonly busy: number;
}

const PROFILES = `SELECT id, rev, fm, EXISTS (SELECT 1 FROM jobs WHERE jobs.kind = 'drift' AND jobs.noteId = notes.id
    AND jobs.status != 'failed') AS busy
  FROM notes WHERE type = 'Profile' AND deletedAt IS NULL AND fm ->> '$.site' IN ('linkedin', 'x', 'scholar')
    AND json_type(fm, '$.url') = 'text'`;

/**
 * Profiles never read at their current link, with no drift job of any kind: a failed one waits for the person to
 * ask again, so nothing is fetched in a loop. An edit drops a job for the old revision (jobs.ts), so a new link is
 * read at once.
 */
export function profilesDue(sql: Sql): { readonly id: string; readonly rev: number }[] {
  return sql.all<{ id: string; rev: number }>(
    `SELECT id, rev FROM (${PROFILES}) AS p WHERE (fm ->> '$.synced.url') IS NOT (fm ->> '$.url')
       AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.kind = 'drift' AND jobs.noteId = p.id)`,
  );
}

/** Now, when a profile is due its first read; otherwise null. */
export const nextProfileCheck = (sql: Sql, now: number): number | null =>
  profilesDue(sql).length > 0 ? now : null;

/** The papers a Google Scholar check searches for: live, not sensitive, with a title. */
function scholarPapers(sql: Sql): { id: string; title: string }[] {
  return sql
    .all<{ id: string; fm: string }>(
      "SELECT id, fm FROM notes WHERE type = 'Paper' AND deletedAt IS NULL AND class = 'normal' ORDER BY path",
    )
    .flatMap((paper) => {
      const title = paperTitle(JSON.parse(paper.fm));
      return title === undefined ? [] : [{ id: paper.id, title }];
    })
    .slice(0, SCHOLAR_PAPERS);
}

/**
 * Whether asking again would read the same answer: read at this link less than a day ago, owned (for LinkedIn
 * and X), not unchecked, and for Google Scholar over the same papers. Proving a profile is yours, or a site that
 * was blocked, can be tried again at once; neither is a paid answer worth keeping.
 */
function cached(sql: Sql, data: Readonly<Record<string, unknown>>, now: number): boolean {
  const synced = data["synced"];
  if (!isRecord(synced) || synced["url"] !== data["url"] || synced["unchecked"] !== undefined) return false;
  const checked = Date.parse(String(synced["checked"]));
  if (!(now - checked < CHECK_CACHE_MS)) return false;
  if (data["site"] !== "scholar") return synced["owned"] === true;
  const searched = isRecord(synced["papers"]) ? synced["papers"] : {};
  return scholarPapers(sql).every(({ id, title }) => {
    const found = searched[id];
    return (
      isRecord(found) && typeof found["title"] === "string" && titleKey(found["title"]) === titleKey(title)
    );
  });
}

/**
 * The person asks for their profiles to be checked: each one not cached and not already being read gets a drift
 * job. Says how many are being read and how many answered less than a day ago.
 */
export function requestChecks(sql: Sql, now: number): { readonly checking: number; readonly cached: number } {
  return sql.transaction(() => {
    let checking = 0;
    let fresh = 0;
    for (const profile of sql.all<ProfileRow>(PROFILES)) {
      if (profile.busy) checking++;
      else if (cached(sql, JSON.parse(profile.fm), now)) fresh++;
      else {
        sql.all("DELETE FROM jobs WHERE kind = 'drift' AND noteId = ?", profile.id);
        enqueue(sql, "drift", profile.id, profile.rev);
        checking++;
      }
    }
    return { checking, cached: fresh };
  });
}

/** What a drift job sends out for `note`, or undefined if it no longer names a profile. */
export function profileWork(sql: Sql, note: NoteRow): ProfileWork | undefined {
  const data: Readonly<Record<string, unknown>> = JSON.parse(note.fm);
  const { site, url } = data;
  if (!isSite(site) || typeof url !== "string") return undefined;
  return site === "scholar"
    ? { site, url, papers: scholarPapers(sql) }
    : { site, url, code: ownershipCode(note.id) };
}

/** The block the note gets for `seen`. A profile once shown to be the person's at this link stays theirs. */
function blockOf(
  data: Readonly<Record<string, unknown>>,
  noteId: string,
  seen: ProfileSeen,
  now: number,
): Record<string, YamlValue> {
  const url = String(data["url"]);
  const checked = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
  if (data["site"] === "scholar")
    return "papers" in seen
      ? {
          url,
          papers: Object.fromEntries(Object.entries(seen.papers).map(([id, p]) => [id, { ...p }])),
          checked,
        }
      : { url, unchecked: "unchecked" in seen ? seen.unchecked : "no answer", checked };
  const code = ownershipCode(noteId);
  const old = data["synced"];
  const wasOwned = isRecord(old) && old["url"] === url && old["owned"] === true;
  if (!("says" in seen))
    return {
      url,
      code,
      owned: wasOwned,
      unchecked: "unchecked" in seen ? seen.unchecked : "no answer",
      checked,
    };
  const says = Object.fromEntries(
    Object.entries(seen.says).filter((e): e is [string, string] => e[1] !== undefined),
  );
  const owned = wasOwned || Object.values(says).some((text) => text.includes(code));
  // Nothing from a profile not shown to be theirs is kept: it may be someone else's.
  return owned ? { url, code, owned, says, checked } : { url, code, owned, checked };
}

/**
 * Writes a drift job's answer as the profiles connector, only while the profile is still at the job's revision.
 * A write the record refuses (the person verified the block, so a change needs their passkey) leaves the job
 * failed, and the profile waits until they ask again.
 */
export function installProfile(
  sql: Sql,
  jobId: string,
  seen: ProfileSeen,
  now: number,
): "installed" | "dropped" {
  return finishJob(sql, jobId, (job) => {
    const note = getNote(sql, job.noteId);
    if (!note) return "failed";
    const data: Readonly<Record<string, unknown>> = JSON.parse(note.fm);
    const block = blockOf(data, note.id, seen, now);
    const old = isRecord(data["synced"]) ? Object.keys(data["synced"]) : [];
    const ops: PatchOp[] = [
      ...Object.entries(block).map(([key, value]): PatchOp => ({ op: "set", path: ["synced", key], value })),
      ...old.filter((key) => !(key in block)).map((key): PatchOp => ({ op: "unset", path: ["synced", key] })),
    ];
    const result = mutate(
      sql,
      { op: "patch", noteId: note.id, baseRev: job.rev, ops },
      { actor: PROFILES_ACTOR, now },
    );
    return result.status === "applied" ? undefined : "failed";
  });
}
