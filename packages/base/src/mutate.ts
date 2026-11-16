import { createHash } from "node:crypto";

import {
  areaClass,
  deepEqual,
  findClash,
  isRelationPath,
  isUlid,
  NoteParseError,
  normalizePath,
  parseManifest,
  parseNote,
  patch,
  PatchError,
  PathError,
  pathKey,
  relationTo,
  resolveFile,
  resolveRelation,
  splitNote,
  ulid,
  validate,
  type Diff,
  type Issue,
  type Path,
  type PatchOp,
  type PlanItem,
  type YamlValue,
} from "@brainiac/core";

import {
  pend,
  planOf,
  relationTarget,
  settle,
  type Effect,
  type Grant,
  type NeedsApproval,
  type Unsigned,
} from "./approvals.ts";
import { canSee, principalOf, type Connection } from "./connections.ts";
import { PERSON, project, type Principal } from "./project.ts";
import { diff, side, stateOf, type State } from "./diff.ts";
import { DAY_MS, holds, manifestOf, recordHeld, type Action, type Proposed } from "./hold.ts";
import { enqueue } from "./jobs.ts";
import { getNote, putNote, type NoteClass, type NoteRow } from "./notes.ts";
import { changeTypes, brokenNotes, revertTypes, type TypeChange } from "./organize.ts";
import { chunkNote, putChunks } from "./search.ts";
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
  /**
   * What the sender may read, for a sync edit (which carries no connection): it decides only what an answer may
   * say about notes the sender can't see, never the level or the hold.
   */
  readonly reader?: Principal;
  /**
   * For a sync edit: the socket speaks for a read-level connection, so the record refuses every change it sends.
   * Propose and write connections' file edits sync as unattributed ones, with no hold (contract §3).
   */
  readonly readOnly?: boolean;
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
  | { readonly op: "delete"; readonly noteId: string; readonly baseRev: number }
  /**
   * Sets a note's privacy class. Making it sensitive takes it out of the normal index in this transaction;
   * making it normal loosens privacy, which needs its own passkey signature (contract §4).
   */
  | { readonly op: "classify"; readonly noteId: string; readonly baseRev: number; readonly class: NoteClass }
  /**
   * Moves a note to `path`. Its own relative relations and body links, and every live note's that names it, are
   * rewritten in the same run so each still points where it did; a sidecar's file moves with it (`fileMove`).
   */
  | { readonly op: "move"; readonly noteId: string; readonly baseRev: number; readonly path: string };

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
  readonly verdict: Unsigned | Invalid | { readonly autoApplyAt: number | null; readonly effects: Effect[] };
  constructor(verdict: Held["verdict"]) {
    super("held");
    this.verdict = verdict;
  }
}

const supersedesOf = (note: NoteRow | undefined): unknown =>
  note && note.deletedAt === null ? JSON.parse(note.fm)["supersedes"] : undefined;

/**
 * Whether an effect adds, redirects or removes a `supersedes` edge whose target `reader` can't see. For a reader
 * that can't see every note (no sensitive scope, or a type scope) a missing target counts too, so a hidden note there and none get the same answer,
 * never one that says the hidden note is verified or of a held type.
 */
function blindEdge(sql: Sql, reader: Principal, { before, after }: Effect): boolean {
  const was = supersedesOf(before);
  const is = supersedesOf(after);
  if (deepEqual(was, is) && before?.path === after.path) return false;
  const blind = (from: NoteRow | undefined, relation: unknown) => {
    if (relation === undefined) return false;
    const target = relationTarget(sql, from, relation);
    // A reader that can't see every note can't tell a hidden target from a missing one, so both are blind to it.
    return target ? !project(target, reader) : !reader.sensitive || reader.types !== undefined;
  };
  return blind(before, was) || blind(after, is);
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
  scope: "change" | "undo" | "organize",
  action: Action,
  released: readonly PlanItem[] | undefined,
  fn: (started: Started) => T,
  /** What `fn` did besides notes, read once it's done: a manifest change, which the plan signs too. */
  extra: () => readonly PlanItem[] = () => [],
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
              {
                field: "proposal",
                message:
                  "The record changed since this was held. Reject it, and make the change again if it's still wanted.",
              },
            ],
          });
        const reader = connection ? principalOf(connection) : (ctx.reader ?? PERSON);
        if (reader !== PERSON && effects.some((effect) => blindEdge(sql, reader, effect)))
          throw new Held({
            status: "invalid",
            issues: [
              { field: "supersedes", message: "supersedes must name a note this connection can see." },
            ],
          });
        const verdict = settle(sql, effects, ctx, scope, extra());
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
      // The plan is kept for the person to sign on the site, wherever the change came from.
      if ("status" in error.verdict)
        return error.verdict.status === "needsApproval"
          ? pend(sql, error.verdict, ctx.actor, ctx.now)
          : error.verdict;
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

/** The normal Question notes whose `about` names `note`, deleted ones too: a restore brings back their values. */
const questionsAbout = (sql: Sql, note: NoteRow) =>
  sql
    .all<NoteRow>(`SELECT * FROM notes WHERE type = 'Question' AND class = 'normal'`)
    .filter((question) => relationTarget(sql, question, JSON.parse(question.fm)["about"])?.id === note.id);

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

/**
 * Front-matter checks every write passes: an unchanged ULID id, and the manifest's types when there is one (the
 * record's latest, or `manifest` when given).
 */
function check(
  sql: Sql,
  raw: string,
  id?: string,
  manifest?: string,
): Issue[] | Readonly<Record<string, unknown>> {
  let data: Readonly<Record<string, unknown>>;
  try {
    data = parseNote(raw).data;
  } catch (error) {
    if (error instanceof NoteParseError) return [{ field: "front-matter", message: error.message }];
    throw error;
  }
  if (id !== undefined && data["id"] !== id) return [{ field: "id", message: "A note's id never changes." }];
  const [schema] =
    manifest === undefined
      ? sql.all<{ manifest: string }>("SELECT manifest FROM schema ORDER BY version DESC LIMIT 1")
      : [{ manifest }];
  // shortcut: the manifest is parsed per write; cache it in the DO when profiles show it.
  const issues = schema
    ? validate(parseManifest(schema.manifest), data)
    : typeof data["id"] === "string" && isUlid(data["id"])
      ? []
      : [{ field: "id", message: "id must be a ULID. Example: id: 01JD7QA1ZK8M3V5X6Y7Z8A9BCD" }];
  return issues.length > 0 ? issues : data;
}

type Op = "create" | "update" | "delete" | "restore" | "classify" | "move";

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
  // A sidecar's file goes where its note goes; callers refuse a move whose file would land on another.
  const file = prev && prev.path !== next.path ? fileMove(sql, prev, next.path) : undefined;
  if (file === "taken") throw new Error(`${next.path}: its file's place is taken.`);
  if (file) sql.all("UPDATE files SET path = ? WHERE path = ?", file.to, file.from);
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
  // A deleted note, or one whose class changed, leaves the search index in this transaction, before any job
  // runs, so it never matches in the family it left. A live one whose class changed is keyword-indexed in its new
  // family at once, so a search finds it there before its job brings the vectors; every live one gets a job.
  if (next.deletedAt !== null) putChunks(sql, next.id, rev, []);
  else if (prev && prev.class !== next.class) putChunks(sql, next.id, rev, stored ? chunkNote(stored) : []);
  if (next.deletedAt === null) enqueue(sql, "index", next.id, rev);
  else sql.all("DELETE FROM jobs WHERE noteId = ?", next.id);
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

/** A bulk update that applied: every note it changed, in one run. */
export interface BatchApplied {
  readonly status: "applied";
  readonly runId: string;
  readonly notes: readonly { readonly noteId: string; readonly rev: number }[];
}

export type BatchResult = BatchApplied | Exclude<MutationResult, { readonly status: "applied" }>;

/** Thrown to roll back a whole batch when one of its mutations can't apply. */
class Refused extends Error {
  readonly result: Exclude<MutationResult, { readonly status: "applied" }>;
  constructor(result: Refused["result"]) {
    super("refused");
    this.result = result;
  }
}

/**
 * Applies `mutations` as one change: one transaction and one run, judged as a whole, so a bulk update meets the
 * approval list and the hold once for everything it does. If any of them can't apply, none does.
 */
export function mutateAll(sql: Sql, mutations: readonly Mutation[], ctx: Context): BatchResult {
  return batch(sql, mutations, { ...ctx, runId: ctx.runId ?? ulid(ctx.now) }, undefined);
}

/**
 * Applies a released bulk proposal, only if it still does exactly what was held. A note that moved on since makes
 * the whole batch wait for the person: replaying part of it would do what nobody saw.
 */
export function releaseBatch(
  sql: Sql,
  mutations: readonly Mutation[],
  plan: readonly PlanItem[],
  ctx: Context,
): BatchResult {
  const result = batch(sql, mutations, { ...ctx, runId: ctx.runId ?? ulid(ctx.now) }, plan);
  if (result.status !== "conflict") return result;
  return {
    status: "invalid",
    issues: [{ field: "proposal", message: "A note in this change changed since it was held. Reject it." }],
  };
}

function batch(
  sql: Sql,
  mutations: readonly Mutation[],
  ctx: Context & { readonly runId: string },
  released: readonly PlanItem[] | undefined,
): BatchResult {
  try {
    return judged(sql, ctx, "change", { op: "batch", mutations }, released, (started): BatchApplied => {
      const notes = mutations.map((mutation) => {
        const result = applyOne(sql, started, mutation, ctx);
        if (result.status !== "applied") throw new Refused(result);
        return { noteId: result.noteId, rev: result.rev };
      });
      return { status: "applied", runId: ctx.runId, notes };
    });
  } catch (error) {
    if (error instanceof Refused) return error.result;
    throw error;
  }
}

/** One note an organize run places: its edits (a new type, fields), then a move, as of `rev`. */
export interface Placement {
  readonly noteId: string;
  readonly rev: number;
  readonly ops: readonly PatchOp[];
  readonly path?: string;
}

export interface Organized {
  readonly status: "applied";
  readonly runId: string;
  readonly notes: readonly { readonly noteId: string; readonly rev: number }[];
  /** The types the run added or changed. */
  readonly types: readonly string[];
}

/**
 * An organize run (contract §4): the type changes first, then each note's edits and move, as one run and one plan
 * the person signs whole, manifest included, so it applies only with an approval of exactly this. A note placed in
 * a sensitive area becomes sensitive in the run (core `areaClass`); the run never leaves a note failing its type.
 * Propose-level connections can't organize: there is no plan to propose short of the person signing it.
 */
export function organizeRun(
  sql: Sql,
  plan: { readonly types: readonly TypeChange[]; readonly notes: readonly Placement[] },
  ctx: Context,
):
  | Organized
  | NeedsApproval
  | Proposed
  | Forbidden
  | Invalid
  | Exclude<MutationResult, { status: "applied" }> {
  if (ctx.connection?.level === "propose")
    return { status: "forbidden", reason: "organize needs a write-level connection." };
  const run = { ...ctx, runId: ctx.runId ?? ulid(ctx.now) };
  let manifest: PlanItem | undefined;
  const action: Action = { op: "batch", mutations: [] };
  try {
    return judged(
      sql,
      run,
      "organize",
      action,
      undefined,
      (started): Organized => {
        const typed = changeTypes(sql, plan.types, run, run.runId);
        if ("issues" in typed) throw new Held({ status: "invalid", issues: typed.issues });
        manifest = typed.item;
        const step = (mutation: Mutation) => {
          const result = applyOne(sql, started, mutation, run);
          if (result.status !== "applied") throw new Refused(result);
          return result.rev;
        };
        const notes = plan.notes.map(({ noteId, rev, ops, path }) => {
          let at = ops.length > 0 ? step({ op: "patch", noteId, baseRev: rev, ops }) : rev;
          if (path !== undefined) at = step({ op: "move", noteId, baseRev: at, path });
          const note = getNote(sql, noteId);
          if (note && note.class === "normal" && areaClass(note.path) === "sensitive")
            at = step({ op: "classify", noteId, baseRev: at, class: "sensitive" });
          return { noteId, rev: at };
        });
        const broken = brokenNotes(sql, typed, run.connection);
        if (broken.length > 0) throw new Held({ status: "invalid", issues: broken });
        return { status: "applied", runId: run.runId, notes, types: typed.types };
      },
      () => (manifest ? [manifest] : []),
    );
  } catch (error) {
    if (error instanceof Refused) return error.result;
    throw error;
  }
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
    // Never names the other note: it may be one the caller can't see, and a sync edit carries no connection.
    if (clash !== undefined) return invalid("path", `${path} is taken.`);
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
  if (mutation.op === "classify") {
    if (mutation.class === note.class)
      return { status: "applied", noteId: note.id, rev: note.rev, seq: note.seq, runId };
    // Loosening is judged with the rest of the transaction's effect (approvals.ts).
    const result = write(sql, started, ctx, runId, note, { ...note, class: mutation.class }, "classify");
    // A question about a note holds its values (`was`, `suggested`, `answer`), so it is as private as the note.
    if (mutation.class === "sensitive")
      for (const question of questionsAbout(sql, note))
        write(sql, started, ctx, runId, question, { ...question, class: "sensitive" }, "classify");
    return result;
  }
  if (mutation.op === "move") return move(sql, started, ctx, runId, note, mutation.path);

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
  if (taken !== undefined) return invalid("path", `${note.path} is taken since this note was deleted.`);
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

/**
 * Moves `note` to `to`, in one run: the note with its own relations rewritten for its new folder, then every live
 * note that names it, so no relation or body link ends up pointing elsewhere. A clash, or a sidecar whose file
 * would land on another file, moves nothing.
 */
function move(
  sql: Sql,
  started: Started,
  ctx: Context,
  runId: string,
  note: NoteRow,
  to: string,
): MutationResult {
  let path: string;
  try {
    path = normalizePath(to);
  } catch (error) {
    if (error instanceof PathError) return invalid("path", error.message);
    throw error;
  }
  if (!path.toLowerCase().endsWith(".md")) return invalid("path", `A note's path ends in .md (was ${to}).`);
  if (path === note.path) return { status: "applied", noteId: note.id, rev: note.rev, seq: note.seq, runId };
  // Only a change of case or Unicode form leaves a note's own path as the clash.
  const others = livePaths(sql).filter((p) => pathKey(p) !== pathKey(note.path));
  if (findClash(others, path) !== undefined) return invalid("path", `${path} is taken.`);
  if (fileMove(sql, note, path) === "taken")
    return invalid(
      "path",
      `This note's file would move beside it, onto a file already there. Pick another folder.`,
    );
  const live = new Set(others.map(pathKey));
  const raw = movedText(note.raw, note.path, path, live);
  const data = check(sql, raw, note.id);
  if (Array.isArray(data)) return { status: "invalid", issues: data };
  const referrers = namers(sql, note)
    .map((referrer) => ({ referrer, text: renamedIn(referrer.raw, referrer.path, note.path, path) }))
    // A relation is checked only as text, so a rewrite can't leave its note failing its type; checked anyway.
    .filter(({ referrer, text }) => text !== referrer.raw && !Array.isArray(check(sql, text, referrer.id)));
  // A connection never rewrites a note it can't see: the change, or the approval it needs, would show it.
  if (referrers.some(({ referrer }) => !canSee(ctx.connection, referrer)))
    return invalid("path", "Notes you can't see link to this note, so only the person can move it.");
  const moved = write(sql, started, ctx, runId, note, { ...note, path, raw }, "move");
  for (const { referrer, text } of referrers)
    write(sql, started, ctx, runId, referrer, { ...referrer, raw: text }, "update");
  return moved;
}

/**
 * Where a sidecar's file goes when the note moves to `to`: the path its unchanged `file:` resolves to from there,
 * so `file: files/x.jpg` keeps its file beside it in any folder. `taken` when another stored file is there;
 * `undefined` for a note that names no stored file.
 */
function fileMove(
  sql: Sql,
  note: Pick<NoteRow, "path" | "fm">,
  to: string,
): { readonly from: string; readonly to: string } | "taken" | undefined {
  const file: unknown = JSON.parse(note.fm)["file"];
  if (typeof file !== "string") return undefined;
  let from: string;
  let dest: string;
  try {
    from = pathKey(resolveFile(note.path, file));
    dest = resolveFile(to, file);
  } catch (error) {
    if (error instanceof PathError) return undefined;
    throw error;
  }
  const paths = sql.all<{ path: string }>("SELECT path FROM files WHERE path IS NOT NULL").map((f) => f.path);
  const stored = paths.find((p) => pathKey(p) === from);
  if (stored === undefined) return undefined;
  if (paths.some((p) => p !== stored && pathKey(p) === pathKey(dest))) return "taken";
  return { from: stored, to: dest };
}

/** Front-matter keys a move never rewrites: the id, and `file:`, whose file moves with its note. */
const UNMOVED = new Set(["id", "file"]);

/** Every relation-like text value in front-matter (a relative `.md` path), with where it sits. */
function relationsIn(value: unknown, at: readonly (string | number)[]): { at: Path; value: string }[] {
  if (typeof value === "string") return isRelationPath(value) ? [{ at, value }] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => relationsIn(item, [...at, i]));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap(([key, item]) =>
      at.length === 0 && UNMOVED.has(key) ? [] : relationsIn(item, [...at, key]),
    );
  return [];
}

/** A body link to a note, `[text](../people/dr-okafor.md)`, with an optional `#heading` (as search reads them). */
const LINK = /(\]\(<?)([^()<>\s]+?\.md)((?:#[^()<>\s]*)?>?\))/g;

const resolved = (from: string, relation: string): string | undefined => {
  try {
    return resolveRelation(from, relation);
  } catch (error) {
    if (error instanceof PathError) return undefined;
    throw error;
  }
};

/** A link's path with `%20` and the like decoded, as Obsidian writes a space; one that doesn't decode, as it is. */
const decoded = (link: string) => {
  try {
    return decodeURIComponent(link);
  } catch {
    return link;
  }
};

/**
 * `raw` with each relative relation and body link that `retarget` maps to a new target rewritten from `from` (where
 * the note is) to point there. Values only, through `patch`, so the rest of the text is untouched.
 */
function rewritten(raw: string, from: string, retarget: (target: string) => string | undefined): string {
  const { data } = parseNote(raw);
  const ops: PatchOp[] = relationsIn(data, []).flatMap(({ at, value }) => {
    const target = resolved(from, value);
    const next = target === undefined ? undefined : retarget(target);
    return next === undefined ? [] : [{ op: "set", path: at, value: next }];
  });
  const text = ops.length > 0 ? patch(raw, ops) : raw;
  const start = splitNote(text).bodyStart;
  const body = text.slice(start).replace(LINK, (link, open: string, path: string, close: string) => {
    const target = resolved(from, decoded(path));
    const next = target === undefined ? undefined : retarget(target);
    if (next === undefined) return link;
    // Encoded as the link was, and always when the new path has a space a link can't hold as it is.
    return `${open}${decoded(path) === path && !/\s/.test(next) ? next : encodeURI(next)}${close}`;
  });
  return text.slice(0, start) + body;
}

/**
 * A note's text once it moves from `from` to `to`: its relations and links to live notes (`live`, by `pathKey`)
 * and to itself still reach them. Text that names no note (a `.md` filename in a title) is left as it is.
 */
function movedText(raw: string, from: string, to: string, live: ReadonlySet<string>): string {
  const self = pathKey(from);
  return rewritten(raw, from, (target) => {
    const key = pathKey(target);
    if (key === self) return relationTo(to, to);
    return live.has(key) ? relationTo(to, target) : undefined;
  });
}

/** A note's text once the note at `from` moves to `to`: what named it names it at `to`. */
const renamedIn = (raw: string, at: string, from: string, to: string): string =>
  rewritten(raw, at, (target) => (pathKey(target) === pathKey(from) ? relationTo(at, to) : undefined));

/**
 * The live notes besides `note` whose relations or body links could name it: a relative one ends with its file
 * name, as written or as a link encodes it. A relation by id needs no rewriting.
 */
function namers(sql: Sql, note: NoteRow): NoteRow[] {
  const name = (note.path.split("/").at(-1) ?? note.path).toLowerCase();
  const forms = [name, encodeURI(name).toLowerCase()];
  return sql
    .all<NoteRow>("SELECT * FROM notes WHERE deletedAt IS NULL AND id != ? ORDER BY path", note.id)
    .filter((row) => {
      const text = row.raw.normalize("NFC").toLowerCase();
      return forms.some((form) => text.includes(form));
    });
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

/**
 * The first move in a run that can't go back whole, if any: the note must still be live where the run put it, and
 * its old place (and its file's) free. A move goes back with the links the run rewrote to follow it, or none of it
 * does, so links never point at a place the note isn't.
 */
function movesBack(
  sql: Sql,
  revisions: readonly { readonly noteId: string; readonly patch: string }[],
): { readonly before: string; readonly after: string } | undefined {
  for (const revision of revisions) {
    const { path } = JSON.parse(revision.patch) as Diff;
    if (!path) continue;
    const note = getNote(sql, revision.noteId);
    const back =
      note?.deletedAt === null &&
      note.path === path.after &&
      findClash(
        livePaths(sql).filter((p) => pathKey(p) !== pathKey(note.path)),
        path.before,
      ) === undefined &&
      fileMove(sql, note, path.before) !== "taken";
    if (!back) return path;
  }
  return undefined;
}

const livePaths = (sql: Sql) =>
  sql.all<{ path: string }>("SELECT path FROM notes WHERE deletedAt IS NULL").map((row) => row.path);

/**
 * Undoes every change a run made by applying the inverse patch of each of its revisions, newest first
 * across the whole run, so a later edit by anyone else is never rolled back with it. Values go back as
 * values, so a restored number is written in YAML's canonical form (`8.0` comes back as `8`). What can't go
 * back becomes a conflict proposal and the note keeps its current value: a field edited since, a note the
 * run created and someone edited since, a deleted note whose path is taken, a note deleted since, or an
 * undo that would leave the note failing its type. A class goes back only while the note is live and still
 * has the one the run gave it; putting a note back to normal loosens privacy, so that undo needs a signature.
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
  let manifest: PlanItem | undefined;
  return judged(
    sql,
    undo,
    "undo",
    action,
    released,
    (started): UndoResult | Forbidden | Invalid => {
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
      const stuck = movesBack(sql, revisions);
      if (stuck)
        return {
          status: "invalid",
          issues: [
            {
              field: "run",
              message: `Nothing was undone: this run moved a note to ${stuck.after}, and it can't go back to ${stuck.before} now (that place is taken, or the note moved or was deleted since).`,
            },
          ],
        };
      // The run's types go back first, so its notes go back to what their types were. Each step may still meet the
      // types as the run left them (a note leaving a type the run added), and every note of a type it changed must
      // meet the restored one at the end.
      const [left] = sql.all<{ manifest: string }>(
        "SELECT manifest FROM schema ORDER BY version DESC LIMIT 1",
      );
      const typed = revertTypes(sql, runId, undo, undoRunId);
      if ("issues" in typed) throw new Held({ status: "invalid", issues: typed.issues });
      manifest = typed.item;
      const fails = (raw: string, id: string) =>
        Array.isArray(check(sql, raw, id)) &&
        (!typed.item || !left || Array.isArray(check(sql, raw, id, left.manifest)));
      const undone = new Set<string>();
      // Notes the run created or restored: undoing deletes them, so their class stays as it is (a sensitive one
      // stays so, never a normal tombstone made from it).
      const created = new Set(
        revisions.filter((r) => (JSON.parse(r.patch) as Diff).live?.before === false).map((r) => r.noteId),
      );
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

        // A class change (it is a revision of its own): a class set since is newer intent, and stays.
        if (d.class) {
          if (now.live && note.class === d.class.after && !created.has(note.id)) {
            write(sql, started, undo, undoRunId, note, { ...note, class: d.class.before }, "classify");
            undone.add(note.id);
          }
          continue;
        }

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
        // A move always goes back: `movesBack` checked before anything was undone.
        const path = d.path ? d.path.before : note.path;
        const bodyClash = d.body && (held?.body !== undefined || now.body !== d.body.after);
        if (d.body && !bodyClash) raw = raw.slice(0, splitNote(raw).bodyStart) + (d.body.before ?? "");
        // Part of an undo can leave a note failing its type (a required field removed while the field that made
        // it required stays): the whole step's values then wait for the person instead.
        const failing = raw !== note.raw && fails(raw, note.id);
        if (failing) {
          hold(note.id, inverseFrom(now, d));
          raw = note.raw;
        }
        if (raw !== note.raw || path !== note.path) {
          write(
            sql,
            started,
            undo,
            undoRunId,
            note,
            { ...note, raw, path },
            path !== note.path ? "move" : "update",
          );
          undone.add(note.id);
        }
        if (failing) continue;
        const body = bodyClash ? { before: now.body, after: d.body?.before ?? "" } : undefined;
        if (Object.keys(clash.fields).length > 0 || body) hold(note.id, { ...clash, ...(body && { body }) });
      }

      const broken = brokenNotes(sql, typed, ctx.connection);
      if (broken.length > 0) throw new Held({ status: "invalid", issues: broken });

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
    },
    () => (manifest ? [manifest] : []),
  );
}
