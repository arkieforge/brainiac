import { createHash } from "node:crypto";

import {
  merge,
  NoteParseError,
  parseNote,
  type ClientMessage,
  type Diff,
  type Hello,
  type Mutate,
  type NoteState,
  type Result,
  type ServerMessage,
} from "@brainiac/core";

import { mutate, propose, type Context, type MutationResult } from "./mutate.ts";
import { getNote, type NoteRow } from "./notes.ts";
import { project, type Principal } from "./project.ts";
import type { Sql } from "./sql.ts";

// The record's side of the sync protocol (docs/internals/sync-engine.md). The DO decodes each message and
// hands it to `serve`; tests drive the same function with simulated clients.

interface ClientRow {
  readonly highWater: number;
  readonly ackedUpTo: number;
  readonly reader: string | null;
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

/** A note `reader` may not see, by id alone: the device must drop it as it drops one that turned sensitive. */
const withheld = (note: Pick<NoteRow, "id" | "seq">): NoteState => ({
  noteId: note.id,
  seq: note.seq,
  deleted: true,
  withheld: true,
});

/**
 * Each note changed after `cursor`, as `reader` may see it now, or a snapshot when the feed no longer reaches
 * back that far (or the cursor is ahead of the record, as after a restore). Notes purged since come as
 * deleted. A note the reader may not see comes as withheld, in snapshots too (deleted ones included), so a
 * device drops one that turned sensitive while it was away, history and all; that is its id and when it
 * changes, never its path or text.
 */
export function changesSince(
  sql: Sql,
  cursor: number | null,
  reader: Principal,
  attempt: number | null = null,
): ServerMessage {
  const seq = currentSeq(sql);
  const [oldest] = sql.all<{ seq: number | null }>("SELECT min(seq) AS seq FROM changes");
  const reaches =
    cursor !== null && cursor <= seq && (cursor === seq || (oldest?.seq ?? Infinity) <= cursor + 1);
  if (!reaches) {
    // Tombstones too: one the reader may not see is named as withheld, so a copy it still holds leaves the
    // device as a withheld note does, not as an ordinary delete that keeps its history.
    const notes = sql.all<NoteRow>("SELECT * FROM notes ORDER BY seq");
    return {
      type: "snapshot",
      seq,
      notes: notes.flatMap((note) =>
        !project(note, reader) ? [withheld(note)] : note.deletedAt === null ? [stateOf(note)] : [],
      ),
      attempt,
    };
  }
  const notes = sql.all<NoteRow>("SELECT * FROM notes WHERE seq > ? ORDER BY seq", cursor);
  const purged = sql.all<{ noteId: string; seq: number }>(
    `SELECT noteId, max(seq) AS seq FROM changes
     WHERE seq > ? AND noteId NOT IN (SELECT id FROM notes) GROUP BY noteId`,
    cursor,
  );
  // shortcut: a purged note comes as plain deleted, so one that turned sensitive and was purged while a device
  // without the scope was away leaves that device as an ordinary delete (its 7-day local history kept); name
  // purged notes as withheld to such readers if that window matters.
  const items = [
    ...notes.map((note) => (project(note, reader) ? stateOf(note) : withheld(note))),
    ...purged.map((row) => ({ noteId: row.noteId, seq: row.seq, deleted: true as const })),
  ];
  return { type: "changes", from: cursor, to: seq, items };
}

/**
 * A result as `reader` may see it now. Stored answers outlive the note's class (an error can quote the text
 * it was about), so one about a note the reader can't see any more, or one purged since, keeps only its
 * numbers and says no more than a refusal does. `about` is null for an answer about no note (a refused
 * create, a change to a note that doesn't exist), which quotes only the change it answers.
 */
function asSeen(sql: Sql, result: Result, about: string | null, reader: Principal): Result {
  if (about === null || project(getNote(sql, about), reader)) return result;
  const { type, clientId, clientSeq, changeId, ok, rev } = result;
  return {
    type,
    clientId,
    clientSeq,
    changeId,
    ok,
    ...(rev !== undefined && { rev }),
    ...(!ok && { error: `No note with id ${about}.` }),
  };
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
 * knows its current ones. A client reading under another principal than its cursor was earned under (a
 * scope granted or narrowed since) gets a snapshot: the feed after its cursor says nothing of notes that
 * changed visibility without changing.
 */
export function hello(sql: Sql, message: Hello, now: number, reader: Principal): ServerMessage[] {
  // Canonical, so the same scopes written another way are still the same principal.
  const key = JSON.stringify([reader.sensitive, reader.types?.toSorted() ?? null]);
  return sql.transaction(() => {
    const [before] = sql.all<ClientRow>("SELECT * FROM clients WHERE clientId = ?", message.clientId);
    sql.all(
      `INSERT INTO clients (clientId, lastSeenAt, appVersion, reader) VALUES (?, ?, ?, ?)
       ON CONFLICT (clientId) DO UPDATE SET lastSeenAt = excluded.lastSeenAt, appVersion = excluded.appVersion,
         reader = excluded.reader`,
      message.clientId,
      now,
      message.appVersion,
      key,
    );
    acknowledge(sql, message.clientId, message.ackedUpTo);
    const [client] = sql.all<ClientRow>("SELECT * FROM clients WHERE clientId = ?", message.clientId);
    const results = sql.all<{ result: string; noteId: string | null }>(
      "SELECT result, noteId FROM results WHERE clientId = ? ORDER BY clientSeq",
      message.clientId,
    );
    return [
      {
        type: "welcome",
        clientId: message.clientId,
        highWater: client?.highWater ?? 0,
        ackedUpTo: client?.ackedUpTo ?? 0,
      },
      changesSince(sql, before?.reader === key ? message.cursor : null, reader, message.attempt),
      ...results.map((row) => asSeen(sql, JSON.parse(row.result), row.noteId, reader)),
    ];
  });
}

/**
 * One mutation from a client, applied exactly once and in order: only `highWater + 1` is applied, and its
 * result is stored with a digest of the mutation until the client acknowledges it. A repeat with the same
 * digest gets the stored result; a different mutation under a used number, or one already acknowledged,
 * means two machines share the id: the reply is a reset, which the copy still holding that change acts on. Every result, refused or not, uses up its number.
 */
export function receive(sql: Sql, message: Mutate, ctx: Context, reader: Principal): ServerMessage {
  const digest = createHash("sha256")
    .update(JSON.stringify([message.changeId, message.noteId, message.baseRev, message.change]))
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
      const [stored] = sql.all<{ digest: string; result: string; noteId: string | null }>(
        "SELECT digest, result, noteId FROM results WHERE clientId = ? AND clientSeq = ?",
        message.clientId,
        message.clientSeq,
      );
      if (stored?.digest === digest) return asSeen(sql, JSON.parse(stored.result), stored.noteId, reader);
      return reset(message, "Another device is using this client id.");
    }
    if (message.clientSeq > client.highWater + 1) {
      return { type: "gap", clientId: message.clientId, highWater: client.highWater };
    }
    // Answered before under some client id (a replay after a repair): the same answer, never applied again,
    // so a note deleted or reverted since stays that way and no proposal is opened twice.
    // shortcut: answers are kept for 90 days, as long as the feed; a replay older than that is applied anew.
    // A repaired copy resends a change with a fresh baseRev, so only the note and the change itself must match.
    const change = createHash("sha256")
      .update(JSON.stringify([message.changeId, message.noteId, message.change]))
      .digest("hex");
    const [landed] = sql.all<{ result: string; noteId: string | null; digest: string | null }>(
      "SELECT result, noteId, digest FROM landed WHERE changeId = ?",
      message.changeId,
    );
    let result: Result;
    let about: string | null;
    if (landed && landed.digest !== change) {
      // The same id on another change: never this answer, and never applied either.
      result = {
        type: "result",
        clientId: message.clientId,
        clientSeq: message.clientSeq,
        changeId: message.changeId,
        ok: false,
        error: "This change id was already used for another change.",
      };
      about = null;
    } else if (landed) {
      result = { ...JSON.parse(landed.result), clientId: message.clientId, clientSeq: message.clientSeq };
      about = landed.noteId;
    } else {
      result = apply(
        sql,
        message,
        { ...ctx, reader, ...(message.approvalId !== undefined && { approvalId: message.approvalId }) },
        reader,
      );
      about = getNote(sql, message.noteId) ? message.noteId : null;
      sql.all(
        "INSERT INTO landed (changeId, result, at, noteId, digest) VALUES (?, ?, ?, ?, ?)",
        message.changeId,
        JSON.stringify(result),
        ctx.now,
        about,
        change,
      );
    }
    sql.all("UPDATE clients SET highWater = ? WHERE clientId = ?", message.clientSeq, message.clientId);
    sql.all(
      "INSERT INTO results (clientId, clientSeq, digest, result, noteId) VALUES (?, ?, ?, ?, ?)",
      message.clientId,
      message.clientSeq,
      digest,
      JSON.stringify(result),
      about,
    );
    return asSeen(sql, result, about, reader);
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

/** Why `raw` can't be read as a note, or undefined if it can. */
function parseError(raw: string): string | undefined {
  try {
    parseNote(raw);
    return undefined;
  } catch (error) {
    if (error instanceof NoteParseError) return error.message;
    throw error;
  }
}

/** Why the record kept a change out, as a result: invalid, changed under it, or waiting for an approval. */
function refused(done: Omit<Result, "ok">, result: Exclude<MutationResult, { status: "applied" }>): Result {
  if (result.status === "needsApproval") {
    const { planHash, items } = result;
    return {
      ...done,
      ok: false,
      needsApproval: { planHash, items },
      error: "This needs your approval with a passkey.",
    };
  }
  // Sync carries no connection, so nothing it sends is held or forbidden; those read as what they are anyway.
  const error =
    result.status === "invalid"
      ? result.issues.map((issue) => issue.message).join(" ")
      : result.status === "forbidden"
        ? result.reason
        : result.status === "proposed"
          ? "This change waits as a proposal."
          : "The note changed.";
  return { ...done, ok: false, error };
}

/**
 * Applies one client change under the merge rules: nothing is dropped silently. A note `reader` may not see
 * is, to it, no note: its changes are refused the same way, so a reply never says what the note holds.
 */
function apply(sql: Sql, message: Mutate, ctx: Context, reader: Principal): Result {
  const { change, noteId } = message;
  const done = {
    type: "result",
    clientId: message.clientId,
    clientSeq: message.clientSeq,
    changeId: message.changeId,
  } as const;
  const current = project(getNote(sql, noteId), reader);

  // Text that doesn't parse is refused here, as a result that uses up its number, never thrown: a throw
  // would roll back and leave the client resending it forever, stuck behind it.
  const unreadable = change.kind === "delete" ? undefined : parseError(change.raw);
  if (unreadable !== undefined) return { ...done, ok: false, error: unreadable };
  // shortcut: a reader may still create a note it then can't see (a sensitive one, or another type); whether a
  // connection may is its level's call (#13).
  if (change.kind === "create" && !current) {
    const id = parseNote(change.raw).data["id"];
    if (id !== noteId) return { ...done, ok: false, error: "The note's id must match noteId." };
    const created = mutate(
      sql,
      { op: "create", path: change.path, raw: change.raw, class: change.class },
      ctx,
    );
    return created.status === "applied" ? { ...done, ok: true, rev: created.rev } : refused(done, created);
  }
  if (!current) return { ...done, ok: false, error: `No note with id ${noteId}.` };

  if (change.kind === "delete") {
    if (current.deletedAt !== null) return { ...done, ok: true, rev: current.rev };
    // Edited since this client saw it: the note stays, and the delete waits for the person.
    if (current.raw !== change.base) {
      const proposalId = propose(sql, noteId, { fields: {}, live: { before: true, after: false } }, ctx);
      return { ...done, ok: false, conflict: { proposalId, fields: [], body: false, deleted: true } };
    }
    const deleted = mutate(sql, { op: "delete", noteId, baseRev: current.rev }, ctx);
    return deleted.status === "applied" ? { ...done, ok: true, rev: deleted.rev } : refused(done, deleted);
  }

  // An edit, or a create for a note that exists (a client repairing): merge it into the current text. A
  // create has no base, so every field both sides set differently is a conflict.
  const mine = change.raw;
  // A base that doesn't parse (the edit after a refused one starts from the broken text) counts as no base:
  // then every field the two sides set differently is a conflict, never an overwrite.
  const base = change.kind === "put" && parseError(change.base) === undefined ? change.base : "";
  const merged = merge(base, mine, current.raw);
  // Nothing in it the record doesn't already have (a change resent after a repair, a create that already
  // landed): it is applied, and a note deleted since stays deleted.
  if (merged.raw === current.raw && merged.fields.length === 0 && !merged.body) {
    return { ...done, ok: true, rev: current.rev };
  }
  const deleted = current.deletedAt !== null;
  // Edited here, deleted on the other side: the note comes back with the edit, and the delete becomes the
  // proposal.
  const written = mutate(sql, { op: "put", noteId, baseRev: current.rev, raw: merged.raw }, ctx);
  if (written.status !== "applied") return refused(done, written);
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
  /** For every connected client, as each one's principal may see it, when the message changed the record. */
  readonly push?: (reader: Principal) => ServerMessage;
}

/**
 * One decoded client message from a client reading as `reader`, end to end: what the transport sends back
 * and what it pushes to everyone.
 */
export function serve(sql: Sql, message: ClientMessage, ctx: Context, reader: Principal): Served {
  if (message.type === "hello") return { replies: hello(sql, message, ctx.now, reader) };
  const before = currentSeq(sql);
  const reply = receive(sql, message, ctx, reader);
  return {
    replies: [reply],
    ...(currentSeq(sql) > before && { push: (other: Principal) => changesSince(sql, before, other) }),
  };
}
