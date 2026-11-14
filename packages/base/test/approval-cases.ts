// Conformance cases for approvals (contract §4): what needs one, how one is used, and a property test that no
// sequence of changes without one moves a verified value. cases.ts runs them on both engines. The passkey
// signature itself is checked in the DO (apps/worker/test/approvals.test.ts); here a `Signature` stands for
// one the DO has already checked.
import { deepStrictEqual as same, equal, ok } from "node:assert/strict";

import { parseNote, ulid, type ClientMessage, type PatchOp, type YamlValue } from "@brainiac/core";
import fc from "fast-check";

import {
  currentSeq,
  getNote,
  migrate,
  mutate,
  openReview,
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
  publicKey: "cose-key",
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

/** Every live note's verification and the values it covers, plus its path and type. */
function verifiedSet(sql: Sql) {
  return sql
    .all<{ id: string; path: string; fm: string }>(
      "SELECT id, path, fm FROM notes WHERE deletedAt IS NULL AND fm ->> '$.verified' IS NOT NULL ORDER BY id",
    )
    .map(({ id, path, fm }) => {
      const data: Record<string, unknown> = JSON.parse(fm);
      const verified = data["verified"] as { fields?: string[] };
      return {
        id,
        path,
        type: data["type"],
        verified,
        values: Array.isArray(verified.fields) ? verified.fields.map((field) => data[field]) : [],
      };
    });
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
    // A plan is approved once, and a passkey counter that doesn't move is a replayed signature.
    const again = held(mutate(sql, patchOf(sql, ielts, [set("overall", 8)]), agent())).items;
    ok("approvalId" in recordApproval(sql, again, signed(), T0));
    same(recordApproval(sql, again, signed(), T0), { error: "This plan was already approved." });
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
    const nonce = startReview(sql, [ielts], T0);
    const fix = (overall: number, now: number) =>
      mutate(sql, patchOf(sql, ielts, [set("overall", overall)]), { ...human(now), review: nonce });
    // Not signed yet.
    untouched(sql, () => fix(8.5, T0));
    ok("review" in openReview(sql, nonce, signed(), T0 + 1));
    // A nonce opens once.
    ok("error" in openReview(sql, nonce, signed(), T0 + 2));
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
    );
    const first = serve(sql, mutateMessage(1, "c1"), ctx);
    const [result] = first.replies;
    ok(result?.type === "result" && result.needsApproval, JSON.stringify(result));
    equal(result.ok, false);
    equal(first.push, undefined);
    const approvalId = approve(sql, { status: "needsApproval", ...result.needsApproval });
    const second = serve(sql, mutateMessage(2, "c2", approvalId), ctx);
    same(
      second.replies.map((r) => r.type === "result" && [r.ok, r.rev]),
      [[true, note.rev + 1]],
    );
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
        target: fc.constantFrom("ielts", "tum"),
        actor: fc.constantFrom("human", "connection:agent", "client:laptop"),
        grant: fc.constantFrom(
          "none",
          "bogus",
          "spent",
          "other-plan",
          "unsigned-review",
          "other-review",
          "expired-review",
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
                  ),
                  value: fc.oneof(
                    fc.integer({ min: 0, max: 9 }),
                    fc.constantFrom("Award", "x", ["overall"], { by: "agent" }),
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
        const ids = { ielts: ulid(T0 + round * 2), tum: ulid(T0 + round * 2 + 1) };
        const ieltsRaw = raw(fixtures, IELTS).replace(/^id: .*$/m, `id: ${ids.ielts}`);
        const tumRaw = raw(fixtures, TUM).replace(/^id: .*$/m, `id: ${ids.tum}`);
        const ieltsPath = `${dir}${IELTS}`;
        const created = withApproval(
          sql,
          { op: "create", path: ieltsPath, raw: ieltsRaw, class: "sensitive" },
          { ...human(LATER), runId: `${dir}verify` },
        );
        applied(
          mutate(sql, { op: "create", path: `${dir}${TUM}`, raw: tumRaw, class: "normal" }, human(LATER)),
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
        const otherPlan = approve(
          sql,
          held(mutate(sql, patchOf(sql, ids.ielts, [set("overall", 2)]), agent(LATER))),
        );
        const unsignedReview = startReview(sql, [ids.ielts, ids.tum], LATER);
        // Signed, over a note the steps never touch.
        const otherReview = startReview(sql, [ulid(LATER)], LATER);
        ok("review" in openReview(sql, otherReview, signed(), LATER));
        const expiredReview = startReview(sql, [ids.ielts], LATER - REVIEW_MS - 2);
        ok("review" in openReview(sql, expiredReview, signed(), LATER - REVIEW_MS - 1));
        const grants = {
          none: {},
          bogus: { approvalId: "made-up" },
          spent: { approvalId: spent },
          "other-plan": { approvalId: otherPlan },
          "unsigned-review": { review: unsignedReview },
          "other-review": { review: otherReview },
          "expired-review": { review: expiredReview },
        };

        const before = verifiedSet(sql);
        for (const step of steps) {
          const ctx: Context = { actor: step.actor, now: LATER, ...grants[step.grant] };
          const noteId = ids[step.target];
          const note = getNote(sql, noteId);
          ok(note);
          const { action } = step;
          const fresh = (lines: string[]) => ["---", `id: ${ulid(LATER)}`, ...lines, "---", ""].join("\n");
          const path = `${dir}facts/tests/new-${runs.length}-${Math.random().toString(36).slice(2)}.md`;
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
