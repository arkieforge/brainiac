import type { NoteRow } from "./notes.ts";

/**
 * Who is reading, as the record knows it from the session or the connection's own row, never from the request:
 * the person, or a connection with its scopes (`principalOf`). Secrets are no part of it, since no read surface
 * returns them.
 */
export interface Principal {
  /** May see sensitive notes: the person, or a connection granted the sensitive scope (off by default). */
  readonly sensitive: boolean;
  /** A token's type scope ("Education and Roles only"): notes of these types only. Absent means every type. */
  readonly types?: readonly string[];
}

/** The person themself, on the site or a device of theirs: every class. */
export const PERSON: Principal = { sensitive: true };

/**
 * The one permission check for every read surface (docs/internals/retrieval.md): the note as `principal`
 * may see it, or `undefined` when it may not see it at all. The sync feed, search and `canSee` use it, and every
 * tool, resource, file URL, cache and proposal (which holds its note's values) must; `getNote` and `listNotes` don't, so whatever answers a reader with
 * their rows passes each one through here.
 * shortcut: a note is seen whole or not at all; #20's per-field chunk families make it field by field.
 */
export function project<N extends Pick<NoteRow, "class" | "type">>(
  note: N | undefined,
  principal: Principal,
): N | undefined {
  if (!note) return undefined;
  // Any class but normal needs the scope, so a class added later starts hidden.
  if (note.class !== "normal" && !principal.sensitive) return undefined;
  if (principal.types && !principal.types.includes(note.type ?? "")) return undefined;
  return note;
}
