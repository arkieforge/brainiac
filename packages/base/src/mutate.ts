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
  type Issue,
  type PatchOp,
  type YamlValue,
} from "@brainiac/core";

import { enqueue } from "./jobs.ts";
import { getNote, putNote, type NoteClass, type NoteRow } from "./notes.ts";
import { putChunks } from "./search.ts";
import type { Sql } from "./sql.ts";

/** Who is changing the record, and when. Every mutation belongs to a run, so it can be undone with its run. */
export interface Context {
  /** For example `human` or `connection:<id>`; recorded on the revision and the change. */
  readonly actor: string;
  /** Groups the changes an agent or `organize` made together; a mutation without one is its own run. */
  readonly runId?: string;
  readonly now: number;
  /** The sync client's id for this change, recorded on the feed entry it makes. */
  readonly changeId?: string;
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
  | { readonly status: "invalid"; readonly issues: readonly Issue[] };

interface Change<T> {
  readonly before?: T;
  readonly after?: T;
}

/**
 * What one revision changed, stored on it as its inverse patch: each top-level front-matter field's value
 * before and after (a missing side means the field was absent), the body, and whether the note was live.
 */
export interface Diff {
  readonly fields: Readonly<Record<string, Change<unknown>>>;
  readonly body?: Change<string>;
  readonly live?: Change<boolean>;
}

interface State {
  readonly data: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly live: boolean;
}

const NOTHING: State = { data: {}, body: "", live: false };

const stateOf = (note: Pick<NoteRow, "raw" | "fm" | "deletedAt"> | undefined): State =>
  note
    ? { data: JSON.parse(note.fm), body: splitNote(note.raw).body, live: note.deletedAt === null }
    : NOTHING;

const side = <K extends "before" | "after", T>(key: K, has: boolean, value: T) =>
  (has ? { [key]: value } : {}) as Partial<Record<K, T>>;

function diff(before: State, after: State): Diff {
  const fields: Record<string, Change<unknown>> = {};
  for (const key of new Set([...Object.keys(before.data), ...Object.keys(after.data)])) {
    const had = Object.hasOwn(before.data, key);
    const has = Object.hasOwn(after.data, key);
    if (had === has && deepEqual(before.data[key], after.data[key])) continue;
    fields[key] = { ...side("before", had, before.data[key]), ...side("after", has, after.data[key]) };
  }
  return {
    fields,
    ...(before.body !== after.body && { body: { before: before.body, after: after.body } }),
    ...(before.live !== after.live && { live: { before: before.live, after: after.live } }),
  };
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
  ctx: Context,
  runId: string,
  prev: NoteRow | undefined,
  next: Pick<NoteRow, "id" | "path" | "raw" | "class" | "deletedAt">,
  op: Op,
): Extract<MutationResult, { status: "applied" }> {
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
    "INSERT INTO changes (seq, noteId, rev, op, actor, at, changeId) VALUES (?, ?, ?, ?, ?, ?, ?)",
    seq,
    next.id,
    rev,
    op,
    ctx.actor,
    ctx.now,
    ctx.changeId ?? null,
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
 * The one way a note changes: read its revision, validate, write, enqueue follow-up jobs, commit, all in
 * one transaction with no I/O, so the DO never interleaves another request inside it.
 */
export function mutate(sql: Sql, mutation: Mutation, ctx: Context): MutationResult {
  return sql.transaction(() => applyMutation(sql, mutation, ctx));
}

/** `mutate` inside the caller's transaction, for the sync handler, which records the client's result in it too. */
export function applyMutation(sql: Sql, mutation: Mutation, ctx: Context): MutationResult {
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
    const live = sql.all<{ path: string }>("SELECT path FROM notes WHERE deletedAt IS NULL");
    const clash = findClash(
      live.map((row) => row.path),
      path,
    );
    if (clash !== undefined) return invalid("path", `${path} clashes with ${clash}.`);
    return write(
      sql,
      ctx,
      runId,
      undefined,
      { id, path, raw: mutation.raw, class: mutation.class, deletedAt: null },
      "create",
    );
  }

  const note = getNote(sql, mutation.noteId);
  const deleted = note?.deletedAt !== null;
  if (!note || (deleted && mutation.op !== "put")) {
    return invalid("noteId", `No note with id ${mutation.noteId}.`);
  }
  if (note.rev !== mutation.baseRev) return { status: "conflict", noteId: note.id, rev: note.rev };
  if (mutation.op === "delete")
    return write(sql, ctx, runId, note, { ...note, deletedAt: ctx.now }, "delete");

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
  if (taken !== undefined)
    return invalid("path", `${note.path} is taken by ${taken} since this note was deleted.`);
  return write(sql, ctx, runId, note, { ...note, raw, deletedAt: null }, deleted ? "restore" : "update");
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
export function undoRun(sql: Sql, runId: string, ctx: Context): UndoResult {
  // An undo is a run of its own, so it can be undone too; never inside the run it undoes.
  const undoRunId = ctx.runId !== undefined && ctx.runId !== runId ? ctx.runId : ulid(ctx.now);
  const undo = { ...ctx, runId: undoRunId };
  return sql.transaction(() => {
    // shortcut: revisions expire one by one after 30 days, so a run older than that undoes only its newer
    // part; keep whole runs if people undo month-old runs.
    const revisions = sql.all<{ noteId: string; patch: string; raw: string }>(
      `SELECT revisions.noteId, revisions.patch, revisions.raw FROM revisions
       JOIN changes ON changes.noteId = revisions.noteId AND changes.rev = revisions.rev
       WHERE revisions.runId = ? ORDER BY changes.seq DESC`,
      runId,
    );
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
          write(sql, undo, undoRunId, note, { ...note, deletedAt: ctx.now }, "delete");
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
          write(sql, undo, undoRunId, note, { ...note, deletedAt: null }, "restore");
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
        write(sql, undo, undoRunId, note, { ...note, raw }, "update");
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
    return { runId: undoRunId, undone: [...undone], conflicts };
  });
}
