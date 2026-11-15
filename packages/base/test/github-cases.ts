// Conformance cases for the GitHub connector's side of the record (github.ts): what a repo GitHub describes does
// to projects and proposals. cases.ts runs them on both engines; apps/worker/test/github.test.ts covers GitHub.
import { deepStrictEqual as same, equal, ok } from "node:assert/strict";

import { patch, splitNote } from "@brainiac/core";

import {
  canSee,
  currentSeq,
  decide,
  getNote,
  GITHUB_ACTOR,
  listNotes,
  migrate,
  mutate,
  repoDeleted,
  syncRepos,
  type Repo,
  type Sql,
} from "../src/index.ts";
import type { Case, Fixture } from "./cases.ts";

const T0 = Date.UTC(2026, 10, 15);
const person = (now = T0) => ({ actor: "human", now });

// The fixture student's repos (fictional).
const SEATS: Repo = {
  id: "R_kgDOJxSeats",
  name: "nadia-karim/library-seat-finder",
  url: "https://github.com/nadia-karim/library-seat-finder",
  private: false,
  archived: false,
  stars: 214,
  language: "TypeScript",
  pushed: "2026-11-14",
};
const THESIS: Repo = {
  id: "R_kgDOJxThesis",
  name: "nadia-karim/thesis-notes",
  url: "https://github.com/nadia-karim/thesis-notes",
  private: true,
  archived: false,
  stars: 0,
  language: null,
  pushed: "2026-10-02",
};

/** The record with the fixture manifest, which declares no Project type: the built-in one applies. */
function withManifest(sql: Sql, fixtures: readonly Fixture[]) {
  migrate(sql);
  const manifest = fixtures.find((f) => f.path === "okf-base.yaml");
  if (!manifest) throw new Error("no okf-base.yaml in fixtures");
  sql.all("INSERT INTO schema (version, manifest) VALUES (1, ?)", manifest.raw);
}

const openProposals = (sql: Sql) =>
  sql.all<{ id: string; actor: string; patch: string }>(
    "SELECT id, actor, patch FROM proposals WHERE status = 'open' ORDER BY json_extract(patch, '$[0].path')",
  );

/** Accepts every open proposal as the person; returns the notes they made. */
function acceptAll(sql: Sql, now = T0) {
  for (const proposal of openProposals(sql)) {
    const result = decide(sql, proposal.id, "accept", person(now));
    equal(result.status, "applied", JSON.stringify(result));
  }
  return listNotes(sql, { type: "Project" });
}

/** The front-matter, line by line. */
const lines = (text: string) => splitNote(text).yaml.split("\n");

const synced = (sql: Sql, noteId: string) => JSON.parse(getNote(sql, noteId)?.fm ?? "{}")["synced"];

export const githubCases: Record<string, Case> = {
  "a new repo is proposed once, never written, and a private repo's project is sensitive": (
    sql,
    fixtures,
  ) => {
    withManifest(sql, fixtures);
    same(syncRepos(sql, [SEATS, THESIS], T0), { proposed: 2, refreshed: 0 });
    // Proposals only: nothing is in the record until the person accepts.
    same(listNotes(sql), []);
    const proposals = openProposals(sql);
    same(
      proposals.map((p) => [p.actor, JSON.parse(p.patch)[0].path, JSON.parse(p.patch)[0].class]),
      [
        [GITHUB_ACTOR, "facts/projects/library-seat-finder.md", "normal"],
        [GITHUB_ACTOR, "facts/projects/thesis-notes.md", "sensitive"],
      ],
    );
    // The next sweep sees the same repos and proposes nothing more.
    same(syncRepos(sql, [SEATS, THESIS], T0 + 1), { proposed: 0, refreshed: 0 });
    equal(openProposals(sql).length, 2);

    const [seats, thesis] = acceptAll(sql);
    ok(seats && thesis);
    equal(seats.class, "normal");
    equal(thesis.class, "sensitive");
    // A connection without the sensitive scope never sees the private repo's project.
    ok(canSee({ ...agentConnection }, seats));
    ok(!canSee({ ...agentConnection }, thesis));
    same(synced(sql, seats.id), {
      repo_id: SEATS.id,
      repo: SEATS.name,
      url: SEATS.url,
      stars: 214,
      language: "TypeScript",
      archived: false,
      private: false,
      pushed: "2026-11-14",
    });
    // Nothing new: nothing written.
    const seq = currentSeq(sql);
    same(syncRepos(sql, [SEATS, THESIS], T0 + 2), { proposed: 0, refreshed: 0 });
    equal(currentSeq(sql), seq);
  },

  "the connector refreshes only its synced block, found by repo_id across a rename": (sql, fixtures) => {
    withManifest(sql, fixtures);
    syncRepos(sql, [SEATS], T0);
    const [project] = acceptAll(sql);
    ok(project);
    // The person writes their own fields, with a comment of their own.
    const raw = patch(project.raw, [
      { op: "set", path: ["role"], value: "Lead developer (team of 3)" },
      { op: "set", path: ["summary"], value: "Cut time spent looking for a seat from 14 to 6 minutes." },
    ]).replace("title:", "# named by me\ntitle:");
    const edited = mutate(sql, { op: "put", noteId: project.id, baseRev: project.rev, raw }, person());
    equal(edited.status, "applied");
    const before = getNote(sql, project.id);
    ok(before);

    const renamed = {
      ...SEATS,
      name: "nadia-karim/seat-finder",
      url: "https://github.com/nadia-karim/seat-finder",
      stars: 230,
    };
    same(syncRepos(sql, [renamed], T0 + 1), { proposed: 0, refreshed: 1 });
    const after = getNote(sql, project.id);
    ok(after);
    // Same note, same path; the person's text, comment and fields untouched; only the block moved.
    equal(after.path, before.path);
    same(
      lines(after.raw).filter((line) => !line.startsWith("synced:")),
      lines(before.raw).filter((line) => !line.startsWith("synced:")),
    );
    equal(splitNote(after.raw).body, splitNote(before.raw).body);
    same([synced(sql, project.id).repo, synced(sql, project.id).stars], ["nadia-karim/seat-finder", 230]);
    // Recorded as the connector, not the person.
    same(sql.all("SELECT actor FROM revisions WHERE noteId = ? ORDER BY rev DESC LIMIT 1", project.id), [
      { actor: GITHUB_ACTOR },
    ]);
  },

  "a rejected proposal, or a deleted project, is never proposed again": (sql, fixtures) => {
    withManifest(sql, fixtures);
    syncRepos(sql, [SEATS, THESIS], T0);
    const [seatsProposal, thesisProposal] = openProposals(sql);
    ok(seatsProposal && thesisProposal);
    equal(decide(sql, thesisProposal.id, "reject", person()).status, "rejected");
    equal(decide(sql, seatsProposal.id, "accept", person()).status, "applied");
    const [project] = listNotes(sql, { type: "Project" });
    ok(project);
    equal(
      mutate(sql, { op: "delete", noteId: project.id, baseRev: project.rev }, person()).status,
      "applied",
    );
    same(syncRepos(sql, [{ ...SEATS, stars: 300 }, THESIS], T0 + 1), { proposed: 0, refreshed: 0 });
    same(openProposals(sql), []);
    same(listNotes(sql, { type: "Project" }), []);
  },

  "a deleted repo keeps its project's snapshot, marked archived": (sql, fixtures) => {
    withManifest(sql, fixtures);
    syncRepos(sql, [SEATS], T0);
    const [project] = acceptAll(sql);
    ok(project);
    ok(repoDeleted(sql, SEATS.id, T0 + 1));
    same(synced(sql, project.id), { ...synced(sql, project.id), archived: true, stars: 214 });
    equal(getNote(sql, project.id)?.deletedAt, null);
    // A repo the record never had a project for changes nothing.
    equal(repoDeleted(sql, "R_kgDOJxUnknown", T0 + 2), false);
  },

  "a project accepted after its repo changed catches up, even if no sweep says so again": (sql, fixtures) => {
    withManifest(sql, fixtures);
    syncRepos(sql, [SEATS], T0);
    // While the proposal waits: renamed and starred, then deleted.
    syncRepos(sql, [{ ...SEATS, name: "nadia-karim/seat-finder", stars: 230 }], T0 + 1);
    repoDeleted(sql, SEATS.id, T0 + 2);
    equal(openProposals(sql).length, 1);
    const [project] = acceptAll(sql, T0 + 3);
    ok(project);
    same(
      [synced(sql, project.id).repo, synced(sql, project.id).stars, synced(sql, project.id).archived],
      ["nadia-karim/seat-finder", 230, true],
    );
  },

  "a repo made private keeps its normal project's block until the person makes the project sensitive": (
    sql,
    fixtures,
  ) => {
    withManifest(sql, fixtures);
    syncRepos(sql, [SEATS], T0);
    const [project] = acceptAll(sql);
    ok(project);
    const hidden = { ...SEATS, private: true, stars: 215 };
    same(syncRepos(sql, [hidden], T0 + 1), { proposed: 0, refreshed: 0 });
    // Nothing new reaches a note agents without the sensitive scope can read; one proposal, however many sweeps.
    same([synced(sql, project.id).private, synced(sql, project.id).stars], [false, 214]);
    syncRepos(sql, [hidden], T0 + 2);
    // Deleted after it went private: still nothing written into the normal note.
    equal(repoDeleted(sql, SEATS.id, T0 + 2), false);
    equal(synced(sql, project.id).archived, false);
    const proposals = openProposals(sql);
    equal(proposals.length, 1);
    same(JSON.parse(proposals[0]?.patch ?? "[]")[0].class, "sensitive");
    acceptAll(sql, T0 + 3);
    equal(getNote(sql, project.id)?.class, "sensitive");
    same(
      [synced(sql, project.id).private, synced(sql, project.id).stars, synced(sql, project.id).archived],
      [true, 215, true],
    );
  },

  "a project is a held type: a write connection's edit to it waits out the hold": (sql, fixtures) => {
    withManifest(sql, fixtures);
    syncRepos(sql, [SEATS], T0);
    const [project] = acceptAll(sql);
    ok(project);
    const writer = { ...agentConnection, level: "write" } as const;
    const result = mutate(
      sql,
      {
        op: "patch",
        noteId: project.id,
        baseRev: project.rev,
        ops: [{ op: "set", path: ["title"], value: "Seat finder" }],
      },
      { actor: "connection:agent", now: T0 + 1, connection: writer },
    );
    equal(result.status, "proposed");
    ok("autoApplyAt" in result && result.autoApplyAt === T0 + 1 + 3 * 24 * 60 * 60_000);
  },

  "two repos with the same name are proposed at different paths": (sql, fixtures) => {
    withManifest(sql, fixtures);
    const fork = { ...SEATS, id: "R_kgDOJxFork", name: "seat-team/library-seat-finder" };
    syncRepos(sql, [SEATS, fork], T0);
    const paths = openProposals(sql).map((p) => JSON.parse(p.patch)[0].path);
    equal(new Set(paths).size, 2);
    equal(acceptAll(sql).length, 2);
  },
};

/** A connection as every one starts: no sensitive scope. */
const agentConnection = {
  id: "agent",
  kind: "cli",
  oauthClientId: null,
  level: "propose",
  sensitive: false,
  holdDays: 3,
  rev: 0,
  createdAt: T0,
} as const;
