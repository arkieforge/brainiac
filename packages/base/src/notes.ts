import { parseNote } from "@brainiac/core";

import type { Sql } from "./sql.ts";

export type NoteClass = "normal" | "sensitive";

/** What the mutation path writes; `fm` and the generated columns follow from `raw`. */
export interface NoteInput {
  readonly id: string;
  readonly path: string;
  readonly raw: string;
  readonly rev: number;
  readonly hash: string;
  readonly seq: number;
  readonly class: NoteClass;
  readonly deletedAt?: number | null;
}

/** A stored note, with the hot front-matter fields as columns (`null` when the note doesn't set them). */
export interface NoteRow extends Required<NoteInput> {
  /** The front-matter as JSON. */
  readonly fm: string;
  readonly type: string | null;
  readonly title: string | null;
  readonly kind: string | null;
  readonly status: string | null;
  readonly date: string | null;
  readonly deadline: string | null;
  readonly expires: string | null;
}

const COLUMNS =
  "id, path, raw, fm, rev, hash, seq, class, deletedAt, type, title, kind, status, date, deadline, expires";

/** Inserts or replaces a note by id. Throws `NoteParseError` on front-matter that isn't valid YAML. */
export function putNote(sql: Sql, note: NoteInput): void {
  const fm = JSON.stringify(parseNote(note.raw).data);
  sql.all(
    `INSERT INTO notes (id, path, raw, fm, rev, hash, seq, class, deletedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET path = excluded.path, raw = excluded.raw, fm = excluded.fm,
       rev = excluded.rev, hash = excluded.hash, seq = excluded.seq, class = excluded.class,
       deletedAt = excluded.deletedAt`,
    note.id,
    note.path,
    note.raw,
    fm,
    note.rev,
    note.hash,
    note.seq,
    note.class,
    note.deletedAt ?? null,
  );
}

/** A note by id, tombstones included. */
export function getNote(sql: Sql, id: string): NoteRow | undefined {
  return sql.all<NoteRow>(`SELECT ${COLUMNS} FROM notes WHERE id = ?`, id)[0];
}

/** The live note at a path. */
export function getNoteByPath(sql: Sql, path: string): NoteRow | undefined {
  return sql.all<NoteRow>(`SELECT ${COLUMNS} FROM notes WHERE path = ? AND deletedAt IS NULL`, path)[0];
}

/** Live notes, optionally of one type, newest `date` first, then by path. */
export function listNotes(sql: Sql, filter: { readonly type?: string } = {}): NoteRow[] {
  return filter.type === undefined
    ? sql.all<NoteRow>(
        `SELECT ${COLUMNS} FROM notes WHERE deletedAt IS NULL ORDER BY date DESC NULLS LAST, path`,
      )
    : sql.all<NoteRow>(
        `SELECT ${COLUMNS} FROM notes WHERE deletedAt IS NULL AND type = ? ORDER BY date DESC NULLS LAST, path`,
        filter.type,
      );
}
