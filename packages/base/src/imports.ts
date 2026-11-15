// Imports (docs/product/onboarding.md): what `brainiac import` sends, the notes it read from a LinkedIn export or an
// OKF vault (packages/core/src/imports.ts) and the text of a CV. Each note waits as a proposal for the person,
// whatever the connection's level: they look at what came in before it counts. Inbox text is raw input, added the
// way `add` adds it. What the record already has is left out, so importing the same files again changes nothing:
// a note the caller can see, or an open proposal, of the same type with the same key fields (the type's `key`, else
// its title), or an inbox item with the same text.
import {
  BUILT_IN_TYPES,
  isUlid,
  NoteParseError,
  normalizePath,
  parseNote,
  patch,
  PathError,
  splitNote,
  ulid,
  type PlanItem,
} from "@brainiac/core";

import { principalOf, type Connection } from "./connections.ts";
import { manifestOf } from "./hold.ts";
import { mutate, type Context, type MutationResult } from "./mutate.ts";
import { freeAt, freePath, getNote, listNotes } from "./notes.ts";
import { project } from "./project.ts";
import type { Sql } from "./sql.ts";

export interface ImportNote {
  /** The whole markdown, with a `type`. Its `id` is kept if the record has no note with it, and given otherwise. */
  readonly raw: string;
  /** Where it goes; the end of its id is added when a note or an open proposal has the path. */
  readonly path?: string;
  readonly sensitive?: boolean;
}

export interface ImportText {
  readonly text: string;
  readonly sensitive?: boolean;
}

export type Imported =
  /** `of`: the path of the note, proposal or inbox item it matches. */
  | { readonly status: "duplicate"; readonly path?: string; readonly of: string }
  | { readonly path?: string; readonly result: MutationResult };

const fold = (value: unknown) =>
  typeof value === "string" ? value.normalize("NFKC").toLowerCase().trim() : value;

/** What makes two notes of a type one item: its key's values when it has a key and they are all set, else its title. */
function identity(
  keys: Readonly<Record<string, readonly string[]>>,
  data: Readonly<Record<string, unknown>>,
) {
  const type = data["type"];
  if (typeof type !== "string") return undefined;
  const key = keys[type];
  const values = key?.map((field) => data[field]);
  if (key && values?.every((value) => value !== undefined && value !== null))
    return JSON.stringify([type, key, values.map(fold)]);
  return typeof data["title"] === "string" ? JSON.stringify([type, "title", fold(data["title"])]) : undefined;
}

const after = (item: PlanItem): Record<string, unknown> =>
  Object.fromEntries(Object.entries(item.patch.fields).map(([field, change]) => [field, change.after]));

/**
 * Imports `notes` and `inbox` as `ctx`'s connection, one transaction each, in order. Notes are proposed at the
 * connection's level or propose, whichever is lower: a read-level connection is refused, and a write-level one
 * still only proposes. A sensitive note needs the sensitive scope. Duplicates are found among what `ctx` may see, so
 * the answer never tells of a hidden note.
 */
export function importInto(
  sql: Sql,
  { notes, inbox }: { readonly notes: readonly ImportNote[]; readonly inbox: readonly ImportText[] },
  ctx: Context & { readonly connection: Connection },
): Imported[] {
  const reader = principalOf(ctx.connection);
  const connection: Connection = {
    ...ctx.connection,
    level: ctx.connection.level === "read" ? "read" : "propose",
  };
  const types = { ...BUILT_IN_TYPES, ...manifestOf(sql)?.types };
  const keys = Object.fromEntries(
    Object.entries(types).flatMap(([name, spec]) => (spec.key ? [[name, spec.key]] : [])),
  );
  // Every item the caller may see, by identity, to the path that has it.
  const known = new Map<string, string>();
  for (const note of listNotes(sql))
    if (project(note, reader)) {
      const id = identity(keys, JSON.parse(note.fm));
      if (id !== undefined && !known.has(id)) known.set(id, note.path);
    }
  const proposedIds = new Set<string>();
  for (const row of sql.all<{ patch: string }>(
    "SELECT patch FROM proposals WHERE status = 'open' AND kind = 'change'",
  ))
    for (const item of JSON.parse(row.patch) as PlanItem[]) {
      if (item.baseRev !== 0 || item.patch.live?.after !== true) continue;
      proposedIds.add(item.noteId);
      const data = after(item);
      const id = identity(keys, data);
      if (
        id !== undefined &&
        project({ class: item.class, type: String(data["type"]) }, reader) &&
        !known.has(id)
      )
        known.set(id, item.path);
    }

  const results: Imported[] = [];
  for (const note of notes) {
    // It couldn't see the note it made, nor tell next time that the record has it.
    if (note.sensitive && !reader.sensitive) {
      results.push({
        ...(note.path !== undefined && { path: note.path }),
        result: {
          status: "forbidden",
          reason:
            "This connection can't see sensitive notes, so it can't import one. Grant it the sensitive scope on the account page, then import again.",
        },
      });
      continue;
    }
    let data: Readonly<Record<string, unknown>>;
    try {
      data = parseNote(note.raw).data;
    } catch (error) {
      if (!(error instanceof NoteParseError)) throw error;
      results.push(invalid(note.path, "front-matter", error.message));
      continue;
    }
    if (typeof data["type"] !== "string") {
      results.push(invalid(note.path, "type", "A note needs a type. Example: type: Role"));
      continue;
    }
    const twin = identity(keys, data);
    const seen = twin === undefined ? undefined : known.get(twin);
    const given = data["id"];
    const same = typeof given === "string" && isUlid(given) ? getNote(sql, given) : undefined;
    const of = seen ?? (same && same.deletedAt === null && project(same, reader) ? same.path : undefined);
    if (of !== undefined) {
      results.push({ status: "duplicate", ...(note.path !== undefined && { path: note.path }), of });
      continue;
    }
    // A note's own id is kept unless another note (even a deleted or hidden one) or an open proposal has it.
    const id =
      typeof given === "string" && isUlid(given) && !same && !proposedIds.has(given) ? given : ulid(ctx.now);
    let path: string;
    try {
      if (note.path !== undefined && !note.path.toLowerCase().endsWith(".md"))
        throw new PathError(`A note's path ends in .md: ${note.path}`);
      path =
        note.path === undefined
          ? freePath(sql, data["type"], typeof data["title"] === "string" ? data["title"] : "", id)
          : freeAt(sql, normalizePath(note.path), id);
    } catch (error) {
      if (!(error instanceof PathError)) throw error;
      results.push(invalid(note.path, "path", error.message));
      continue;
    }
    const raw = id === given ? note.raw : patch(note.raw, [{ op: "set", path: ["id"], value: id }]);
    const result = mutate(
      sql,
      { op: "create", path, raw, class: note.sensitive ? "sensitive" : "normal" },
      { ...ctx, connection },
    );
    if (result.status === "proposed" && twin !== undefined) known.set(twin, path);
    if (result.status === "proposed") proposedIds.add(id);
    results.push({ path, result });
  }

  const texts = new Map(
    listNotes(sql, { type: "InboxItem" })
      .filter((item) => project(item, reader))
      .map((item) => [splitNote(item.raw).body.trim(), item.path]),
  );
  for (const { text, sensitive } of inbox) {
    const twin = texts.get(text.trim());
    if (twin !== undefined) {
      results.push({ status: "duplicate", of: twin });
      continue;
    }
    const id = ulid(ctx.now);
    const path = `inbox/${id.toLowerCase()}.md`;
    const raw =
      patch("", [
        { op: "set", path: ["id"], value: id },
        { op: "set", path: ["type"], value: "InboxItem" },
      ]) + text;
    // Not as the connection, like add: an inbox item is raw input, so it never waits as a proposal. The actor
    // still says who added it, and the approval list still applies.
    const result = mutate(
      sql,
      { op: "create", path, raw, class: sensitive ? "sensitive" : "normal" },
      { actor: ctx.actor, now: ctx.now, reader },
    );
    if (result.status === "applied") texts.set(text.trim(), path);
    results.push({ path, result });
  }
  return results;
}

const invalid = (path: string | undefined, field: string, message: string): Imported => ({
  ...(path !== undefined && { path }),
  result: { status: "invalid", issues: [{ field, message }] },
});
