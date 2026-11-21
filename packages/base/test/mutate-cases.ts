// Conformance cases for the mutation path, the jobs outbox and undo; cases.ts runs them on both engines.
import { deepStrictEqual as same, equal, ok } from "node:assert/strict";

import { parseNote, ulid } from "@brainiac/core";

import {
  CHANGES_MS,
  chunkNote,
  dueJobs,
  finishJob,
  getNote,
  jobInput,
  LEASE_MS,
  markDispatched,
  MAX_ATTEMPTS,
  migrate,
  mutate,
  nextWake,
  purge,
  putChunks,
  PERSON,
  planOf,
  search,
  setBilling,
  setPlan,
  TOMBSTONE_MS,
  undoRun,
  type Context,
  type Job,
  type MutationResult,
  type Sql,
} from "../src/index.ts";
import { hitIds, type Case, type Fixture } from "./cases.ts";

const T0 = Date.UTC(2026, 10, 14);
const by = (now = T0, runId?: string): Context => ({ actor: "human", now, ...(runId && { runId }) });

const fixture = (fixtures: readonly Fixture[], path: string) => {
  const found = fixtures.find((f) => f.path === path);
  ok(found, path);
  return found;
};

const applied = (result: MutationResult) => {
  equal(result.status, "applied", JSON.stringify(result));
  ok(result.status === "applied");
  return result;
};

const IELTS = "facts/tests/ielts-2026-11.md";

/** The IELTS note unverified: these cases are about writes and undo, which approvals.ts's cases gate. */
const ieltsRaw = (fixtures: readonly Fixture[]) =>
  fixture(fixtures, IELTS).raw.replace(/^verified:.*\n/m, "");

const undo = (...args: Parameters<typeof undoRun>) => {
  const result = undoRun(...args);
  ok(result.status === "applied", JSON.stringify(result));
  return result;
};
const TUM = "applications/tum-msc-informatics-2027/application.md";

/** A migrated record holding the IELTS note at rev 1, created through the mutation path. */
function withIelts(sql: Sql, fixtures: readonly Fixture[]) {
  migrate(sql);
  const raw = ieltsRaw(fixtures);
  return applied(mutate(sql, { op: "create", path: IELTS, raw, class: "sensitive" }, by()));
}

const rows = (sql: Sql, table: string, noteId: string) =>
  sql.all<Record<string, unknown>>(`SELECT * FROM ${table} WHERE noteId = ? ORDER BY rev`, noteId);
const stored = (sql: Sql, id: string) => {
  const note = getNote(sql, id);
  ok(note, id);
  return note;
};
const jobs = (sql: Sql) => sql.all<Job>("SELECT * FROM jobs ORDER BY id");
const field = (sql: Sql, id: string, key: string) => parseNote(getNote(sql, id)?.raw ?? "").data[key];

export const mutateCases: Record<string, Case> = {
  "each write is one revision with its inverse patch, one change and the next seq": (sql, fixtures) => {
    const created = withIelts(sql, fixtures);
    same([created.rev, created.seq], [1, 1]);
    const patched = applied(
      mutate(
        sql,
        {
          op: "patch",
          noteId: created.noteId,
          baseRev: 1,
          ops: [{ op: "set", path: ["overall"], value: 8.5 }],
        },
        by(T0 + 1),
      ),
    );
    same([patched.rev, patched.seq], [2, 2]);
    const deleted = applied(mutate(sql, { op: "delete", noteId: created.noteId, baseRev: 2 }, by(T0 + 2)));
    same([deleted.rev, deleted.seq], [3, 3]);

    same(
      rows(sql, "changes", created.noteId).map(({ seq, rev, op, actor }) => ({ seq, rev, op, actor })),
      [
        { seq: 1, rev: 1, op: "create", actor: "human" },
        { seq: 2, rev: 2, op: "update", actor: "human" },
        { seq: 3, rev: 3, op: "delete", actor: "human" },
      ],
    );
    const patches = rows(sql, "revisions", created.noteId).map((row) => JSON.parse(String(row["patch"])));
    same(patches[1], { fields: { overall: { before: 8, after: 8.5 } } });
    same(patches[2], { fields: {}, live: { before: true, after: false } });
    equal(getNote(sql, created.noteId)?.deletedAt, T0 + 2);
    // The edit changed only the bytes of that value.
    const raw = rows(sql, "revisions", created.noteId)[1]?.["raw"];
    equal(raw, ieltsRaw(fixtures).replace("overall: 8.0", "overall: 8.5"));
  },

  "a stale baseRev is a conflict and writes nothing": (sql, fixtures) => {
    const { noteId } = withIelts(sql, fixtures);
    const set = { op: "set", path: ["overall"], value: 9 } as const;
    applied(mutate(sql, { op: "patch", noteId, baseRev: 1, ops: [set] }, by()));
    same(mutate(sql, { op: "patch", noteId, baseRev: 1, ops: [set] }, by()), {
      status: "conflict",
      noteId,
      rev: 2,
    });
    same(mutate(sql, { op: "delete", noteId, baseRev: 1 }, by()), { status: "conflict", noteId, rev: 2 });
    equal(rows(sql, "changes", noteId).length, 2);
  },

  "invalid writes are refused and write nothing": (sql, fixtures) => {
    const { noteId } = withIelts(sql, fixtures);
    const { raw } = fixture(fixtures, TUM);
    const statuses = [
      mutate(sql, { op: "create", path: "../escape.md", raw, class: "normal" }, by()),
      mutate(sql, { op: "create", path: "a.md", raw: "---\nid: [\n---\n", class: "normal" }, by()),
      mutate(sql, { op: "create", path: "a.md", raw: "---\nid: not-a-ulid\n---\n", class: "normal" }, by()),
      // Same id as the IELTS note, and a path that differs only by case.
      mutate(sql, { op: "create", path: "x.md", raw: ieltsRaw(fixtures), class: "normal" }, by()),
      mutate(sql, { op: "create", path: IELTS.toUpperCase(), raw, class: "normal" }, by()),
      mutate(sql, { op: "patch", noteId, baseRev: 1, ops: [{ op: "unset", path: ["id"] }] }, by()),
      mutate(sql, { op: "patch", noteId: "01M6ZZZZZZZZZZZZZZZZZZZZZZ", baseRev: 1, ops: [] }, by()),
    ].map((result) => result.status);
    same(statuses, Array(7).fill("invalid"));

    // With a manifest, notes must fit their type.
    sql.all("INSERT INTO schema (version, manifest) VALUES (1, ?)", fixture(fixtures, "okf-base.yaml").raw);
    const result = mutate(
      sql,
      { op: "patch", noteId, baseRev: 1, ops: [{ op: "set", path: ["test"], value: "toeic" }] },
      by(),
    );
    ok(result.status === "invalid" && result.issues[0]?.field === "test", JSON.stringify(result));
    equal(sql.all("SELECT * FROM changes").length, 1);
    equal(getNote(sql, noteId)?.rev, 1);
  },

  "every revision gets an index job, replacing an older pending one": (sql, fixtures) => {
    const { noteId } = withIelts(sql, fixtures);
    same(
      jobs(sql).map(({ kind, rev, status }) => ({ kind, rev, status })),
      [{ kind: "index", rev: 1, status: "pending" }],
    );
    applied(
      mutate(
        sql,
        { op: "patch", noteId, baseRev: 1, ops: [{ op: "set", path: ["overall"], value: 9 }] },
        by(),
      ),
    );
    same(
      jobs(sql).map(({ rev }) => rev),
      [2],
    );
    // A delete drops the note from search at once, rather than through a job.
    putChunks(sql, noteId, 2, chunkNote(stored(sql, noteId)));
    equal(search(sql, PERSON, "computer").hits.length, 1);
    applied(mutate(sql, { op: "delete", noteId, baseRev: 2 }, by()));
    same(hitIds(search(sql, PERSON, "computer")), []);
    same(dueJobs(sql, T0), []);
    same(jobs(sql), []);
  },

  // A crash anywhere between commit and the queue's acknowledgment leaves the job due again.
  "a job not marked dispatched stays due, and a dispatched one is due again after its lease": (
    sql,
    fixtures,
  ) => {
    withIelts(sql, fixtures);
    const [job] = dueJobs(sql, T0);
    ok(job);
    // Crash after sending, before markDispatched: the next alarm sends it again.
    same(
      dueJobs(sql, T0 + 1).map((j) => j.id),
      [job.id],
    );
    markDispatched(sql, [job.id], T0 + 1);
    same(dueJobs(sql, T0 + 1), []);
    equal(nextWake(sql, T0 + 1), T0 + 1 + LEASE_MS);
    // Never acknowledged: due again once the lease runs out.
    same(
      dueJobs(sql, T0 + 1 + LEASE_MS).map((j) => [j.id, j.attempts]),
      [[job.id, 1]],
    );
  },

  "a job that used up its attempts fails instead of running forever": (sql, fixtures) => {
    withIelts(sql, fixtures);
    let now = T0;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const due = dueJobs(sql, now);
      equal(due.length, 1);
      markDispatched(
        sql,
        due.map((j) => j.id),
        now,
      );
      now += LEASE_MS;
    }
    same(dueJobs(sql, now), []);
    same(
      jobs(sql).map(({ status, attempts }) => [status, attempts]),
      [["failed", MAX_ATTEMPTS]],
    );
  },

  "a stale job result for an old rev is dropped": (sql, fixtures) => {
    const { noteId } = withIelts(sql, fixtures);
    const [old] = dueJobs(sql, T0);
    ok(old);
    markDispatched(sql, [old.id], T0);
    const input = jobInput(sql, old.id);
    ok(input && "note" in input);
    equal(input.note.rev, 1);
    // The note moves on while the job runs.
    applied(
      mutate(
        sql,
        {
          op: "patch",
          noteId,
          baseRev: 1,
          ops: [{ op: "section", heading: "Notes", content: "Retook it.\n" }],
        },
        by(),
      ),
    );
    equal(
      finishJob(sql, old.id, () => putChunks(sql, noteId, 1, chunkNote(input.note))),
      "dropped",
    );
    same(hitIds(search(sql, PERSON, "computer")), []);
    // A redelivery of the old job finds nothing to work on.
    equal(jobInput(sql, old.id), undefined);

    const [fresh] = dueJobs(sql, T0);
    ok(fresh);
    const next = jobInput(sql, fresh.id);
    ok(next && "note" in next);
    equal(
      finishJob(sql, fresh.id, (job) => putChunks(sql, noteId, job.rev, chunkNote(next.note))),
      "installed",
    );
    same(hitIds(search(sql, PERSON, "retook")), [noteId]);
    same(jobs(sql), []);
  },

  "undo of a run applies inverse patches and conflicts on fields edited since": (sql, fixtures) => {
    const { noteId } = withIelts(sql, fixtures);
    // An agent's run changes two fields and the body, over two revisions.
    const run = "01M6RUN0000000000000000000";
    applied(
      mutate(
        sql,
        {
          op: "patch",
          noteId,
          baseRev: 1,
          ops: [
            { op: "set", path: ["overall"], value: 9 },
            { op: "set", path: ["expires"], value: "2029-01-01" },
          ],
        },
        by(T0 + 1, run),
      ),
    );
    applied(
      mutate(
        sql,
        {
          op: "patch",
          noteId,
          baseRev: 2,
          ops: [
            { op: "set", path: ["test"], value: "toefl-ibt" },
            { op: "section", heading: "Notes", content: "Agent notes.\n" },
          ],
        },
        by(T0 + 2, run),
      ),
    );
    // Then the person fixes `expires` themselves.
    applied(
      mutate(
        sql,
        { op: "patch", noteId, baseRev: 3, ops: [{ op: "set", path: ["expires"], value: "2028-12-01" }] },
        by(T0 + 3),
      ),
    );

    const result = undo(sql, run, by(T0 + 4));
    same(result.undone, [noteId]);
    // overall, test and the body go back; expires keeps the person's value and becomes a conflict.
    equal(field(sql, noteId, "overall"), 8);
    equal(field(sql, noteId, "test"), "ielts-academic");
    equal(field(sql, noteId, "expires"), "2028-12-01");
    // Every other byte is as the person wrote it; the restored number comes back canonical.
    equal(
      stored(sql, noteId).raw,
      ieltsRaw(fixtures)
        .replace("overall: 8.0", "overall: 8")
        .replace("expires: 2028-11-02", "expires: 2028-12-01"),
    );
    same(
      result.conflicts.map(({ noteId: id, diff }) => [id, diff]),
      [[noteId, { fields: { expires: { before: "2028-12-01", after: "2028-11-02" } } }]],
    );
    same(sql.all("SELECT noteId, kind, status FROM proposals"), [
      { noteId, kind: "conflict", status: "open" },
    ]);
    // The undo is a run of its own, so it can be undone.
    undo(sql, result.runId, by(T0 + 5));
    equal(field(sql, noteId, "overall"), 9);
    equal(field(sql, noteId, "test"), "toefl-ibt");
  },

  "undo of a create deletes it, and undo of a delete restores it": (sql, fixtures) => {
    migrate(sql);
    const created = applied(
      mutate(sql, { op: "create", path: TUM, raw: fixture(fixtures, TUM).raw, class: "normal" }, by(T0)),
    );
    same(undo(sql, created.runId, by(T0 + 1)).undone, [created.noteId]);
    ok(getNote(sql, created.noteId)?.deletedAt !== null);

    const [deletion] = sql.all<{ runId: string }>(
      "SELECT runId FROM revisions WHERE noteId = ? ORDER BY rev DESC",
      created.noteId,
    );
    ok(deletion);
    same(undo(sql, deletion.runId, by(T0 + 2)).undone, [created.noteId]);
    const restored = getNote(sql, created.noteId);
    same([restored?.deletedAt, restored?.raw], [null, fixture(fixtures, TUM).raw]);
    same(
      rows(sql, "changes", created.noteId).map((row) => row["op"]),
      ["create", "delete", "restore"],
    );
  },

  "undo of a create that was edited since is a conflict": (sql, fixtures) => {
    const created = withIelts(sql, fixtures);
    applied(
      mutate(
        sql,
        {
          op: "patch",
          noteId: created.noteId,
          baseRev: 1,
          ops: [{ op: "set", path: ["overall"], value: 9 }],
        },
        by(),
      ),
    );
    const result = undo(sql, created.runId, by());
    same([result.undone, result.conflicts.length], [[], 1]);
    equal(getNote(sql, created.noteId)?.deletedAt, null);
  },

  "tombstones are purged after 30 days with everything derived from them": (sql, fixtures) => {
    const { noteId } = withIelts(sql, fixtures);
    putChunks(sql, noteId, 1, chunkNote(stored(sql, noteId)));
    applied(mutate(sql, { op: "delete", noteId, baseRev: 1 }, by(T0 + 10)));
    equal(nextWake(sql, T0 + 10), T0 + 10 + TOMBSTONE_MS);
    purge(sql, T0 + 10 + TOMBSTONE_MS - 1);
    ok(getNote(sql, noteId));
    purge(sql, T0 + 10 + TOMBSTONE_MS);
    equal(getNote(sql, noteId), undefined);
    same(rows(sql, "revisions", noteId), []);
    same(sql.all("SELECT * FROM chunks"), []);
    // What is left to expire is the feed, a day after its window so busy records wake at most daily for it.
    equal(nextWake(sql, T0 + 10 + TOMBSTONE_MS), T0 + CHANGES_MS + 24 * 60 * 60_000);
    // The feed still says it was deleted, for clients catching up.
    equal(rows(sql, "changes", noteId).length, 2);
  },

  // An edit by someone else between two of the run's revisions is never rolled back with the run.
  "undo keeps an edit made between two revisions of the run": (sql, fixtures) => {
    const { noteId } = withIelts(sql, fixtures);
    const run = "01M6RUN0000000000000000002";
    const set = (baseRev: number, value: number, ctx: Context) =>
      applied(
        mutate(sql, { op: "patch", noteId, baseRev, ops: [{ op: "set", path: ["overall"], value }] }, ctx),
      );
    set(1, 8.5, by(T0 + 1, run));
    set(2, 9, by(T0 + 2));
    set(3, 7, by(T0 + 3, run));
    const result = undo(sql, run, by(T0 + 4));
    equal(field(sql, noteId, "overall"), 9);
    same(
      result.conflicts.map((c) => c.diff),
      [{ fields: { overall: { before: 9, after: 8 } } }],
    );
  },

  "undo reverses a whole run newest first, across notes": (sql, fixtures) => {
    migrate(sql);
    const { raw } = fixture(fixtures, TUM);
    const first = applied(mutate(sql, { op: "create", path: TUM, raw, class: "normal" }, by(T0)));
    // The run replaces the note with a new one at the same path.
    const run = "01M6RUN0000000000000000003";
    applied(mutate(sql, { op: "delete", noteId: first.noteId, baseRev: 1 }, by(T0 + 1, run)));
    const replacement = raw.replace(first.noteId, "01M6ZZZZZZZZZZZZZZZZZZZZZZ");
    const second = applied(
      mutate(sql, { op: "create", path: TUM, raw: replacement, class: "normal" }, by(T0 + 2, run)),
    );
    const result = undo(sql, run, by(T0 + 3));
    same(result.conflicts, []);
    same(
      [getNote(sql, first.noteId)?.deletedAt, getNote(sql, second.noteId)?.deletedAt === null],
      [null, false],
    );
  },

  "undo of an edit to a note deleted since proposes the whole inverse": (sql, fixtures) => {
    const { noteId } = withIelts(sql, fixtures);
    const run = "01M6RUN0000000000000000004";
    applied(
      mutate(
        sql,
        { op: "patch", noteId, baseRev: 1, ops: [{ op: "set", path: ["overall"], value: 9 }] },
        by(T0, run),
      ),
    );
    applied(mutate(sql, { op: "delete", noteId, baseRev: 2 }, by(T0 + 1)));
    const result = undo(sql, run, by(T0 + 2));
    same(result.undone, []);
    same(
      result.conflicts.map((c) => c.diff),
      [{ fields: { overall: { before: 9, after: 8 } } }],
    );
    ok(getNote(sql, noteId)?.deletedAt !== null);
  },

  "an undo that would leave a note failing its type waits for the person": (sql) => {
    migrate(sql);
    sql.all(
      "INSERT INTO schema (version, manifest) VALUES (1, ?)",
      "schema_version: 1\ntypes:\n  A: {version: 1, fields: {}}\n  B: {version: 1, fields: {role: {kind: text, required: true}}}\n",
    );
    const raw = "---\nid: 01M6ZZZZZZZZZZZZZZZZZZZZZZ\ntype: A\n---\n";
    const { noteId } = applied(mutate(sql, { op: "create", path: "a.md", raw, class: "normal" }, by()));
    const run = "01M6RUN0000000000000000005";
    applied(
      mutate(
        sql,
        { op: "patch", noteId, baseRev: 1, ops: [{ op: "set", path: ["role"], value: "referee" }] },
        by(T0, run),
      ),
    );
    // `role` is now what makes the note a valid B.
    applied(
      mutate(
        sql,
        { op: "patch", noteId, baseRev: 2, ops: [{ op: "set", path: ["type"], value: "B" }] },
        by(),
      ),
    );
    const result = undo(sql, run, by());
    same([result.undone, result.conflicts.length], [[], 1]);
    same([field(sql, noteId, "type"), field(sql, noteId, "role")], ["B", "referee"]);
  },

  "deleting a note drops its chunks' vectors too": (sql, fixtures) => {
    const { noteId } = withIelts(sql, fixtures);
    putChunks(sql, noteId, 1, chunkNote(stored(sql, noteId)));
    sql.all("INSERT INTO vectors (chunkId, model, q) SELECT id, 'bge-m3', x'00' FROM chunks");
    applied(mutate(sql, { op: "delete", noteId, baseRev: 1 }, by()));
    same(sql.all("SELECT chunkId FROM vectors"), []);
  },

  "undoing a run from inside it starts a run of its own": (sql, fixtures) => {
    const { noteId } = withIelts(sql, fixtures);
    const run = "01M6RUN0000000000000000006";
    applied(
      mutate(
        sql,
        { op: "patch", noteId, baseRev: 1, ops: [{ op: "set", path: ["overall"], value: 9 }] },
        by(T0, run),
      ),
    );
    const result = undo(sql, run, by(T0 + 1, run));
    ok(result.runId !== run);
    equal(field(sql, noteId, "overall"), 8);
  },

  // The run's last write was undone by hand since: undo must not reach past it to the run's first value.
  "undo never reaches past a field edited since, even back to a value the run wrote": (sql, fixtures) => {
    const { noteId } = withIelts(sql, fixtures);
    const run = "01M6RUN0000000000000000007";
    const set = (baseRev: number, value: number, ctx: Context) =>
      applied(
        mutate(sql, { op: "patch", noteId, baseRev, ops: [{ op: "set", path: ["overall"], value }] }, ctx),
      );
    set(1, 9, by(T0 + 1, run));
    set(2, 7, by(T0 + 2, run));
    set(3, 9, by(T0 + 3));
    const result = undo(sql, run, by(T0 + 4));
    equal(field(sql, noteId, "overall"), 9);
    same(
      result.conflicts.map((c) => c.diff),
      [{ fields: { overall: { before: 9, after: 8 } } }],
    );
  },

  "a field the run edited twice and someone edited since is one conflict, back to the first value": (
    sql,
    fixtures,
  ) => {
    const { noteId } = withIelts(sql, fixtures);
    const run = "01M6RUN0000000000000000008";
    const set = (baseRev: number, value: number, ctx: Context) =>
      applied(
        mutate(sql, { op: "patch", noteId, baseRev, ops: [{ op: "set", path: ["overall"], value }] }, ctx),
      );
    set(1, 8.5, by(T0 + 1, run));
    set(2, 7, by(T0 + 2, run));
    set(3, 9, by(T0 + 3));
    same(
      undo(sql, run, by(T0 + 4)).conflicts.map((c) => c.diff),
      [{ fields: { overall: { before: 9, after: 8 } } }],
    );
  },

  "undoing a run twice changes nothing the second time": (sql, fixtures) => {
    const { noteId } = withIelts(sql, fixtures);
    const run = "01M6RUN0000000000000000009";
    applied(
      mutate(
        sql,
        {
          op: "patch",
          noteId,
          baseRev: 1,
          ops: [{ op: "section", heading: "Notes", content: "Agent notes.\n" }],
        },
        by(T0, run),
      ),
    );
    applied(
      mutate(
        sql,
        { op: "patch", noteId, baseRev: 2, ops: [{ op: "set", path: ["overall"], value: 9 }] },
        by(T0 + 1, run),
      ),
    );
    undo(sql, run, by(T0 + 2));
    const rev = stored(sql, noteId).rev;
    const again = undo(sql, run, by(T0 + 3));
    same([again.undone, again.conflicts], [[], []]);
    equal(stored(sql, noteId).rev, rev);
  },

  "a note the run created and deleted stays gone when its path was taken since": (sql, fixtures) => {
    migrate(sql);
    const { raw } = fixture(fixtures, TUM);
    const run = "01M6RUN000000000000000000A";
    const created = applied(mutate(sql, { op: "create", path: TUM, raw, class: "normal" }, by(T0, run)));
    applied(
      mutate(
        sql,
        {
          op: "patch",
          noteId: created.noteId,
          baseRev: 1,
          ops: [{ op: "set", path: ["status"], value: "submitted" }],
        },
        by(T0 + 1, run),
      ),
    );
    applied(mutate(sql, { op: "delete", noteId: created.noteId, baseRev: 2 }, by(T0 + 1, run)));
    const other = raw.replace(created.noteId, "01M6ZZZZZZZZZZZZZZZZZZZZZZ");
    applied(mutate(sql, { op: "create", path: TUM, raw: other, class: "normal" }, by(T0 + 2)));
    const result = undo(sql, run, by(T0 + 3));
    same([result.undone, result.conflicts], [[], []]);
    ok(getNote(sql, created.noteId)?.deletedAt !== null);
  },

  "a note the run created and edited, deleted since, needs nothing from the person": (sql, fixtures) => {
    migrate(sql);
    const run = "01M6RUN000000000000000000B";
    const raw = ieltsRaw(fixtures);
    const { noteId } = applied(
      mutate(sql, { op: "create", path: IELTS, raw, class: "sensitive" }, by(T0, run)),
    );
    applied(
      mutate(
        sql,
        { op: "patch", noteId, baseRev: 1, ops: [{ op: "set", path: ["overall"], value: 9 }] },
        by(T0 + 1, run),
      ),
    );
    applied(mutate(sql, { op: "delete", noteId, baseRev: 2 }, by(T0 + 2)));
    const result = undo(sql, run, by(T0 + 3));
    same([result.undone, result.conflicts], [[], []]);
  },
  "a free record takes 300 notes once billing is on, and Pro or billing off takes more": (sql) => {
    migrate(sql);
    const note = (i: number) => ({
      op: "create" as const,
      path: `facts/n${i}.md`,
      raw: `---\nid: ${ulid(T0 + i)}\ntitle: Note ${i}\n---\n`,
      class: "normal" as const,
    });
    setBilling(sql, true);
    for (let i = 0; i < 300; i++) applied(mutate(sql, note(i), by()));
    const full = mutate(sql, note(300), by());
    ok(full.status === "invalid" && full.issues[0]?.field === "plan", JSON.stringify(full));
    equal(planOf(sql, T0).notes, 300);

    // Pro from Polar lifts it; an older word from Polar arriving late changes nothing.
    ok(setPlan(sql, { plan: "pro", until: T0 + 30 * 86_400_000, at: T0 + 2 }));
    equal(setPlan(sql, { plan: "free", until: null, at: T0 + 1 }), false);
    applied(mutate(sql, note(300), by()));
    // A Pro period that ended is free again, and turning billing off lifts every limit.
    const lapsed = mutate(sql, note(301), by(T0 + 31 * 86_400_000));
    ok(lapsed.status === "invalid", JSON.stringify(lapsed));
    setBilling(sql, false);
    applied(mutate(sql, note(301), by(T0 + 31 * 86_400_000)));
    equal(planOf(sql, T0).limits, null);
  },
};
