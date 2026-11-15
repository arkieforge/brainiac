import { createHash } from "node:crypto";

import {
  deepEqual,
  findClash,
  isUlid,
  NoteParseError,
  normalizePath,
  parseManifest,
  parseNote,
  patch,
  PatchError,
  PathError,
  splitNote,
  ulid,
  validate,
  type Diff,
  type Issue,
  type PatchOp,
  type PlanItem,
  type YamlValue,
} from "@brainiac/core";

import { planOf, settle, type Effect, type Grant, type NeedsApproval } from "./approvals.ts";
import { canSee, type Connection } from "./connections.ts";
import { diff, side, stateOf, type State } from "./diff.ts";
import { DAY_MS, holds, manifestOf, recordHeld, type Action, type Proposed } from "./hold.ts";
import { enqueue } from "./jobs.ts";
import { getNote, getNoteByPath, putNote, type NoteClass, type NoteRow } from "./notes.ts";
import { putChunks } from "./search.ts";
import type { Sql } from "./sql.ts";

/**
 * Who is changing the record, and when. Every mutation belongs to a run, so it can be undone with its run.
 * The grant (`approvalId`, `review`) is only a reference: it lets a change through only if a passkey signed
 * exactly its effect, or opened a review session over its notes.
 */
export interface Context extends Grant {
  /** For example `human` or `connection:<id>`; recorded on the revision and the change. */
  readonly actor: string;
  /** Groups the changes an agent or `organize` made together; a mutation without one is its own run. */
  readonly runId?: string;
  readonly now: number;
  /**
   * The connection a change comes through Brainiac's tools on, loaded by the record from its own table: its
   * level, sensitive scope and hold window apply. Absent for the person on the site, and for sync, whose file
   * edits are unattributed (contract §3): those skip the hold, never the approval list.
   */
  readonly connection?: Connection;
}

/** The connection's level doesn't allow the change at all. */
export interface Forbidden {
  readonly status: "forbidden";
  readonly reason: string;
}

export type Mutation =
  /** A new note. Its ULID is the `id` in its front-matter. */
  | { readonly op: "create"; readonly path: string; readonly raw: string; readonly class: NoteClass }
  | {
      readonly op: "patch";
      readonly noteId: string;
      readonly baseRev: number;
      readonly ops: readonly PatchOp[];
    }
  /** Sets a note's whole text, as a sync client sends it. On a deleted note it restores the note with that text. */
  | { readonly op: "put"; readonly noteId: string; readonly baseRev: number; readonly raw: string }
  /** Leaves a tombstone for 30 days; undoing the run restores it. */
  | { readonly op: "delete"; readonly noteId: string; readonly baseRev: number };

export type MutationResult =
  | {
      readonly status: "applied";
      readonly noteId: string;
      readonly rev: number;
      readonly seq: number;
      readonly runId: string;
    }
  /** `baseRev` is not the note's current revision. */
  | { readonly status: "conflict"; readonly noteId: string; readonly rev: number }
  | { readonly status: "invalid"; readonly issues: readonly Issue[] }
  /** Nothing was written: the effect needs a passkey signature over `planHash` (contract §4). */
  | NeedsApproval
  /** Nothing was written yet: the change waits as a proposal, held or for the person to decide. */
  | Proposed
  | Forbidden;

interface Change<T> {
  readonly before?: T;
  readonly after?: T;
}

/** The notes one transaction wrote, each as it started, for judging the transaction's effect at its end. */
type Started = Map<string, NoteRow | undefined>;

type Invalid = Extract<MutationResult, { readonly status: "invalid" }>;

/** What a plan does, whatever revision it started from: a rebased release starts from a later one. */
const effectOf = (items: readonly PlanItem[]) =>
  JSON.parse(
    JSON.stringify(
      items.map((item) => ({ noteId: item.noteId, path: item.path, class: item.class, patch: item.patch })),
    ),
  );

/** Thrown to roll back a transaction whose effect needs an approval it doesn't have, or waits as a proposal. */
class Held extends Error {
  readonly verdict:
    | NeedsApproval
    | Invalid
    | { readonly autoApplyAt: number | null; readonly effects: Effect[] };
  constructor(verdict: Held["verdict"]) {
    super("held");
    this.verdict = verdict;
  }
}

/**
 * Runs `fn` in its own transaction (a savepoint inside the caller's), then judges what it did to each note it
 * wrote. Without the approval that effect needs, every write is rolled back and the result says what to sign.
 * A connection's change then waits as a proposal if its level or the hold window says so: rolled back too, and
 * recorded with the `action` that applies it once released. `released` is the plan of a proposal being applied:
 * the release applies exactly that, or nothing.
 */
function judged<T extends { readonly status: string }>(
  sql: Sql,
  ctx: Context,
  scope: "change" | "undo",
  action: Action,
  released: readonly PlanItem[] | undefined,
  fn: (started: Started) => T,
): T | NeedsApproval | Proposed | Forbidden | Invalid {
  const { connection } = ctx;
  if (connection?.level === "read") return { status: "forbidden", reason: "This connection can only read." };
  // The proposal is recorded in the same transaction the change rolled back in, so a crash keeps neither or both.
  return sql.transaction(() => {
    try {
      return sql.transaction(() => {
        const started: Started = new Map();
        const result = fn(started);
        const effects: Effect[] = [...started].flatMap(([id, before]) => {
          const after = getNote(sql, id);
          return after ? [{ before, after }] : [];
        });
        // The record moved under a held change so that it would now do something else (an undo with fewer
        // conflicts than it had): the person looks again rather than the release doing what nobody saw.
        if (released && !deepEqual(effectOf(planOf(effects)), effectOf(released)))
          throw new Held({
            status: "invalid",
            issues: [
              { field: "proposal", message: "The record changed since this was held. Look at it again." },
            ],
          });
        const verdict = settle(sql, effects, ctx, scope);
        if (verdict === "signed" || !connection || released || effects.length === 0) {
          if (typeof verdict === "object") throw new Held(verdict);
          return result;
        }
        // A propose-level connection's every change waits for the person, who meets any approval it needs then.
        if (connection.level === "propose") throw new Held({ autoApplyAt: null, effects });
        if (verdict) throw new Held(verdict);
        if (connection.holdDays > 0) {
          const manifest = manifestOf(sql);
          if (effects.some((effect) => holds(sql, manifest, effect)))
            throw new Held({ autoApplyAt: ctx.now + connection.holdDays * DAY_MS, effects });
        }
        return result;
      });
    } catch (error) {
      if (!(error instanceof Held)) throw error;
      if ("status" in error.verdict) return error.verdict;
      return recordHeld(
        sql,
        action,
        planOf(error.verdict.effects),
        ctx,
        error.verdict.autoApplyAt,
        ulid(ctx.now),
      );
    }
  });
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const invalid = (field: string, message: string): MutationResult => ({
  status: "invalid",
  issues: [{ field, message }],
});

/** The next `seq`. Kept in `meta` rather than read from `changes`, which is pruned. */
function nextSeq(sql: Sql): number {
  const [row] = sql.all<{ value: string }>(
    `INSERT INTO meta (key, value) VALUES ('seq', '1')
     ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value`,
  );
  return Number(row?.value);
}

/** Front-matter checks every write passes: an unchanged ULID id, and the manifest's types when there is one. */
function check(sql: Sql, raw: string, id?: string): Issue[] | Readonly<Record<string, unknown>> {
  let data: Readonly<Record<string, unknown>>;
  try {
    data = parseNote(raw).data;
  } catch (error) {
    if (error instanceof NoteParseError) return [{ field: "front-matter", message: error.message }];
    throw error;
  }
  if (id !== undefined && data["id"] !== id) return [{ field: "id", message: "A note's id never changes." }];
  const [schema] = sql.all<{ manifest: string }>("SELECT manifest FROM schema ORDER BY version DESC LIMIT 1");
  // shortcut: the manifest is parsed per write; cache it in the DO when profiles show it.
  const issues = schema
    ? validate(parseManifest(schema.manifest), data)
    : typeof data["id"] === "string" && isUlid(data["id"])
      ? []
      : [{ field: "id", message: "id must be a ULID. Example: id: 01JD7QA1ZK8M3V5X6Y7Z8A9BCD" }];
  return issues.length > 0 ? issues : data;
}

type Op = "create" | "update" | "delete" | "restore";

/** Writes the next revision of a note: the row, its revision with the inverse patch, its change, its job. */
function write(
  sql: Sql,
  started: Started,
  ctx: Context,
  runId: string,
  prev: NoteRow | undefined,
  next: Pick<NoteRow, "id" | "path" | "raw" | "class" | "deletedAt">,
  op: Op,
): Extract<MutationResult, { status: "applied" }> {
  if (!started.has(next.id)) started.set(next.id, prev);
  const seq = nextSeq(sql);
  const rev = (prev?.rev ?? 0) + 1;
  putNote(sql, { ...next, rev, seq, hash: sha256(next.raw) });
  const stored = getNote(sql, next.id);
  sql.all(
    "INSERT INTO revisions (noteId, rev, raw, patch, actor, runId, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    next.id,
    rev,
    next.raw,
    JSON.stringify(diff(stateOf(prev), stateOf(stored))),
    ctx.actor,
    runId,
    ctx.now,
  );
  sql.all(
    "INSERT INTO changes (seq, noteId, rev, op, actor, at) VALUES (?, ?, ?, ?, ?, ?)",
    seq,
    next.id,
    rev,
    op,
    ctx.actor,
    ctx.now,
  );
  // A deleted note leaves the search index and the outbox in the same transaction; a live one is re-indexed
  // by a job.
  if (next.deletedAt === null) enqueue(sql, "index", next.id, rev);
  else {
    putChunks(sql, next.id, rev, []);
    sql.all("DELETE FROM jobs WHERE noteId = ?", next.id);
  }
  return { status: "applied", noteId: next.id, rev, seq, runId };
}

/**
 * The one way a note changes: read its revision, validate, write, enqueue follow-up jobs, judge the effect,
 * commit, all in one transaction with no I/O, so the DO never interleaves another request inside it. Inside a
 * caller's transaction (the sync handler records the client's result in it too) it is a savepoint.
 */
export function mutate(sql: Sql, mutation: Mutation, ctx: Context): MutationResult {
  return judged(sql, ctx, "change", mutation, undefined, (started) => applyOne(sql, started, mutation, ctx));
}

/** Applies a released proposal's mutation, if it still does exactly what was held. The approval list still binds. */
export function release(
  sql: Sql,
  mutation: Mutation,
  plan: readonly PlanItem[],
  ctx: Context,
): MutationResult {
  return judged(sql, ctx, "change", mutation, plan, (started) => applyOne(sql, started, mutation, ctx));
}

function applyOne(sql: Sql, started: Started, mutation: Mutation, ctx: Context): MutationResult {
  const runId = ctx.runId ?? ulid(ctx.now);
  if (mutation.op === "create") {
    let path: string;
    try {
      path = normalizePath(mutation.path);
    } catch (error) {
      if (error instanceof PathError) return invalid("path", error.message);
      throw error;
    }
    const data = check(sql, mutation.raw);
    if (Array.isArray(data)) return { status: "invalid", issues: data };
    const id = String(data["id"]);
    if (getNote(sql, id)) return invalid("id", `A note with id ${id} already exists.`);
    const live = sql.all<{ path: string; class: NoteClass }>(
      "SELECT path, class FROM notes WHERE deletedAt IS NULL",
    );
    const clash = live.find((row) => findClash([row.path], path) !== undefined);
    if (clash !== undefined) {
      // A connection that can't see the note there isn't told its path.
      return canSee(ctx.connection, clash)
        ? invalid("path", `${path} clashes with ${clash.path}.`)
        : invalid("path", `${path} is taken.`);
    }
    return write(
      sql,
      started,
      ctx,
      runId,
      undefined,
      { id, path, raw: mutation.raw, class: mutation.class, deletedAt: null },
      "create",
    );
  }

  const note = getNote(sql, mutation.noteId);
  const deleted = note?.deletedAt !== null;
  // A note the connection can't see reads as no note at all: not its revision, its values or a failed check.
  if (!note || (deleted && mutation.op !== "put") || !canSee(ctx.connection, note)) {
    return invalid("noteId", `No note with id ${mutation.noteId}.`);
  }
  if (note.rev !== mutation.baseRev) return { status: "conflict", noteId: note.id, rev: note.rev };
  if (mutation.op === "delete")
    return write(sql, started, ctx, runId, note, { ...note, deletedAt: ctx.now }, "delete");

  let raw: string;
  try {
    raw = mutation.op === "put" ? mutation.raw : patch(note.raw, mutation.ops);
  } catch (error) {
    if (error instanceof PatchError || error instanceof NoteParseError) return invalid("ops", error.message);
    throw error;
  }
  if (raw === note.raw && !deleted) {
    return { status: "applied", noteId: note.id, rev: note.rev, seq: note.seq, runId };
  }
  const data = check(sql, raw, note.id);
  if (Array.isArray(data)) return { status: "invalid", issues: data };
  const taken = deleted ? findClash(livePaths(sql), note.path) : undefined;
  if (taken !== undefined) {
    const holder = getNoteByPath(sql, taken);
    return holder && !canSee(ctx.connection, holder)
      ? invalid("path", `${note.path} is taken since this note was deleted.`)
      : invalid("path", `${note.path} is taken by ${taken} since this note was deleted.`);
  }
  return write(
    sql,
    started,
    ctx,
    runId,
    note,
    { ...note, raw, deletedAt: null },
    deleted ? "restore" : "update",
  );
}

/** Records a conflict proposal: `change` goes from the note as it is (`before`) to the side it kept out (`after`). */
export function propose(sql: Sql, noteId: string, change: Diff, ctx: Context): string {
  const id = ulid(ctx.now);
  sql.all(
    "INSERT INTO proposals (id, noteId, patch, actor, status, kind) VALUES (?, ?, ?, ?, 'open', 'conflict')",
    id,
    noteId,
    JSON.stringify(change),
    ctx.actor,
  );
  return id;
}

export interface UndoConflict {
  readonly noteId: string;
  /** The conflict proposal holding the undo's side, for the person to pick. */
  readonly proposalId: string;
  /** From the note's current value (`before`) to what undoing would set (`after`). */
  readonly diff: Diff;
}

export interface UndoResult {
  readonly status: "applied";
  /** The undo's own run, so it can be undone too. */
  readonly runId: string;
  readonly undone: readonly string[];
  readonly conflicts: readonly UndoConflict[];
}

/** What undoing `d` would do, from the note as it is now: kept on a conflict proposal for the person to pick. */
function inverseFrom(now: State, d: Diff): Diff {
  const fields = Object.fromEntries(
    Object.entries(d.fields).map(([key, change]) => [
      key,
      {
        ...side("before", Object.hasOwn(now.data, key), now.data[key]),
        ...side("after", Object.hasOwn(change, "before"), change.before),
      },
    ]),
  );
  return {
    fields,
    ...(d.body && { body: { before: now.body, after: d.body.before ?? "" } }),
    ...(d.live && { live: { before: now.live, after: d.live.before ?? false } }),
  };
}

const livePaths = (sql: Sql) =>
  sql.all<{ path: string }>("SELECT path FROM notes WHERE deletedAt IS NULL").map((row) => row.path);

/**
 * Undoes every change a run made by applying the inverse patch of each of its revisions, newest first
 * across the whole run, so a later edit by anyone else is never rolled back with it. Values go back as
 * values, so a restored number is written in YAML's canonical form (`8.0` comes back as `8`). What can't go
 * back becomes a conflict proposal and the note keeps its current value: a field edited since, a note the
 * run created and someone edited since, a deleted note whose path is taken, a note deleted since, or an
 * undo that would leave the note failing its type.
 */
export function undoRun(
  sql: Sql,
  runId: string,
  ctx: Context,
): UndoResult | NeedsApproval | Proposed | Forbidden | Invalid {
  const [seq] = sql.all<{ value: string }>("SELECT value FROM meta WHERE key = 'seq'");
  return undoing(sql, { op: "undo", runId, upTo: Number(seq?.value ?? 0) }, ctx, undefined);
}

/** Applies a released proposal's undo: only the part of the run that was held, and only as it was held. */
export const releaseUndo = (
  sql: Sql,
  action: Extract<Action, { op: "undo" }>,
  plan: readonly PlanItem[],
  ctx: Context,
) => undoing(sql, action, ctx, plan);

function undoing(
  sql: Sql,
  action: Extract<Action, { op: "undo" }>,
  ctx: Context,
  released: readonly PlanItem[] | undefined,
): UndoResult | NeedsApproval | Proposed | Forbidden | Invalid {
  const { runId, upTo } = action;
  // An undo is a run of its own, so it can be undone too; never inside the run it undoes.
  const undoRunId = ctx.runId !== undefined && ctx.runId !== runId ? ctx.runId : ulid(ctx.now);
  const undo = { ...ctx, runId: undoRunId };
  return judged(sql, undo, "undo", action, released, (started): UndoResult | Forbidden => {
    // shortcut: revisions expire one by one after 30 days, so a run older than that undoes only its newer
    // part; keep whole runs if people undo month-old runs.
    const revisions = sql.all<{ noteId: string; patch: string; raw: string }>(
      `SELECT revisions.noteId, revisions.patch, revisions.raw FROM revisions
       JOIN changes ON changes.noteId = revisions.noteId AND changes.rev = revisions.rev
       WHERE revisions.runId = ? AND changes.seq <= ? ORDER BY changes.seq DESC`,
      runId,
      upTo,
    );
    // Its conflicts would show the note's current values: a connection can't undo into a note it can't see.
    const hidden = revisions.some((revision) => {
      const note = getNote(sql, revision.noteId);
      return note !== undefined && !canSee(ctx.connection, note);
    });
    if (hidden) return { status: "forbidden", reason: "This run changed notes this connection can't see." };
    const undone = new Set<string>();
    // One pending conflict per note. Once a field, the body or the note's existence is in it, older steps
    // only move the conflict's target back; they never touch the note, so no later edit is rolled back.
    const pending = new Map<
      string,
      { fields: Record<string, Change<unknown>>; body?: Change<string>; live?: Change<boolean> }
    >();
    const hold = (noteId: string, d: Diff) => {
      const p = pending.get(noteId) ?? { fields: {} };
      for (const [key, change] of Object.entries(d.fields)) {
        const held = p.fields[key];
        p.fields[key] = held
          ? {
              ...side("before", Object.hasOwn(held, "before"), held.before),
              ...side("after", Object.hasOwn(change, "after"), change.after),
            }
          : change;
      }
      if (d.body) p.body = { before: (p.body ?? d.body).before ?? "", after: d.body.after ?? "" };
      if (d.live) p.live = { before: (p.live ?? d.live).before ?? false, after: d.live.after ?? false };
      pending.set(noteId, p);
    };

    for (const revision of revisions) {
      const note = getNote(sql, revision.noteId);
      if (!note) continue; // purged with its tombstone
      const d: Diff = JSON.parse(revision.patch);
      const now = stateOf(note);
      const held = pending.get(note.id);

      // Created by the run: undoing deletes it, unless it was edited since.
      if (d.live?.before === false) {
        // Already gone: whatever undoing the run's later steps asked of this note is moot.
        if (!now.live) {
          pending.delete(note.id);
          continue;
        }
        const then = parseNote(revision.raw);
        if (!held && deepEqual(now.data, then.data) && now.body === then.body) {
          write(sql, started, undo, undoRunId, note, { ...note, deletedAt: ctx.now }, "delete");
          undone.add(note.id);
        } else hold(note.id, inverseFrom(now, d));
        continue;
      }

      // Deleted by the run: undoing restores it, if its path is still free.
      if (d.live?.before === true) {
        if (now.live && !held?.live) continue;
        if (held?.live || findClash(livePaths(sql), note.path) !== undefined)
          hold(note.id, inverseFrom(now, d));
        else {
          write(sql, started, undo, undoRunId, note, { ...note, deletedAt: null }, "restore");
          undone.add(note.id);
        }
        continue;
      }

      // Changed by the run, deleted since: nothing to put the values back on.
      if (!now.live || held?.live) {
        hold(note.id, inverseFrom(now, d));
        continue;
      }

      const ops: PatchOp[] = [];
      const clash: Diff = { fields: {} };
      const into = (key: string, change: Change<unknown>) =>
        Object.assign(clash.fields, {
          [key]: {
            ...side("before", Object.hasOwn(now.data, key), now.data[key]),
            ...side("after", Object.hasOwn(change, "before"), change.before),
          },
        });
      for (const [key, change] of Object.entries(d.fields)) {
        const has = Object.hasOwn(now.data, key);
        const atAfter = has === Object.hasOwn(change, "after") && deepEqual(now.data[key], change.after);
        if (held?.fields[key] || !atAfter) into(key, change);
        else {
          ops.push(
            Object.hasOwn(change, "before")
              ? { op: "set", path: [key], value: change.before as YamlValue }
              : { op: "unset", path: [key] },
          );
        }
      }
      let raw = patch(note.raw, ops);
      const bodyClash = d.body && (held?.body !== undefined || now.body !== d.body.after);
      if (d.body && !bodyClash) raw = raw.slice(0, splitNote(raw).bodyStart) + (d.body.before ?? "");
      // Part of an undo can leave a note failing its type (a required field removed while the field that made
      // it required stays): the whole step then waits for the person instead.
      if (raw !== note.raw && Array.isArray(check(sql, raw, note.id))) {
        hold(note.id, inverseFrom(now, d));
        continue;
      }
      if (raw !== note.raw) {
        write(sql, started, undo, undoRunId, note, { ...note, raw }, "update");
        undone.add(note.id);
      }
      const body = bodyClash ? { before: now.body, after: d.body?.before ?? "" } : undefined;
      if (Object.keys(clash.fields).length > 0 || body) hold(note.id, { ...clash, ...(body && { body }) });
    }

    // A conflict whose target is where the note already is (undoing a run twice) asks nothing of the person
    // and is dropped.
    const conflicts: UndoConflict[] = [];
    for (const [noteId, p] of pending) {
      const same = <T>(c: Change<T>) =>
        Object.hasOwn(c, "before") === Object.hasOwn(c, "after") && deepEqual(c.before, c.after);
      const fields = Object.fromEntries(Object.entries(p.fields).filter(([, c]) => !same(c)));
      const d: Diff = {
        fields,
        ...(p.body && !same(p.body) && { body: p.body }),
        ...(p.live && !same(p.live) && { live: p.live }),
      };
      if (Object.keys(fields).length === 0 && !d.body && !d.live) continue;
      conflicts.push({ noteId, proposalId: propose(sql, noteId, d, ctx), diff: d });
    }
    return { status: "applied", runId: undoRunId, undone: [...undone], conflicts };
  });
}
