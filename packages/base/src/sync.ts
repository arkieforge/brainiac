import { createHash } from "node:crypto";

import {
  merge,
  NoteParseError,
  parseNote,
  type ClientMessage,
  type Hello,
  type Mutate,
  type NoteState,
  type Result,
  type ServerMessage,
} from "@brainiac/core";

import { applyMutation, propose, type Context, type Diff, type MutationResult } from "./mutate.ts";
import { getNote, type NoteRow } from "./notes.ts";
import type { Sql } from "./sql.ts";

// The record's side of the sync protocol (docs/internals/sync-engine.md). The DO decodes each message and
// hands it to `serve`; tests drive the same function with simulated clients.

interface ClientRow {
  readonly highWater: number;
  readonly ackedUpTo: number;
}

/** The last `seq` the record assigned; 0 before its first change. */
export function currentSeq(sql: Sql): number {
  const [row] = sql.all<{ value: string }>("SELECT value FROM meta WHERE key = 'seq'");
  return row ? Number(row.value) : 0;
}

const stateOf = (note: NoteRow): NoteState =>
  note.deletedAt === null
    ? {
        noteId: note.id,
        seq: note.seq,
        deleted: false,
        rev: note.rev,
        path: note.path,
        raw: note.raw,
        class: note.class,
      }
    : { noteId: note.id, seq: note.seq, deleted: true };

/**
 * Each note changed after `cursor`, as it is now, or a snapshot when the feed no longer reaches back that far
 * (or the cursor is ahead of the record, as after a restore). Notes purged since come as deleted.
 * shortcut: every class is sent; #14 projects sensitive notes away from devices not marked as the person's.
 */
export function changesSince(sql: Sql, cursor: number | null): ServerMessage {
  const seq = currentSeq(sql);
  const [oldest] = sql.all<{ seq: number | null }>("SELECT min(seq) AS seq FROM changes");
  const reaches =
    cursor !== null && cursor <= seq && (cursor === seq || (oldest?.seq ?? Infinity) <= cursor + 1);
  if (!reaches) {
    const notes = sql.all<NoteRow>("SELECT * FROM notes WHERE deletedAt IS NULL ORDER BY seq");
    return { type: "snapshot", seq, notes: notes.map(stateOf) };
  }
  const notes = sql.all<NoteRow>("SELECT * FROM notes WHERE seq > ? ORDER BY seq", cursor);
  const purged = sql.all<{ noteId: string; seq: number }>(
    `SELECT noteId, max(seq) AS seq FROM changes
     WHERE seq > ? AND noteId NOT IN (SELECT id FROM notes) GROUP BY noteId`,
    cursor,
  );
  const items = [...notes.map(stateOf), ...purged.map((row) => ({ ...row, deleted: true as const }))];
  return { type: "changes", from: cursor, to: seq, items };
}

/** Forgets results the client has stored, and remembers how far it has acknowledged. */
function acknowledge(sql: Sql, clientId: string, ackedUpTo: number): void {
  sql.all("UPDATE clients SET ackedUpTo = max(ackedUpTo, ?) WHERE clientId = ?", ackedUpTo, clientId);
  sql.all("DELETE FROM results WHERE clientId = ? AND clientSeq <= ?", clientId, ackedUpTo);
}

const reset = (message: Mutate, reason: string): ServerMessage => ({
  type: "reset",
  clientId: message.clientId,
  clientSeq: message.clientSeq,
  reason,
});

/**
 * A client (re)connects: it gets its high-water mark and how far it has acknowledged (so a restored backup
 * or a copy can tell it is behind and repair), every result it hasn't acknowledged, and what changed since
 * its cursor. The record never resets on hello: a late hello carries old counters, and only the client
 * knows its current ones.
 */
export function hello(sql: Sql, message: Hello, now: number): ServerMessage[] {
  return sql.transaction(() => {
    sql.all(
      `INSERT INTO clients (clientId, lastSeenAt, appVersion) VALUES (?, ?, ?)
       ON CONFLICT (clientId) DO UPDATE SET lastSeenAt = excluded.lastSeenAt, appVersion = excluded.appVersion`,
      message.clientId,
      now,
      message.appVersion,
    );
    acknowledge(sql, message.clientId, message.ackedUpTo);
    const [client] = sql.all<ClientRow>("SELECT * FROM clients WHERE clientId = ?", message.clientId);
    const results = sql.all<{ result: string }>(
      "SELECT result FROM results WHERE clientId = ? ORDER BY clientSeq",
      message.clientId,
    );
    return [
      {
        type: "welcome",
        clientId: message.clientId,
        highWater: client?.highWater ?? 0,
        ackedUpTo: client?.ackedUpTo ?? 0,
      },
      changesSince(sql, message.cursor),
      ...results.map((row): ServerMessage => JSON.parse(row.result)),
    ];
  });
}

/**
 * One mutation from a client, applied exactly once and in order: only `highWater + 1` is applied, and its
 * result is stored with a digest of the mutation until the client acknowledges it. A repeat with the same
 * digest gets the stored result; a different mutation under a used number, or one already acknowledged,
 * means two machines share the id: the reply is a reset, which the copy still holding that change acts on. Every result, refused or not, uses up its number.
 */
export function receive(sql: Sql, message: Mutate, ctx: Context): ServerMessage {
  const digest = createHash("sha256")
    .update(JSON.stringify([message.noteId, message.baseRev, message.change]))
    .digest("hex");
  return sql.transaction(() => {
    sql.all("INSERT OR IGNORE INTO clients (clientId) VALUES (?)", message.clientId);
    const [client] = sql.all<ClientRow>("SELECT * FROM clients WHERE clientId = ?", message.clientId);
    // A late message carries an older ackedUpTo, so only one past the high-water mark gives a copy away.
    if (!client || message.ackedUpTo > client.highWater) {
      return reset(message, "This copy is ahead of what the record has seen from it.");
    }
    acknowledge(sql, message.clientId, message.ackedUpTo);
    if (message.clientSeq <= client.highWater) {
      const [stored] = sql.all<{ digest: string; result: string }>(
        "SELECT digest, result FROM results WHERE clientId = ? AND clientSeq = ?",
        message.clientId,
        message.clientSeq,
      );
      if (stored?.digest === digest) return JSON.parse(stored.result);
      return reset(message, "Another device is using this client id.");
    }
    if (message.clientSeq > client.highWater + 1) {
      return { type: "gap", clientId: message.clientId, highWater: client.highWater };
    }
    const result = apply(sql, message, ctx);
    sql.all("UPDATE clients SET highWater = ? WHERE clientId = ?", message.clientSeq, message.clientId);
    sql.all(
      "INSERT INTO results (clientId, clientSeq, digest, result) VALUES (?, ?, ?, ?)",
      message.clientId,
      message.clientSeq,
      digest,
      JSON.stringify(result),
    );
    return result;
  });
}

const side = (data: Readonly<Record<string, unknown>>, key: string, name: "before" | "after") =>
  Object.hasOwn(data, key) ? { [name]: data[key] } : {};

/** Field values and body of one side of a conflict, as a proposal from `theirs` (kept) to `mine`. */
function conflictDiff(theirs: string, mine: string, fields: readonly string[], body: boolean): Diff {
  const t = parseNote(theirs);
  const m = parseNote(mine);
  return {
    fields: Object.fromEntries(
      fields.map((key) => [key, { ...side(t.data, key, "before"), ...side(m.data, key, "after") }]),
    ),
    ...(body && { body: { before: t.body, after: m.body } }),
  };
}

function parses(raw: string): boolean {
  try {
    parseNote(raw);
    return true;
  } catch (error) {
    if (error instanceof NoteParseError) return false;
    throw error;
  }
}

const refusal = (result: MutationResult) =>
  result.status === "invalid" ? result.issues.map((issue) => issue.message).join(" ") : "The note changed.";

/** Applies one client change under the merge rules: nothing is dropped silently. */
function apply(sql: Sql, message: Mutate, ctx: Context): Result {
  const { change, noteId } = message;
  const done = { type: "result", clientId: message.clientId, clientSeq: message.clientSeq } as const;
  const current = getNote(sql, noteId);

  if (change.kind === "create" && !current) {
    const id = parseNote(change.raw).data["id"];
    if (id !== noteId) return { ...done, ok: false, error: "The note's id must match noteId." };
    const created = applyMutation(
      sql,
      { op: "create", path: change.path, raw: change.raw, class: change.class },
      ctx,
    );
    return created.status === "applied"
      ? { ...done, ok: true, rev: created.rev }
      : { ...done, ok: false, error: refusal(created) };
  }
  if (!current) return { ...done, ok: false, error: `No note with id ${noteId}.` };

  if (change.kind === "delete") {
    if (current.deletedAt !== null) return { ...done, ok: true, rev: current.rev };
    // Edited since this client saw it: the note stays, and the delete waits for the person.
    if (current.raw !== change.base) {
      const proposalId = propose(sql, noteId, { fields: {}, live: { before: true, after: false } }, ctx);
      return { ...done, ok: false, conflict: { proposalId, fields: [], body: false, deleted: true } };
    }
    const deleted = applyMutation(sql, { op: "delete", noteId, baseRev: current.rev }, ctx);
    return { ...done, ok: true, rev: deleted.status === "applied" ? deleted.rev : current.rev };
  }

  // An edit, or a create for a note that exists (a client repairing): merge it into the current text. A
  // create has no base, so every field both sides set differently is a conflict.
  const mine = change.raw;
  try {
    parseNote(mine);
  } catch (error) {
    if (error instanceof NoteParseError) return { ...done, ok: false, error: error.message };
    throw error;
  }
  // A base that doesn't parse (the edit after a refused one starts from the broken text) counts as no base:
  // then every field the two sides set differently is a conflict, never an overwrite.
  const base = change.kind === "put" && parses(change.base) ? change.base : "";
  const merged = merge(base, mine, current.raw);
  const deleted = current.deletedAt !== null;
  // Edited here, deleted on the other side: the note comes back with the edit, and the delete becomes the
  // proposal.
  const written = applyMutation(sql, { op: "put", noteId, baseRev: current.rev, raw: merged.raw }, ctx);
  if (written.status !== "applied") {
    return { ...done, ok: false, error: refusal(written) };
  }
  if (merged.fields.length === 0 && !merged.body && !deleted) return { ...done, ok: true, rev: written.rev };
  const diff = conflictDiff(current.raw, mine, merged.fields, merged.body);
  const proposalId = propose(
    sql,
    noteId,
    deleted ? { ...diff, live: { before: true, after: false } } : diff,
    ctx,
  );
  return {
    ...done,
    ok: true,
    rev: written.rev,
    conflict: { proposalId, fields: merged.fields, body: merged.body, deleted },
  };
}

export interface Served {
  /** For the client that sent the message. */
  readonly replies: readonly ServerMessage[];
  /** For every connected client, when the message changed the record. */
  readonly push?: ServerMessage;
}

/** One decoded client message, end to end: what the transport sends back and what it pushes to everyone. */
export function serve(sql: Sql, message: ClientMessage, ctx: Context): Served {
  if (message.type === "hello") return { replies: hello(sql, message, ctx.now) };
  const before = currentSeq(sql);
  const reply = receive(sql, message, ctx);
  return { replies: [reply], ...(currentSeq(sql) > before && { push: changesSince(sql, before) }) };
}
