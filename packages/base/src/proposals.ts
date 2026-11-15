// Proposals (contract §3): held changes, a propose-level connection's changes, and conflicts. Only the person
// decides them; a connection may withdraw its own. A held change applies on its own once its hold runs out, if
// its connection still exists at write level; otherwise it waits for the person.
import {
  deepEqual,
  NoteParseError,
  parseNote,
  patch,
  PatchError,
  splitNote,
  type Diff,
  type PatchOp,
  type PlanItem,
  type YamlValue,
} from "@brainiac/core";

import type { NeedsApproval } from "./approvals.ts";
import { connectionOf } from "./connections.ts";
import { diff, side, stateOf, type State } from "./diff.ts";
import type { Action, Proposed } from "./hold.ts";
import {
  mutate,
  release,
  releaseUndo,
  type Context,
  type Forbidden,
  type MutationResult,
  type UndoResult,
} from "./mutate.ts";
import { getNote, type NoteRow } from "./notes.ts";
import type { Sql } from "./sql.ts";

interface ProposalRow {
  readonly id: string;
  readonly noteId: string | null;
  /** A `change` proposal's plan (`PlanItem[]`); a `conflict` proposal's `Diff`. */
  readonly patch: string;
  readonly actor: string;
  readonly autoApplyAt: number | null;
  readonly status: "open" | "applied" | "rejected" | "withdrawn";
  readonly kind: "change" | "conflict" | "schema";
  readonly action: string | null;
  readonly runId: string | null;
}

export type Decided =
  | MutationResult
  | UndoResult
  | NeedsApproval
  | Proposed
  | Forbidden
  | { readonly status: "rejected" | "withdrawn" };

const refused = (message: string): Decided => ({
  status: "invalid",
  issues: [{ field: "proposal", message }],
});

const openProposal = (sql: Sql, id: string) =>
  sql.all<ProposalRow>("SELECT * FROM proposals WHERE id = ? AND status = 'open'", id)[0];

const has = (data: object, key: string) => Object.hasOwn(data, key);

/** Whether the note is still where `d` started: each field, the body and its existence as `d.before` has them. */
function at(now: State, d: Diff): boolean {
  const fields = Object.entries(d.fields).every(
    ([key, change]) =>
      has(now.data, key) === Object.hasOwn(change, "before") && deepEqual(now.data[key], change.before),
  );
  return fields && (!d.body || now.body === (d.body.before ?? "")) && (!d.live || now.live === d.live.before);
}

/** From the note as it is now to where `d` would take it: a conflict for the person to pick. */
const towards = (now: State, d: Diff): Diff => ({
  fields: Object.fromEntries(
    Object.entries(d.fields).map(([key, change]) => [
      key,
      {
        ...side("before", has(now.data, key), now.data[key]),
        ...side("after", has(change, "after"), change.after),
      },
    ]),
  ),
  ...(d.body && { body: { before: now.body, after: d.body.after ?? "" } }),
  ...(d.live && { live: { before: now.live, after: d.live.after ?? false } }),
});

/**
 * Whether a held field patch, replayed on the note as it is now, does exactly what was held. An op that did
 * nothing then (a field set to the value it had) may undo someone's edit now, so the whole effect must match.
 */
function rebases(note: NoteRow, ops: readonly PatchOp[], held: Diff): boolean {
  if (note.deletedAt !== null) return false;
  let raw: string;
  try {
    raw = patch(note.raw, ops);
    const data: unknown = JSON.parse(JSON.stringify(parseNote(raw).data));
    const after = diff(stateOf(note), { data: data as State["data"], body: splitNote(raw).body, live: true });
    return deepEqual(JSON.parse(JSON.stringify(after)), held);
  } catch (error) {
    if (error instanceof PatchError || error instanceof NoteParseError) return false;
    throw error;
  }
}

/**
 * Runs a change proposal's action, as `ctx` (the person accepting it, or its connection when its hold ran out). A
 * note changed since the proposal was made takes it only if it is a field patch that still does exactly what was
 * held; otherwise the proposal becomes a conflict for the person.
 */
function apply(sql: Sql, proposal: ProposalRow, ctx: Context): Decided {
  return sql.transaction((): Decided => {
    const action: Action = JSON.parse(proposal.action ?? "null");
    const run: Context = { ...ctx, ...(proposal.runId !== null && { runId: proposal.runId }) };
    let result: Decided;
    if (action.op === "undo") result = releaseUndo(sql, action, run);
    else {
      let mutation = action;
      const note = mutation.op === "create" ? undefined : getNote(sql, mutation.noteId);
      if (note && mutation.op !== "create" && note.rev !== mutation.baseRev) {
        const items: PlanItem[] = JSON.parse(proposal.patch);
        const d = items.find((item) => item.noteId === note.id)?.patch ?? { fields: {} };
        if (mutation.op === "patch" && rebases(note, mutation.ops, d))
          mutation = { ...mutation, baseRev: note.rev };
        else {
          sql.all(
            "UPDATE proposals SET kind = 'conflict', patch = ?, action = NULL, autoApplyAt = NULL WHERE id = ?",
            JSON.stringify(towards(stateOf(note), d)),
            proposal.id,
          );
          return { status: "conflict", noteId: note.id, rev: note.rev };
        }
      }
      result = release(sql, mutation, run);
    }
    if (result.status === "applied")
      sql.all("UPDATE proposals SET status = 'applied', autoApplyAt = NULL WHERE id = ?", proposal.id);
    return result;
  });
}

/** Writes a conflict's kept-out side (`after`) onto its note, if the note is still where the conflict left it. */
function pick(sql: Sql, proposal: ProposalRow, ctx: Context): Decided {
  return sql.transaction((): Decided => {
    const note = proposal.noteId === null ? undefined : getNote(sql, proposal.noteId);
    if (!note) return refused("This conflict's note is gone.");
    const d: Diff = JSON.parse(proposal.patch);
    if (!at(stateOf(note), d)) return refused("The note changed since this conflict. Look at it again.");
    let result: MutationResult;
    if (d.live?.after === false)
      result = mutate(sql, { op: "delete", noteId: note.id, baseRev: note.rev }, ctx);
    else {
      let raw = patch(
        note.raw,
        Object.entries(d.fields).map(([key, change]) =>
          has(change, "after")
            ? { op: "set", path: [key], value: change.after as YamlValue }
            : { op: "unset", path: [key] },
        ),
      );
      if (d.body) raw = raw.slice(0, splitNote(raw).bodyStart) + (d.body.after ?? "");
      result = mutate(sql, { op: "put", noteId: note.id, baseRev: note.rev, raw }, ctx);
    }
    if (result.status === "applied")
      sql.all("UPDATE proposals SET status = 'applied' WHERE id = ?", proposal.id);
    return result;
  });
}

/**
 * The person accepts or rejects a proposal. Accepting applies it now as the person's own change, in its author's
 * run; the proposal keeps who made it. The approval list still binds: a `needsApproval` is signed (or covered by
 * the person's review session), then accepted again.
 * Accepting a conflict writes its kept-out side. No connection may decide.
 */
export function decide(sql: Sql, proposalId: string, decision: "accept" | "reject", ctx: Context): Decided {
  if (ctx.connection) return { status: "forbidden", reason: "Only you decide proposals." };
  const proposal = openProposal(sql, proposalId);
  if (!proposal) return refused("No open proposal with that id.");
  if (decision === "reject") {
    sql.all("UPDATE proposals SET status = 'rejected', autoApplyAt = NULL WHERE id = ?", proposal.id);
    return { status: "rejected" };
  }
  if (proposal.kind === "change") return apply(sql, proposal, ctx);
  if (proposal.kind === "conflict") return pick(sql, proposal, ctx);
  return refused("Schema proposals are decided in organize.");
}

/** Withdraws one of the caller's own open proposals; nothing more is in an agent's hands. */
export function withdraw(sql: Sql, proposalId: string, ctx: Context): Decided {
  const [row] = sql.all<{ id: string }>(
    "UPDATE proposals SET status = 'withdrawn', autoApplyAt = NULL WHERE id = ? AND actor = ? AND status = 'open' RETURNING id",
    proposalId,
    ctx.actor,
  );
  return row ? { status: "withdrawn" } : refused("No open proposal of yours with that id.");
}

/**
 * Applies held changes whose hold has run out, each with its connection's current grants. One whose connection
 * is gone or below write, or that can't apply as it stands, waits for the person instead.
 */
export function releaseDue(sql: Sql, now: number): void {
  const due = sql.all<ProposalRow>(
    `SELECT * FROM proposals WHERE status = 'open' AND kind = 'change' AND autoApplyAt <= ?
     ORDER BY autoApplyAt, id`,
    now,
  );
  for (const proposal of due) {
    const connection = connectionOf(sql, proposal.actor);
    let result: Decided | undefined;
    try {
      if (connection?.level === "write")
        result = apply(sql, proposal, { actor: proposal.actor, now, connection });
    } catch (error) {
      // A bug, not a refusal: it rolled back. The person gets it rather than every alarm failing on it.
      console.error("held proposal failed to apply", proposal.id, error);
    }
    if (result?.status !== "applied" && result?.status !== "conflict")
      sql.all("UPDATE proposals SET autoApplyAt = NULL WHERE id = ?", proposal.id);
  }
}
