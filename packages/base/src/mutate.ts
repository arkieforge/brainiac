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
 * The one way a note changes: read its revision, validate, write, enqueue follow-up jobs, commit, all in
 * one transaction with no I/O, so the DO never interleaves another request inside it.
 */
export function mutate(sql: Sql, mutation: Mutation, ctx: Context): MutationResult {
  const runId = ctx.runId ?? ulid(ctx.now);
  return sql.transaction(() => {
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
    if (!note || note.deletedAt !== null) return invalid("noteId", `No note with id ${mutation.noteId}.`);
    if (note.rev !== mutation.baseRev) return { status: "conflict", noteId: note.id, rev: note.rev };
    if (mutation.op === "delete")
      return write(sql, ctx, runId, note, { ...note, deletedAt: ctx.now }, "delete");

    let raw: string;
    try {
      raw = patch(note.raw, mutation.ops);
    } catch (error) {
      if (error instanceof PatchError || error instanceof NoteParseError)
        return invalid("ops", error.message);
      throw error;
    }
    if (raw === note.raw) return { status: "applied", noteId: note.id, rev: note.rev, seq: note.seq, runId };
    const data = check(sql, raw, note.id);
    if (Array.isArray(data)) return { status: "invalid", issues: data };
    return write(sql, ctx, runId, note, { ...note, raw }, "update");
  });
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

/** Folds a note's diffs in one run, oldest first, into one: the earliest `before`, the latest `after`. */
function fold(diffs: readonly Diff[]): Diff {
  const fields: Record<string, Change<unknown>> = {};
  let body: Change<string> | undefined;
  let live: Change<boolean> | undefined;
  for (const d of diffs) {
    for (const [key, change] of Object.entries(d.fields)) {
      const first = fields[key] ?? change;
      fields[key] = {
        ...side("before", Object.hasOwn(first, "before"), first.before),
        ...side("after", Object.hasOwn(change, "after"), change.after),
      };
    }
    if (d.body) body = { before: (body ?? d.body).before ?? "", after: d.body.after ?? "" };
    if (d.live) live = { before: (live ?? d.live).before ?? false, after: d.live.after ?? false };
  }
  return { fields, ...(body && { body }), ...(live && { live }) };
}

/**
 * Undoes every change a run made, by applying the inverse patches stored on its revisions. Values go back
 * as values, so a restored number is written in YAML's canonical form (`8.0` comes back as `8`). A field edited
 * since the run is left as it is now and becomes a conflict proposal, as does a note created by the run and
 * edited since, or a deleted note whose path another note has taken.
 */
export function undoRun(sql: Sql, runId: string, ctx: Context): UndoResult {
  const undoRunId = ctx.runId ?? ulid(ctx.now);
  const undo = { ...ctx, runId: undoRunId };
  return sql.transaction(() => {
    const revisions = sql.all<{ noteId: string; rev: number; patch: string }>(
      "SELECT noteId, rev, patch FROM revisions WHERE runId = ? ORDER BY noteId, rev",
      runId,
    );
    const byNote = Map.groupBy(revisions, (revision) => revision.noteId);
    const undone: string[] = [];
    const conflicts: UndoConflict[] = [];
    const conflict = (noteId: string, d: Diff) => {
      const proposalId = ulid(ctx.now);
      sql.all(
        "INSERT INTO proposals (id, noteId, patch, actor, status, kind) VALUES (?, ?, ?, ?, 'open', 'conflict')",
        proposalId,
        noteId,
        JSON.stringify(d),
        ctx.actor,
      );
      conflicts.push({ noteId, proposalId, diff: d });
    };

    for (const [noteId, rows] of byNote) {
      const note = getNote(sql, noteId);
      if (!note) continue; // purged with its tombstone
      const run = fold(rows.map((row) => JSON.parse(row.patch)));
      const now = stateOf(note);
      const lastRev = rows.at(-1)?.rev ?? 0;

      // The run created it: undoing deletes it, unless someone edited it since.
      if (run.live?.before === false) {
        if (!now.live) continue;
        if (note.rev !== lastRev) conflict(noteId, { fields: {}, live: { before: true, after: false } });
        else {
          write(sql, undo, undoRunId, note, { ...note, deletedAt: ctx.now }, "delete");
          undone.push(noteId);
        }
        continue;
      }

      // The run deleted it: undoing restores it, if its path is still free.
      let restore = false;
      if (run.live?.before === true && !now.live) {
        const taken = sql.all<{ path: string }>("SELECT path FROM notes WHERE deletedAt IS NULL");
        if (
          findClash(
            taken.map((row) => row.path),
            note.path,
          ) !== undefined
        ) {
          conflict(noteId, { fields: {}, live: { before: false, after: true } });
          continue;
        }
        restore = true;
      } else if (!now.live) {
        // Deleted since the run by someone else: nothing to put the values back on.
        conflict(noteId, { fields: {}, live: { before: false, after: true } });
        continue;
      }

      const ops: PatchOp[] = [];
      const clash: Record<string, Change<unknown>> = {};
      for (const [key, change] of Object.entries(run.fields)) {
        const has = Object.hasOwn(now.data, key);
        const current = now.data[key];
        const atAfter = has === Object.hasOwn(change, "after") && deepEqual(current, change.after);
        const atBefore = has === Object.hasOwn(change, "before") && deepEqual(current, change.before);
        if (atBefore) continue;
        if (!atAfter) {
          clash[key] = {
            ...side("before", has, current),
            ...side("after", Object.hasOwn(change, "before"), change.before),
          };
          continue;
        }
        ops.push(
          Object.hasOwn(change, "before")
            ? { op: "set", path: [key], value: change.before as YamlValue }
            : { op: "unset", path: [key] },
        );
      }
      let raw = patch(note.raw, ops);
      let bodyClash: Change<string> | undefined;
      if (run.body && now.body !== run.body.before) {
        if (now.body === run.body.after)
          raw = raw.slice(0, splitNote(raw).bodyStart) + (run.body.before ?? "");
        else bodyClash = { before: now.body, after: run.body.before ?? "" };
      }
      if (Object.keys(clash).length > 0 || bodyClash) {
        conflict(noteId, { fields: clash, ...(bodyClash && { body: bodyClash }) });
      }
      if (raw !== note.raw || restore) {
        write(sql, undo, undoRunId, note, { ...note, raw, deletedAt: null }, restore ? "restore" : "update");
        undone.push(noteId);
      }
    }
    return { runId: undoRunId, undone, conflicts };
  });
}
