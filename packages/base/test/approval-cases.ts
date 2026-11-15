// Conformance cases for approvals (contract §4): what needs one, how one is used, and a property test that no
// sequence of changes without one moves a verified value. cases.ts runs them on both engines. The passkey
// signature itself is checked in the DO (apps/worker/test/approvals.test.ts); here a `Signature` stands for
// one the DO has already checked.
import { deepStrictEqual as same, equal, ok } from "node:assert/strict";

import {
  findClash,
  parseNote,
  resolveRelation,
  ulid,
  type ClientMessage,
  type PatchOp,
  type YamlValue,
} from "@brainiac/core";
import fc from "fast-check";

import {
  currentSeq,
  getNote,
  migrate,
  mutate,
  openReview,
  PERSON,
  planHash,
  recordApproval,
  REVIEW_MS,
  serve,
  startReview,
  undoRun,
  type Context,
  type Mutation,
  type MutationResult,
  type NeedsApproval,
  type Signature,
  type Sql,
} from "../src/index.ts";
import type { Case, Fixture } from "./cases.ts";

const T0 = Date.UTC(2026, 10, 15);
const IELTS = "facts/tests/ielts-2026-11.md";
const TUM = "applications/tum-msc-informatics-2027/application.md";

const raw = (fixtures: readonly Fixture[], path: string) => {
  const found = fixtures.find((f) => f.path === path);
  ok(found, path);
  return found.raw;
};

let signatures = 0;
/** A signature the DO has checked; each one a new use of the passkey. */
const signed = (): Signature => ({
  credentialId: "passkey-1",
  counter: ++signatures,
  assertion: `{"n":${signatures}}`,
});

const held = (result: MutationResult | ReturnType<typeof undoRun>): NeedsApproval => {
  equal(result.status, "needsApproval", JSON.stringify(result));
  ok(result.status === "needsApproval");
  return result;
};

const applied = (result: MutationResult) => {
  equal(result.status, "applied", JSON.stringify(result));
  ok(result.status === "applied");
  return result;
};

/** Signs and records what a held change asks for, as the site does after a `needsApproval`. */
function approve(sql: Sql, verdict: NeedsApproval, now = T0): string {
  same(verdict.planHash, planHash(verdict.items));
  const approved = recordApproval(sql, verdict.items, signed(), now);
  ok("approvalId" in approved, JSON.stringify(approved));
  return approved.approvalId;
}

/** Runs a change that needs an approval: held first, then approved and run again with the approval. */
function withApproval(sql: Sql, mutation: Mutation, ctx: Context) {
  const approvalId = approve(sql, held(mutate(sql, mutation, ctx)), ctx.now);
  return applied(mutate(sql, mutation, { ...ctx, approvalId }));
}

const human = (now = T0): Context => ({ actor: "human", now });
const agent = (now = T0): Context => ({ actor: "connection:agent", now });

/** A record holding the verified IELTS note (approved at creation) and the unverified TUM application. */
function record(sql: Sql, fixtures: readonly Fixture[]) {
  migrate(sql);
  const ielts = withApproval(
    sql,
    { op: "create", path: IELTS, raw: raw(fixtures, IELTS), class: "sensitive" },
    human(),
  );
  const tum = applied(
    mutate(sql, { op: "create", path: TUM, raw: raw(fixtures, TUM), class: "normal" }, human()),
  );
  return { ielts: ielts.noteId, tum: tum.noteId };
}

const set = (field: string, value: YamlValue): PatchOp => ({ op: "set", path: [field], value });
const unset = (field: string): PatchOp => ({ op: "unset", path: [field] });
const patchOf = (sql: Sql, noteId: string, ops: readonly PatchOp[]): Mutation => ({
  op: "patch",
  noteId,
  baseRev: getNote(sql, noteId)?.rev ?? 0,
  ops,
});

/** Nothing a held change did is left: no change, revision, proposal or used approval. */
function untouched(sql: Sql, run: () => MutationResult | ReturnType<typeof undoRun>) {
  const count = (table: string) => sql.all<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)[0]?.n;
  const used = () => sql.all("SELECT id FROM approvals WHERE usedAt IS NOT NULL");
  const before = [currentSeq(sql), count("revisions"), count("proposals"), count("jobs"), used()];
  const verdict = held(run());
  same([currentSeq(sql), count("revisions"), count("proposals"), count("jobs"), used()], before);
  return verdict;
}

/**
 * Every live note's verification and the values it covers, plus its path and type, and which live notes
 * supersede a verified one.
 */
function verifiedSet(sql: Sql) {
  const notes = sql.all<{ id: string; path: string; fm: string }>(
    "SELECT id, path, fm FROM notes WHERE deletedAt IS NULL ORDER BY id",
  );
  const checked = notes.filter(({ fm }) => Object.hasOwn(JSON.parse(fm), "verified"));
  const paths = checked.map((note) => note.path);
  const supersede = notes.flatMap(({ id, path, fm }) => {
    const target: unknown = JSON.parse(fm)["supersedes"];
    if (typeof target !== "string") return [];
    try {
      // Matched as the record matches paths, whatever their case.
      return findClash(paths, resolveRelation(path, target)) === undefined ? [] : [[id, target]];
    } catch {
      return [];
    }
  });
  return {
    supersede,
    notes: checked.map(({ id, path, fm }) => {
      const data: Record<string, unknown> = JSON.parse(fm);
      const verified = data["verified"] as { fields?: string[] };
      return {
        id,
        path,
        type: data["type"],
        verified,
        values: Array.isArray(verified.fields) ? verified.fields.map((field) => data[field]) : [],
      };
    }),
  };
}

/** A new IELTS note that supersedes the one at `supersedes`, relative to facts/tests/. */
const superseding = (supersedes: string) =>
  [
    "---",
    `id: ${ulid(T0)}`,
    "type: TestScore",
    "test: ielts-academic",
    "overall: 9",
    `supersedes: ${supersedes}`,
    "---",
    "",
  ].join("\n");

/** A note with a field literally named `exam.score` and a mapping `exam` with a `score`. */
const dotted = (fields: string) =>
  [
    "---",
    `id: ${ulid(T0)}`,
    "exam.score: 8",
    "exam: {score: 8}",
    `verified: {by: human, fields: [${fields}]}`,
    "---",
    "",
  ].join("\n");

export const approvalCases: Record<string, Case> = {
  "a change that sets verification is held, and lands with an approval for its exact plan": (
    sql,
    fixtures,
  ) => {
    migrate(sql);
    const create: Mutation = { op: "create", path: IELTS, raw: raw(fixtures, IELTS), class: "sensitive" };
    const verdict = untouched(sql, () => mutate(sql, create, human()));
    // The plan names the note, the revision it starts from and its whole effect.
    const id = String(parseNote(raw(fixtures, IELTS)).data["id"]);
    same(
      verdict.items.map(({ noteId, baseRev, path, patch }) => [noteId, baseRev, path, patch.live]),
      [[id, 0, IELTS, { before: false, after: true }]],
    );
    // The human on the site is held too: only a passkey approves.
    const approvalId = approve(sql, verdict);
    const created = applied(mutate(sql, create, { ...human(), approvalId }));
    same(sql.all("SELECT planHash, usedAt FROM approvals WHERE id = ?", approvalId), [
      { planHash: verdict.planHash, usedAt: T0 },
    ]);
    equal(getNote(sql, created.noteId)?.rev, 1);
  },

  "an approval is used once, and only for the plan it signed": (sql, fixtures) => {
    const { ielts } = record(sql, fixtures);
    const first = patchOf(sql, ielts, [set("overall", 8.5)]);
    const approvalId = approve(sql, held(mutate(sql, first, agent())));
    // Another change to the same note, with the same approval: held.
    untouched(sql, () => mutate(sql, patchOf(sql, ielts, [set("overall", 9)]), { ...agent(), approvalId }));
    applied(mutate(sql, first, { ...agent(), approvalId }));
    // The same change again (it is a no-op now) and a new one: the approval is spent.
    untouched(sql, () => mutate(sql, patchOf(sql, ielts, [set("overall", 8)]), { ...agent(), approvalId }));
    // Approving a plan again before it is used (the first answer was lost) gives back the same approval;
    // once used, it is refused. A passkey counter that doesn't move is a replayed signature.
    const again = held(mutate(sql, patchOf(sql, ielts, [set("overall", 8)]), agent())).items;
    const lost = recordApproval(sql, again, signed(), T0);
    same(recordApproval(sql, again, signed(), T0), lost);
    ok("approvalId" in lost);
    applied(
      mutate(sql, patchOf(sql, ielts, [set("overall", 8)]), { ...agent(), approvalId: lost.approvalId }),
    );
    same(recordApproval(sql, again, signed(), T0), { error: "This plan was already applied." });
    const other = held(mutate(sql, patchOf(sql, ielts, [set("overall", 7)]), agent())).items;
    same(recordApproval(sql, other, { ...signed(), counter: 1 }, T0), {
      error: "This passkey signature was already used.",
    });
  },

  "edits to what isn't verified pass; verified values, the verification, the type and deleting are held": (
    sql,
    fixtures,
  ) => {
    const { ielts } = record(sql, fixtures);
    applied(mutate(sql, patchOf(sql, ielts, [set("expires", "2028-12-01"), set("title", "IELTS")]), agent()));
    applied(
      mutate(sql, patchOf(sql, ielts, [{ op: "section", heading: "Notes", content: "Retook.\n" }]), agent()),
    );
    for (const ops of [
      [set("overall", 8.5)],
      [{ op: "set", path: ["sections", "writing"], value: 7.5 } as const],
      [unset("sections")],
      [set("verified", { by: "agent", fields: ["overall"] })],
      [{ op: "append", path: ["verified", "fields"], value: "date" } as const],
      [set("type", "Award")],
    ]) {
      untouched(sql, () => mutate(sql, patchOf(sql, ielts, ops), agent()));
    }
    untouched(sql, () =>
      mutate(sql, { op: "delete", noteId: ielts, baseRev: getNote(sql, ielts)?.rev ?? 0 }, human()),
    );
  },

  "clearing the verification first is held, alone or with the edit": (sql, fixtures) => {
    const { ielts } = record(sql, fixtures);
    untouched(sql, () => mutate(sql, patchOf(sql, ielts, [unset("verified")]), agent()));
    untouched(sql, () => mutate(sql, patchOf(sql, ielts, [unset("verified"), set("overall", 9)]), agent()));
    const note = getNote(sql, ielts);
    ok(note);
    const cleared = note.raw.replace(/^verified:.*\n/m, "").replace("overall: 8.0", "overall: 9");
    untouched(sql, () => mutate(sql, { op: "put", noteId: ielts, baseRev: note.rev, raw: cleared }, agent()));
  },

  "a note that supersedes a verified one is held; one that supersedes an unverified one is not": (
    sql,
    fixtures,
  ) => {
    record(sql, fixtures);
    untouched(sql, () =>
      mutate(
        sql,
        {
          op: "create",
          path: "facts/tests/ielts-2027.md",
          raw: superseding("ielts-2026-11.md"),
          class: "sensitive",
        },
        agent(),
      ),
    );
    applied(
      mutate(
        sql,
        {
          op: "create",
          path: "facts/tests/ielts-2027.md",
          raw: superseding("ielts-2025-03.md"),
          class: "sensitive",
        },
        agent(),
      ),
    );
  },

  "an undo that would move a verified value is held, and lands with an approval or a review session": (
    sql,
    fixtures,
  ) => {
    const { ielts } = record(sql, fixtures);
    const fix = withApproval(sql, patchOf(sql, ielts, [set("overall", 8.5)]), { ...human(), runId: "fix" });
    const verdict = untouched(sql, () => undoRun(sql, fix.runId, agent()));
    same(
      verdict.items.map((item) => [item.noteId, item.baseRev]),
      [[ielts, 2]],
    );
    const approvalId = approve(sql, verdict);
    const undone = undoRun(sql, fix.runId, { ...agent(), approvalId });
    ok(undone.status === "applied");
    same(undone.undone, [ielts]);
    equal(parseNote(getNote(sql, ielts)?.raw ?? "").data["overall"], 8);
  },

  "a review session covers verify, fix and undo on the notes it showed, for ten minutes": (sql, fixtures) => {
    const { ielts, tum } = record(sql, fixtures);
    const nonce = startReview(sql, [ielts], "human", T0);
    const fix = (overall: number, now: number) =>
      mutate(sql, patchOf(sql, ielts, [set("overall", overall)]), { ...human(now), review: nonce });
    // Not signed yet.
    untouched(sql, () => fix(8.5, T0));
    ok("review" in openReview(sql, nonce, "human", signed(), T0 + 1));
    // A nonce opens once.
    ok("error" in openReview(sql, nonce, "human", signed(), T0 + 2));
    applied(fix(8.5, T0 + 2));
    // Verify: extending the verification on a note shown.
    applied(
      mutate(sql, patchOf(sql, ielts, [{ op: "append", path: ["verified", "fields"], value: "date" }]), {
        ...human(T0 + 3),
        review: nonce,
      }),
    );
    // A note the session didn't show.
    untouched(sql, () =>
      mutate(sql, patchOf(sql, tum, [set("verified", { by: "human", fields: ["deadline"] })]), {
        ...human(T0 + 3),
        review: nonce,
      }),
    );
    // Deleting needs its own signature.
    untouched(sql, () =>
      mutate(
        sql,
        { op: "delete", noteId: ielts, baseRev: getNote(sql, ielts)?.rev ?? 0 },
        { ...human(T0 + 4), review: nonce },
      ),
    );
    // Ten minutes after the signature, it is over.
    untouched(sql, () => fix(9, T0 + 1 + REVIEW_MS));
  },

  "a sync edit to a verified value is held, uses up its number, and lands when resent with the approval": (
    sql,
    fixtures,
  ) => {
    const { ielts } = record(sql, fixtures);
    const note = getNote(sql, ielts);
    ok(note);
    const mutateMessage = (clientSeq: number, changeId: string, approvalId?: string): ClientMessage => ({
      type: "mutate",
      clientId: "laptop",
      clientSeq,
      changeId,
      ackedUpTo: 0,
      noteId: ielts,
      baseRev: note.rev,
      change: { kind: "put", base: note.raw, raw: note.raw.replace("overall: 8.0", "overall: 8.5") },
      ...(approvalId !== undefined && { approvalId }),
    });
    const ctx = { actor: "client:laptop", now: T0 };
    serve(
      sql,
      {
        type: "hello",
        clientId: "laptop",
        cursor: null,
        lastAssigned: 0,
        ackedUpTo: 0,
        schemaVersion: 0,
        appVersion: "t",
        attempt: 0,
      },
      ctx,
      PERSON,
    );
    const first = serve(sql, mutateMessage(1, "c1"), ctx, PERSON);
    const [result] = first.replies;
    ok(result?.type === "result" && result.needsApproval, JSON.stringify(result));
    equal(result.ok, false);
    equal(first.push, undefined);
    const approvalId = approve(sql, { status: "needsApproval", ...result.needsApproval });
    const second = serve(sql, mutateMessage(2, "c2", approvalId), ctx, PERSON);
    same(
      second.replies.map((r) => r.type === "result" && [r.ok, r.rev]),
      [[true, note.rev + 1]],
    );
  },

  "a verified field named with a dot is covered, whether it is a path or a literal name": (sql) => {
    migrate(sql);
    const { noteId } = withApproval(
      sql,
      { op: "create", path: "a.md", raw: dotted("exam.score"), class: "normal" },
      human(),
    );
    untouched(sql, () => mutate(sql, patchOf(sql, noteId, [set("exam.score", 999)]), agent()));
    untouched(sql, () =>
      mutate(sql, patchOf(sql, noteId, [{ op: "set", path: ["exam", "score"], value: 999 }]), agent()),
    );
  },

  "front-matter can't name a field __proto__, so no comparison or plan can lose it": (sql, fixtures) => {
    const { ielts } = record(sql, fixtures);
    const note = getNote(sql, ielts);
    ok(note);
    for (const line of ["__proto__: {score: 9}", "sections: {__proto__: {}}"]) {
      const result = mutate(
        sql,
        {
          op: "put",
          noteId: ielts,
          baseRev: note.rev,
          raw: note.raw.replace("---\n## Notes", `${line}\n---\n## Notes`),
        },
        agent(),
      );
      equal(result.status, "invalid", JSON.stringify(result));
    }
  },

  "an approval covers the privacy class it was signed for": (sql, fixtures) => {
    migrate(sql);
    const sensitive: Mutation = { op: "create", path: IELTS, raw: raw(fixtures, IELTS), class: "sensitive" };
    const approvalId = approve(sql, held(mutate(sql, sensitive, human())));
    untouched(sql, () => mutate(sql, { ...sensitive, class: "normal" }, { ...human(), approvalId }));
    applied(mutate(sql, sensitive, { ...human(), approvalId }));
  },

  "a review session is its opener's alone, and never covers deleting more than five notes": (
    sql,
    fixtures,
  ) => {
    migrate(sql);
    const ids = Array.from({ length: 6 }, (_, i) => {
      const created = withApproval(
        sql,
        {
          op: "create",
          path: `facts/tests/ielts-${i}.md`,
          raw: raw(fixtures, IELTS).replace(/^id: .*$/m, `id: ${ulid(T0 + i)}`),
          class: "sensitive",
        },
        { ...human(), runId: "import" },
      );
      return created.noteId;
    });
    const nonce = startReview(sql, ids, "human", T0);
    ok("review" in openReview(sql, nonce, "human", signed(), T0));
    const [first] = ids;
    ok(first);
    // The nonce in an agent's hands does nothing.
    untouched(sql, () =>
      mutate(sql, patchOf(sql, first, [set("overall", 9)]), { ...agent(), review: nonce }),
    );
    // Undoing the run would delete six verified notes: a bulk delete needs its own signature.
    untouched(sql, () => undoRun(sql, "import", { ...human(), review: nonce }));
    applied(mutate(sql, patchOf(sql, first, [set("overall", 9)]), { ...human(), review: nonce }));
  },

  "front-matter refuses values JSON can't keep, like .inf and .nan": (sql, fixtures) => {
    const { tum } = record(sql, fixtures);
    const note = getNote(sql, tum);
    ok(note);
    // Stored as JSON, each would read as null, so a change between them would never be seen.
    for (const value of [".inf", "-.inf", ".nan"]) {
      const text: string = note.raw.replace("status: preparing", `status: preparing\nscore: ${value}`);
      equal(
        mutate(sql, { op: "put", noteId: tum, baseRev: note.rev, raw: text }, agent()).status,
        "invalid",
        value,
      );
    }
  },

  "front-matter refuses what JSON would blur: tagged collections and integers past 2^53": (sql, fixtures) => {
    const { tum } = record(sql, fixtures);
    const note = getNote(sql, tum);
    ok(note);
    for (const value of ["!!omap [{writing: 7.5}]", "!!set {a, b}", "2612345678901234567"]) {
      const text: string = note.raw.replace("status: preparing", `status: preparing\nscore: ${value}`);
      equal(
        mutate(sql, { op: "put", noteId: tum, baseRev: note.rev, raw: text }, agent()).status,
        "invalid",
        value,
      );
    }
    // Quoted, the long number is text, and kept exactly.
    const quoted: string = note.raw.replace(
      "status: preparing",
      'status: preparing\nscore: "2612345678901234567"',
    );
    applied(mutate(sql, { op: "put", noteId: tum, baseRev: note.rev, raw: quoted }, agent()));
  },

  "front-matter is read as YAML 1.2 core, with no tags and no keys that read alike": (sql, fixtures) => {
    const { tum } = record(sql, fixtures);
    const note = getNote(sql, tum);
    ok(note);
    const put = (yaml: string) =>
      mutate(
        sql,
        { op: "put", noteId: tum, baseRev: note.rev, raw: note.raw.replace("status: preparing", yaml) },
        agent(),
      ).status;
    for (const yaml of [
      "status: preparing\nscore: !!timestamp 2026-11-02T10:00:00.0001Z",
      "status: preparing\nscore: !!binary SGVsbG8=",
      "status: preparing\nscore: !custom x",
      'status: preparing\n1: a\n"1": b',
      "&k status: preparing\n*k : submitted",
      'status: preparing\n~: a\n"": b',
      "status: preparing\n? [a]\n: 1",
      "status: preparing\nscore: -0",
      "status: preparing\n9007199254740993: x",
    ]) {
      equal(put(yaml), "invalid", yaml);
    }
  },

  "a verified block whose fields aren't a list of names covers every field": (sql) => {
    migrate(sql);
    const text = [
      "---",
      `id: ${ulid(T0)}`,
      "overall: 8",
      "verified: {by: human, fields: overall}",
      "---",
      "",
    ].join("\n");
    const { noteId } = withApproval(sql, { op: "create", path: "a.md", raw: text, class: "normal" }, human());
    untouched(sql, () => mutate(sql, patchOf(sql, noteId, [set("overall", 9)]), agent()));
    untouched(sql, () => mutate(sql, patchOf(sql, noteId, [set("title", "x")]), agent()));
  },

  "adding, removing or redirecting an edge into a verified note is held, whatever the path's case": (
    sql,
    fixtures,
  ) => {
    const { ielts } = record(sql, fixtures);
    // A verified note's own `supersedes` is part of what was verified, whatever it points at.
    untouched(sql, () => mutate(sql, patchOf(sql, ielts, [unset("supersedes")]), agent()));
    withApproval(
      sql,
      {
        op: "create",
        path: "facts/tests/ielts-2025-03.md",
        raw: superseding("x.md").replace("supersedes: x.md\n", "verified: {by: human, fields: [overall]}\n"),
        class: "sensitive",
      },
      human(),
    );
    // The verified 2026 score supersedes the verified 2025 one: removing or redirecting that edge is held.
    untouched(sql, () => mutate(sql, patchOf(sql, ielts, [unset("supersedes")]), agent()));
    untouched(sql, () => mutate(sql, patchOf(sql, ielts, [set("supersedes", "x.md")]), agent()));
    // An unverified note pointing at it, by another case of its path: held to set, and to remove.
    const next = {
      op: "create",
      path: "facts/tests/ielts-2027.md",
      raw: superseding("IELTS-2025-03.md"),
      class: "sensitive",
    } as const;
    untouched(sql, () => mutate(sql, next, agent()));
    const { noteId } = withApproval(sql, next, human());
    untouched(sql, () => mutate(sql, patchOf(sql, noteId, [unset("supersedes")]), agent()));
    untouched(sql, () =>
      mutate(sql, { op: "delete", noteId, baseRev: getNote(sql, noteId)?.rev ?? 0 }, agent()),
    );
  },

  "deleting more than five notes in one change is held, verified or not": (sql, fixtures) => {
    migrate(sql);
    for (let i = 0; i < 6; i++) {
      applied(
        mutate(
          sql,
          {
            op: "create",
            path: `facts/roles/r-${i}.md`,
            raw: raw(fixtures, TUM).replace(/^id: .*$/m, `id: ${ulid(T0 + i)}`),
            class: "normal",
          },
          { ...agent(), runId: "import" },
        ),
      );
    }
    const nonce = startReview(sql, [], "human", T0);
    ok("review" in openReview(sql, nonce, "human", signed(), T0));
    untouched(sql, () => undoRun(sql, "import", agent()));
    untouched(sql, () => undoRun(sql, "import", { ...human(), review: nonce }));
  },

  "a review session can't move an edge into a verified note it didn't show": (sql, fixtures) => {
    record(sql, fixtures);
    withApproval(
      sql,
      {
        op: "create",
        path: "facts/tests/ielts-2025-03.md",
        raw: superseding("x.md").replace("supersedes: x.md\n", "verified: {by: human, fields: [overall]}\n"),
        class: "sensitive",
      },
      human(),
    );
    const old = getNote(
      sql,
      sql.all<{ id: string }>("SELECT id FROM notes WHERE path = 'facts/tests/ielts-2025-03.md'")[0]?.id ??
        "",
    );
    ok(old);
    const draft = applied(
      mutate(
        sql,
        { op: "create", path: "facts/tests/draft.md", raw: superseding("x.md"), class: "sensitive" },
        human(),
      ),
    );
    const point = (review: string) =>
      mutate(sql, patchOf(sql, draft.noteId, [set("supersedes", "ielts-2025-03.md")]), {
        ...human(),
        review,
      });
    const only = startReview(sql, [draft.noteId], "human", T0);
    ok("review" in openReview(sql, only, "human", signed(), T0));
    untouched(sql, () => point(only));
    const both = startReview(sql, [draft.noteId, old.id], "human", T0);
    ok("review" in openReview(sql, both, "human", signed(), T0));
    applied(point(both));
  },

  "only whoever started a review session can open it": (sql, fixtures) => {
    const { ielts } = record(sql, fixtures);
    const nonce = startReview(sql, [ielts], "connection:agent", T0);
    same(openReview(sql, nonce, "human", signed(), T0), {
      error: "This review session can't be opened. Start a new one.",
    });
  },

  "no sequence of changes without an approval moves a verified value or lets a held change land": (
    sql,
    fixtures,
  ) => {
    migrate(sql);
    const LATER = T0 + 60 * 60 * 1000;
    let round = 0;
    const actions = fc.array(
      fc.record({
        target: fc.constantFrom("ielts", "tum", "bridge"),
        actor: fc.constantFrom("human", "connection:agent", "client:laptop"),
        grant: fc.constantFrom(
          "none",
          "bogus",
          "spent",
          "other-plan",
          "unsigned-review",
          "other-review",
          "expired-review",
          "someone-elses-review",
        ),
        action: fc.oneof(
          fc.record({
            kind: fc.constant("patch" as const),
            ops: fc.array(
              fc.oneof(
                fc.record({
                  op: fc.constant("set" as const),
                  path: fc.constantFrom(
                    ["overall"],
                    ["sections", "writing"],
                    ["verified"],
                    ["verified", "fields"],
                    ["type"],
                    ["title"],
                    ["expires"],
                    ["status"],
                    ["supersedes"],
                  ),
                  value: fc.oneof(
                    fc.integer({ min: 0, max: 9 }),
                    fc.constantFrom(
                      "Award",
                      "x",
                      ["overall"],
                      { by: "agent" },
                      "ielts-2025-03.md",
                      "IELTS-2025-03.md",
                      "x.md",
                    ),
                  ),
                }),
                fc.record({
                  op: fc.constant("unset" as const),
                  path: fc.constantFrom(
                    ["overall"],
                    ["sections"],
                    ["verified"],
                    ["verified", "fields"],
                    ["type"],
                    ["title"],
                    ["supersedes"],
                  ),
                }),
                fc.record({
                  op: fc.constant("section" as const),
                  heading: fc.constant("Notes"),
                  content: fc.constantFrom("a\n", "b\n"),
                }),
              ),
              { minLength: 1, maxLength: 3 },
            ),
          }),
          fc.record({ kind: fc.constant("delete" as const) }),
          fc.record({ kind: fc.constant("restore" as const) }),
          fc.record({
            kind: fc.constantFrom(
              "create-verified" as const,
              "create-superseding" as const,
              "create-plain" as const,
            ),
          }),
          fc.record({ kind: fc.constant("undo" as const), pick: fc.nat() }),
        ),
      }),
      { maxLength: 12 },
    );

    fc.assert(
      fc.property(actions, (steps) => {
        // Each run gets its own folder and ids in the one database: earlier runs' notes must hold too.
        const dir = `r${++round}/`;
        const ids = {
          ielts: ulid(T0 + round * 3),
          tum: ulid(T0 + round * 3 + 1),
          bridge: ulid(T0 + round * 3 + 2),
        };
        const ieltsRaw = raw(fixtures, IELTS).replace(/^id: .*$/m, `id: ${ids.ielts}`);
        const tumRaw = raw(fixtures, TUM).replace(/^id: .*$/m, `id: ${ids.tum}`);
        const ieltsPath = `${dir}${IELTS}`;
        // The verified score the IELTS note supersedes, so that edge is in the verified set too.
        withApproval(
          sql,
          {
            op: "create",
            path: `${dir}facts/tests/ielts-2025-03.md`,
            raw: [
              "---",
              `id: ${ulid(LATER)}`,
              "type: TestScore",
              "overall: 7",
              "verified: {by: human, fields: [overall]}",
              "---",
              "",
            ].join("\n"),
            class: "sensitive",
          },
          human(LATER),
        );
        const created = withApproval(
          sql,
          { op: "create", path: ieltsPath, raw: ieltsRaw, class: "sensitive" },
          { ...human(LATER), runId: `${dir}verify` },
        );
        applied(
          mutate(sql, { op: "create", path: `${dir}${TUM}`, raw: tumRaw, class: "normal" }, human(LATER)),
        );
        // An unverified note with an edge into the verified 2025 score (by another case of its path), approved:
        // removing or moving the edge changes which verified score is current.
        withApproval(
          sql,
          {
            op: "create",
            path: `${dir}facts/tests/bridge.md`,
            raw: [
              "---",
              `id: ${ids.bridge}`,
              "type: TestScore",
              "overall: 6",
              "supersedes: IELTS-2025-03.md",
              "---",
              "",
            ].join("\n"),
            class: "sensitive",
          },
          human(LATER),
        );
        const runs = [created.runId];
        // Grants an actor without the person's passkey can hold: none of them is for what it is doing.
        const spent = approve(
          sql,
          held(mutate(sql, patchOf(sql, ids.ielts, [set("overall", 1)]), agent(LATER))),
        );
        mutate(sql, patchOf(sql, ids.ielts, [set("overall", 1)]), { ...agent(LATER), approvalId: spent });
        mutate(sql, patchOf(sql, ids.ielts, [set("overall", 8)]), {
          ...agent(LATER),
          approvalId: approve(
            sql,
            held(mutate(sql, patchOf(sql, ids.ielts, [set("overall", 8)]), agent(LATER))),
          ),
        });
        // A half band, which the steps never generate: a step equal to the signed plan would be approved.
        const otherPlan = approve(
          sql,
          held(mutate(sql, patchOf(sql, ids.ielts, [set("overall", 2.5)]), agent(LATER))),
        );
        const unsignedReview = startReview(sql, [ids.ielts, ids.tum], "human", LATER);
        // Signed, over a note the steps never touch.
        const otherReview = startReview(sql, [ulid(LATER)], "human", LATER);
        ok("review" in openReview(sql, otherReview, "human", signed(), LATER));
        const expiredReview = startReview(sql, [ids.ielts], "human", LATER - REVIEW_MS - 2);
        ok("review" in openReview(sql, expiredReview, "human", signed(), LATER - REVIEW_MS - 1));
        // Signed and current over both notes, but opened by the site, which never acts in these steps.
        const sitesReview = startReview(sql, [ids.ielts, ids.tum], "client:site", LATER);
        ok("review" in openReview(sql, sitesReview, "client:site", signed(), LATER));
        const grants = {
          none: {},
          bogus: { approvalId: "made-up" },
          spent: { approvalId: spent },
          "other-plan": { approvalId: otherPlan },
          "unsigned-review": { review: unsignedReview },
          "other-review": { review: otherReview },
          "expired-review": { review: expiredReview },
          "someone-elses-review": { review: sitesReview },
        };

        let made = 0;
        const before = verifiedSet(sql);
        for (const step of steps) {
          const ctx: Context = { actor: step.actor, now: LATER, ...grants[step.grant] };
          const noteId = ids[step.target];
          const note = getNote(sql, noteId);
          ok(note);
          const { action } = step;
          const fresh = (lines: string[]) => ["---", `id: ${ulid(LATER)}`, ...lines, "---", ""].join("\n");
          const path = `${dir}facts/tests/new-${++made}.md`;
          const mutation: Mutation | undefined =
            action.kind === "patch"
              ? { op: "patch", noteId, baseRev: note.rev, ops: action.ops as PatchOp[] }
              : action.kind === "delete"
                ? { op: "delete", noteId, baseRev: note.rev }
                : action.kind === "restore"
                  ? { op: "put", noteId, baseRev: note.rev, raw: note.raw }
                  : action.kind === "create-verified"
                    ? {
                        op: "create",
                        path,
                        raw: fresh([
                          "type: TestScore",
                          "overall: 9",
                          "verified: {by: agent, fields: [overall]}",
                        ]),
                        class: "sensitive",
                      }
                    : action.kind === "create-superseding"
                      ? {
                          op: "create",
                          path,
                          raw: fresh(["type: TestScore", "overall: 9", "supersedes: ielts-2026-11.md"]),
                          class: "sensitive",
                        }
                      : action.kind === "create-plain"
                        ? {
                            op: "create",
                            path,
                            raw: fresh(["type: TestScore", "overall: 9"]),
                            class: "sensitive",
                          }
                        : undefined;
          const count = () => sql.all<{ n: number }>("SELECT count(*) AS n FROM proposals")[0]?.n;
          const seq = currentSeq(sql);
          const proposals = count();
          const result =
            mutation !== undefined
              ? mutate(sql, mutation, ctx)
              : undoRun(sql, runs[action.kind === "undo" ? action.pick % runs.length : 0] ?? "", ctx);
          if (result.status === "needsApproval") {
            // Held: nothing of it landed.
            same([currentSeq(sql), count()], [seq, proposals]);
          } else if ("runId" in result) runs.push(result.runId);
          same(verifiedSet(sql), before, JSON.stringify(step));
        }
      }),
      { numRuns: 40, includeErrorInReport: true },
    );
  },
};
