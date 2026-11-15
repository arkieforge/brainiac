import { splitNote } from "@brainiac/core";

import type { NoteRow } from "./notes.ts";
import { project, type Principal } from "./project.ts";
import type { Sql } from "./sql.ts";

/** Chunks never mix privacy classes: each family has its own FTS table. */
export type Family = "normal" | "sensitive";

const FTS = { normal: "chunks_fts_normal", sensitive: "chunks_fts_sensitive" } as const satisfies Record<
  Family,
  string
>;

export interface ChunkInput {
  readonly family: Family;
  readonly header: string;
  readonly text: string;
  readonly fileSha?: string;
  readonly page?: number;
}

/**
 * Replaces every chunk of a note, in both families, with `chunks` for revision `rev`; the old chunks'
 * vectors go with them. Removing the old ones from both families is what makes a note that turned sensitive leave the normal index at once.
 */
export function putChunks(sql: Sql, noteId: string, rev: number, chunks: readonly ChunkInput[]): void {
  sql.all("DELETE FROM vectors WHERE chunkId IN (SELECT id FROM chunks WHERE noteId = ?)", noteId);
  for (const table of Object.values(FTS)) {
    sql.all(`DELETE FROM ${table} WHERE rowid IN (SELECT id FROM chunks WHERE noteId = ?)`, noteId);
  }
  sql.all("DELETE FROM chunks WHERE noteId = ?", noteId);
  for (const chunk of chunks) {
    const [row] = sql.all<{ id: number }>(
      `INSERT INTO chunks (noteId, rev, family, fileSha, page, header, text) VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
      noteId,
      rev,
      chunk.family,
      chunk.fileSha ?? null,
      chunk.page ?? null,
      chunk.header,
      chunk.text,
    );
    if (!row) throw new Error("INSERT ... RETURNING returned no row");
    sql.all(
      `INSERT INTO ${FTS[chunk.family]} (rowid, header, text) VALUES (?, ?, ?)`,
      row.id,
      chunk.header,
      chunk.text,
    );
  }
}

export interface Hit {
  readonly noteId: string;
  readonly chunkId: number;
  /** BM25: lower is better. */
  readonly rank: number;
}

/**
 * Keyword search over the families `principal` may see, best first. Returns candidates only, never chunk
 * text: a chunk can be from an older revision until it is re-indexed, and snippets must come from the note's
 * current text. Every word must match; the text is quoted, so FTS5 syntax in it (`AND`, `*`, `"`) is just text.
 */
export function search(sql: Sql, principal: Principal, text: string, limit = 20): Hit[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const query = words.map((word) => `"${word.replaceAll('"', '""')}"`).join(" ");
  const families: readonly Family[] = principal.sensitive ? ["normal", "sensitive"] : ["normal"];
  const types = principal.types ? JSON.stringify(principal.types) : null;
  // The class and the type scope are checked in SQL, before ranking and the limit, and each hit again by
  // `project`, so a leak needs two bugs, not one.
  return (
    families
      .flatMap((family) =>
        sql.all<Hit & Pick<NoteRow, "class" | "type">>(
          `SELECT chunks.noteId AS noteId, chunks.id AS chunkId, bm25(${FTS[family]}) AS rank,
           notes.class AS class, notes.type AS type
         FROM ${FTS[family]}
         JOIN chunks ON chunks.id = ${FTS[family]}.rowid
         JOIN notes ON notes.id = chunks.noteId AND notes.deletedAt IS NULL
         WHERE ${FTS[family]} MATCH ? AND notes.class = ?
           AND (? IS NULL OR notes.type IN (SELECT value FROM json_each(?)))
         ORDER BY rank LIMIT ?`,
          query,
          family,
          types,
          types,
          limit,
        ),
      )
      .filter((hit) => project(hit, principal))
      // shortcut: BM25 from two tables isn't one scale, so normal and sensitive hits interleave roughly; #22's
      // fusion ranks them properly.
      .toSorted((a, b) => a.rank - b.rank)
      .slice(0, limit)
      .map(({ noteId, chunkId, rank }) => ({ noteId, chunkId, rank }))
  );
}

/**
 * The chunks an `index` job installs for a note, in the family of its class.
 * shortcut: one chunk per note, header plus body; #20 replaces it with per-field families and one chunk per H2.
 */
export function chunkNote(note: Pick<NoteRow, "raw" | "class" | "type" | "title" | "path">): ChunkInput[] {
  return [
    {
      family: note.class,
      header: `[${note.type ?? "Note"} · ${note.title ?? note.path}]`,
      text: splitNote(note.raw).body,
    },
  ];
}
