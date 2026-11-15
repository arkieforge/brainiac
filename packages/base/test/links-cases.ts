// Conformance cases for saved links, the record's half: a link is read once when it's saved (with its text and a
// snapshot), checked again weekly for being there, its `synced:` block written as the connector, and nothing loops.
// cases.ts runs them on both engines.
import { deepStrictEqual as same, equal, ok } from "node:assert/strict";

import { detect, parseNote } from "@brainiac/core";

import {
  dataKey,
  dueJobs,
  getFile,
  getNote,
  HEALTH_MS,
  installLink,
  jobInput,
  linkWork,
  LINKS_ACTOR,
  manifestOf,
  markDispatched,
  migrate,
  mutate,
  nextWake,
  sealFile,
  type Context,
  type Sql,
} from "../src/index.ts";
import type { Case, Fixture } from "./cases.ts";

const T0 = Date.UTC(2026, 10, 15);
const APPLICATION = "applications/tum-msc-informatics-2027/application.md";
const LINK = "links/daad-scholarship-database.md";
const URL = "https://example.org/scholarships/daad";
const human = (now = T0): Context => ({ actor: "human", now });
const iso = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");

function record(sql: Sql, fixtures: readonly Fixture[], linkClass: "normal" | "sensitive" = "normal") {
  migrate(sql);
  const manifest = fixtures.find((f) => f.path === "okf-base.yaml");
  const application = fixtures.find((f) => f.path === APPLICATION);
  ok(manifest && application);
  sql.all("INSERT INTO schema (version, manifest) VALUES (1, ?)", manifest.raw);
  ok(mutate(sql, { op: "create", path: APPLICATION, raw: application.raw, class: "normal" }, human()).status);
  const raw = [
    "---",
    "id: 01M6AM78G0STS7TB29G7A10KNK",
    "type: Link",
    "title: DAAD scholarship database",
    `url: ${URL}`,
    "for: ../applications/tum-msc-informatics-2027/application.md",
    "---",
    "",
  ].join("\n");
  const created = mutate(sql, { op: "create", path: LINK, raw, class: linkClass }, human());
  ok(created.status === "applied", JSON.stringify(created));
  return created.noteId;
}

const links = (sql: Sql, now: number) => dueJobs(sql, now).filter((j) => j.kind === "link");

/** The link's check due at `now`, dispatched, as the consumer gets it. */
function check(sql: Sql, id: string, now: number) {
  const job = links(sql, now).find((j) => j.noteId === id);
  ok(job, "no link job");
  markDispatched(sql, [job.id], now);
  const input = jobInput(sql, job.id);
  ok(input && "note" in input);
  return { id: job.id, work: linkWork(input.note) };
}

const synced = (sql: Sql, id: string) => parseNote(getNote(sql, id)?.raw ?? "").data["synced"];
const key = (sql: Sql) => dataKey(sql, { current: "the stage's vault key", previous: undefined });
const PDF = new TextEncoder().encode("%PDF-1.7\nDAAD scholarship database, as saved\n%%EOF\n");

export const linksCases: Record<string, Case> = {
  "a saved link is read once with its text and a snapshot, then only checked for being there, weekly": (
    sql,
    fixtures,
  ) => {
    const link = record(sql, fixtures);
    // Saved: due now, and the record wakes for it.
    equal(nextWake(sql, T0 + 5), T0 + 5);
    const first = check(sql, link, T0);
    // Only the address leaves the record, and the first read takes the text and a snapshot.
    same(first.work, { url: URL, capture: true, extract: true });
    same(links(sql, T0), []);

    const { sha256 } = sealFile(key(sql), PDF);
    const snapshot = { sha256, r2Key: `blobs/test/${sha256}`, bytes: PDF.byteLength, key: key(sql) };
    const text = `Find a scholarship. ${"Funding for international students. ".repeat(40)}`;
    equal(installLink(sql, first.id, { status: "live", title: "DAAD", text }, snapshot, T0), "installed");
    const block = synced(sql, link);
    ok(block && typeof block === "object" && !Array.isArray(block));
    // The snapshot is in the vault like any upload, sensitive and unclassified until the person says what it is,
    // and the link names its sidecar note.
    const file = getFile(sql, sha256);
    equal(file?.class, "unclassified");
    equal(file?.kind, null);
    ok(file?.path);
    const sidecar = sql.all<{ id: string; path: string; class: string }>(
      "SELECT id, path, class FROM notes WHERE type = 'Document'",
    )[0];
    ok(sidecar);
    equal(sidecar.class, "sensitive");
    same(block, {
      url: URL,
      status: "live",
      title: "DAAD",
      excerpt: `${text.slice(0, 499).trimEnd()}…`,
      snapshot: `../${sidecar.path}`,
      checked: iso(T0),
    });
    equal(
      sql.all<{ actor: string }>(
        "SELECT actor FROM revisions WHERE noteId = ? ORDER BY rev DESC LIMIT 1",
        link,
      )[0]?.actor,
      LINKS_ACTOR,
    );

    // Nothing is due until a week after the check; then it is only checked, never captured or extracted again.
    same(links(sql, T0 + HEALTH_MS - 1), []);
    // The snapshot has its own job, the vault's extraction, due now, like every note's index job; without them the
    // record next wakes for the link.
    ok(dueJobs(sql, T0 + 1).some((j) => j.kind === "file"));
    sql.all("DELETE FROM jobs");
    equal(nextWake(sql, T0 + 1), T0 + HEALTH_MS);
    const weekly = check(sql, link, T0 + HEALTH_MS);
    same(weekly.work, { url: URL, capture: false, extract: false });
    equal(installLink(sql, weekly.id, { status: "dead", code: 404 }, undefined, T0 + HEALTH_MS), "installed");
    // What the first read took stays, as evidence of what the page said.
    same(synced(sql, link), {
      url: URL,
      status: "dead",
      code: 404,
      title: "DAAD",
      excerpt: `${text.slice(0, 499).trimEnd()}…`,
      snapshot: `../${sidecar.path}`,
      checked: iso(T0 + HEALTH_MS),
    });
    // The application relies on it, so the dead link is a flag on the record.
    const notes = sql
      .all<{ id: string; path: string; fm: string }>("SELECT id, path, fm FROM notes WHERE deletedAt IS NULL")
      .map((n) => ({ id: n.id, path: n.path, data: JSON.parse(n.fm) }));
    same(
      detect(notes, manifestOf(sql) ?? null, T0 + HEALTH_MS)
        .filter((c) => c.detector === "dead")
        .map((c) => [c.noteId, c.evidence]),
      [[link, "Gone (404) when checked 2026-11-22, and TUM MSc Informatics, Winter 2027 relies on it"]],
    );

    // Back the next week: the code goes, and the block says live again.
    const again = check(sql, link, T0 + 2 * HEALTH_MS);
    equal(installLink(sql, again.id, { status: "live" }, undefined, T0 + 2 * HEALTH_MS), "installed");
    same(synced(sql, link), {
      url: URL,
      status: "live",
      title: "DAAD",
      excerpt: `${text.slice(0, 499).trimEnd()}…`,
      snapshot: `../${sidecar.path}`,
      checked: iso(T0 + 2 * HEALTH_MS),
    });
  },

  "a new address is read again at once, a stale answer is dropped, and a sensitive link never goes to treg": (
    sql,
    fixtures,
  ) => {
    const link = record(sql, fixtures, "sensitive");
    const first = check(sql, link, T0);
    same(first.work, { url: URL, capture: true, extract: false });
    equal(installLink(sql, first.id, { status: "live" }, undefined, T0), "installed");

    // The person moves the link while a check is out: its answer is for the old address, and is dropped.
    const out = check(sql, link, T0 + HEALTH_MS);
    const moved = "https://example.org/scholarships/daad-2027";
    const rev = getNote(sql, link)?.rev ?? 0;
    const edited = mutate(
      sql,
      { op: "patch", noteId: link, baseRev: rev, ops: [{ op: "set", path: ["url"], value: moved }] },
      human(T0 + HEALTH_MS + 1),
    );
    equal(edited.status, "applied");
    equal(installLink(sql, out.id, { status: "dead", code: 410 }, undefined, T0 + HEALTH_MS + 2), "dropped");
    // The new address is due at once, as a first read.
    const fresh = check(sql, link, T0 + HEALTH_MS + 3);
    same(fresh.work, { url: moved, capture: true, extract: false });
  },

  "a check that keeps failing waits a week, never fetched in a loop": (sql, fixtures) => {
    const link = record(sql, fixtures);
    const job = check(sql, link, T0);
    sql.all("UPDATE jobs SET status = 'failed' WHERE id = ?", job.id);
    same(links(sql, T0 + 1), []);
    same(links(sql, T0 + HEALTH_MS - 1), []);
    equal(links(sql, T0 + HEALTH_MS).length, 1);
  },
};
