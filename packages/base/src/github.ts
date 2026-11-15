// The GitHub connector's side of the record (docs/product/features/projects-profiles-links.md). The Worker reads
// GitHub (apps/worker/src/connectors/github.ts) and hands the record what it found; this file decides what that
// does, with no I/O. Like every connector (contract §3), it proposes new notes and refreshes only its own
// `synced:` block directly. A repo is known by GitHub's node id (`repo_id`), so a rename changes the block, never
// which note it belongs to.
import { deepEqual, patch, ulid, type YamlValue } from "@brainiac/core";

import type { Connection } from "./connections.ts";
import { mutate, type Context } from "./mutate.ts";
import { freePath, getNote, type NoteRow } from "./notes.ts";
import type { Sql } from "./sql.ts";

/** Who the connector's changes are recorded as. Not a connection: nothing can grant it more. */
export const GITHUB_ACTOR = "connector:github";

/** Proposes at the floor, and sees what it proposes: a private repo's project is sensitive. */
const GITHUB: Connection = {
  id: "github",
  kind: "connector",
  oauthClientId: null,
  level: "propose",
  sensitive: true,
  holdDays: 0,
  rev: 0,
  createdAt: 0,
};

/** One repo as the connector reads it from GitHub. */
export interface Repo {
  /** GitHub's node id (`R_kgDO...`): the same across renames and transfers. */
  readonly id: string;
  /** `owner/name`. */
  readonly name: string;
  readonly url: string;
  readonly private: boolean;
  readonly archived: boolean;
  readonly stars: number;
  readonly language: string | null;
  /** The last push, as a date (`2026-11-14`). */
  readonly pushed: string | null;
}

/** The `synced:` block for a repo: what the connector owns on its project. */
const block = (repo: Repo): Record<string, YamlValue> => ({
  repo_id: repo.id,
  repo: repo.name,
  url: repo.url,
  stars: repo.stars,
  language: repo.language,
  archived: repo.archived,
  private: repo.private,
  pushed: repo.pushed,
});

export interface Synced {
  /** New projects waiting for the person. */
  readonly proposed: number;
  /** Projects whose `synced:` block changed. */
  readonly refreshed: number;
}

/** The live note whose `synced.repo_id` is `repoId`, if any. */
const projectOf = (sql: Sql, repoId: string) =>
  sql.all<NoteRow>(
    "SELECT * FROM notes WHERE deletedAt IS NULL AND json_extract(fm, '$.synced.repo_id') = ? ORDER BY path LIMIT 1",
    repoId,
  )[0];

/**
 * Sets the keys of a project's `synced:` block that differ from `values`, and nothing else, as the connector. A
 * note whose block already says all of it isn't written, so a sweep that finds nothing new changes nothing.
 */
function refresh(sql: Sql, note: NoteRow, values: Readonly<Record<string, YamlValue>>, now: number): boolean {
  const synced: Record<string, unknown> = JSON.parse(note.fm)["synced"] ?? {};
  const ops = Object.entries(values)
    .filter(([key, value]) => !Object.hasOwn(synced, key) || !deepEqual(synced[key], value))
    .map(([key, value]) => ({ op: "set" as const, path: ["synced", key], value }));
  if (ops.length === 0) return false;
  // Not as a connection: refreshing its own block is the one direct write a connector has (contract §3). The
  // approval list still binds, so a value the person verified stays until they approve a change to it.
  const ctx: Context = { actor: GITHUB_ACTOR, now };
  return mutate(sql, { op: "patch", noteId: note.id, baseRev: note.rev, ops }, ctx).status === "applied";
}

/** Proposes a Project note for a repo; a private repo's is sensitive. Returns the proposal's id. */
function proposeProject(sql: Sql, repo: Repo, now: number): string | undefined {
  const id = ulid(now);
  const shortName = repo.name.split("/").pop() ?? repo.name;
  const path = freePath(sql, "Project", shortName, id);
  const raw = patch("", [
    { op: "set", path: ["id"], value: id },
    { op: "set", path: ["type"], value: "Project" },
    { op: "set", path: ["title"], value: shortName },
    { op: "set", path: ["synced"], value: block(repo) },
  ]);
  const result = mutate(
    sql,
    { op: "create", path, raw, class: repo.private ? "sensitive" : "normal" },
    { actor: GITHUB_ACTOR, now, connection: GITHUB },
  );
  return result.status === "proposed" ? result.proposalId : undefined;
}

/**
 * Brings a project's `synced:` block to `values`. A repo that went private while its project is normal isn't
 * written into it, which agents without the sensitive scope could read: the connector proposes making the project
 * sensitive (once), and the block catches up when the person accepts.
 */
function settle(sql: Sql, note: NoteRow, values: Readonly<Record<string, YamlValue>>, now: number): boolean {
  if (values["private"] !== true || note.class !== "normal") return refresh(sql, note, values, now);
  const [waiting] = sql.all(
    "SELECT id FROM proposals WHERE status = 'open' AND actor = ? AND noteId = ?",
    GITHUB_ACTOR,
    note.id,
  );
  if (!waiting)
    mutate(
      sql,
      { op: "classify", noteId: note.id, baseRev: note.rev, class: "sensitive" },
      { actor: GITHUB_ACTOR, now, connection: GITHUB },
    );
  return false;
}

const snapshotOf = (sql: Sql, repoId: string): Record<string, YamlValue> | undefined => {
  const [row] = sql.all<{ snapshot: string }>("SELECT snapshot FROM github_repos WHERE repoId = ?", repoId);
  return row && JSON.parse(row.snapshot);
};

/**
 * What GitHub says about some repos: a repo with a project gets its `synced:` block refreshed; one the connector
 * never proposed gets a proposal. A repo proposed before and since rejected, or whose project was deleted, is left
 * alone: the person said no. Every repo's latest block is kept, for a project accepted later (`caughtUp`).
 */
export function syncRepos(sql: Sql, repos: readonly Repo[], now: number): Synced {
  let proposed = 0;
  let refreshed = 0;
  for (const repo of repos) {
    const values = block(repo);
    const known = snapshotOf(sql, repo.id) !== undefined;
    if (known)
      sql.all("UPDATE github_repos SET snapshot = ? WHERE repoId = ?", JSON.stringify(values), repo.id);
    const note = projectOf(sql, repo.id);
    if (note) {
      if (settle(sql, note, values, now)) refreshed++;
      continue;
    }
    if (known) continue;
    sql.transaction(() => {
      const proposalId = proposeProject(sql, repo, now);
      if (proposalId === undefined) return;
      sql.all(
        "INSERT INTO github_repos (repoId, proposalId, snapshot) VALUES (?, ?, ?)",
        repo.id,
        proposalId,
        JSON.stringify(values),
      );
      proposed++;
    });
  }
  return { proposed, refreshed };
}

/** A repo deleted on GitHub: its project keeps its last snapshot, marked archived. */
export function repoDeleted(sql: Sql, repoId: string, now: number): boolean {
  // The whole latest block, so a repo that went private before it was deleted still meets settle's privacy check.
  const values = { ...snapshotOf(sql, repoId), archived: true };
  sql.all("UPDATE github_repos SET snapshot = ? WHERE repoId = ?", JSON.stringify(values), repoId);
  const note = projectOf(sql, repoId);
  return note !== undefined && settle(sql, note, values, now);
}

/**
 * After the person accepts a proposal on `noteId`: a project brings its `synced:` block up to what GitHub said
 * last, which may have changed while the proposal waited (a sweep that then finds nothing new won't say it again).
 */
export function caughtUp(sql: Sql, noteId: string, now: number): void {
  const note = getNote(sql, noteId);
  const repoId: unknown =
    note && note.deletedAt === null ? JSON.parse(note.fm)["synced"]?.repo_id : undefined;
  const snapshot = typeof repoId === "string" ? snapshotOf(sql, repoId) : undefined;
  if (note && snapshot) settle(sql, note, snapshot, now);
}
