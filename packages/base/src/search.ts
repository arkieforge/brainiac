import { fieldsText, splitNote } from "@brainiac/core";

import type { NoteRow } from "./notes.ts";
import { project, type Principal } from "./project.ts";
import type { Sql } from "./sql.ts";

/** Chunks never mix privacy classes: each family has its own FTS table. */
export type Family = "normal" | "sensitive";

const FTS = { normal: "chunks_fts_normal", sensitive: "chunks_fts_sensitive" } as const satisfies Record<
  Family,
  string
>;

/** How notes and files are cut into chunks (`chunkNote`, `chunkFile`). Bump it when that changes, to re-index. */
export const CHUNKS = "chunks-1";

/** The embedding model (Workers AI). Every vector is stored with it, so a model change can re-embed. */
export const EMBED_MODEL = "@cf/baai/bge-m3";

export interface ChunkInput {
  readonly family: Family;
  readonly header: string;
  readonly text: string;
  readonly fileSha?: string;
  readonly page?: number;
  /** The chunk's embedding as int8 (`quantize`), made with `EMBED_MODEL`. */
  readonly vector?: Uint8Array;
}

/**
 * Who a chunk or job belongs to: a note's id, or `file:<sha256>` for a cleared file's own pages.
 * shortcut: files own their chunks until every file has a sidecar note (#100); then the note owns them.
 */
export const fileOwner = (sha256: string) => `file:${sha256}`;

/**
 * Replaces every chunk of an owner (a note, or a file's `fileOwner`), in both families, with `chunks` for
 * revision `rev`; the old chunks' vectors go with them. Removing the old ones from both families is what makes a
 * note that turned sensitive leave the normal index at once.
 */
export function putChunks(sql: Sql, owner: string, rev: number, chunks: readonly ChunkInput[]): void {
  sql.all("DELETE FROM vectors WHERE chunkId IN (SELECT id FROM chunks WHERE noteId = ?)", owner);
  for (const table of Object.values(FTS)) {
    sql.all(`DELETE FROM ${table} WHERE rowid IN (SELECT id FROM chunks WHERE noteId = ?)`, owner);
  }
  sql.all("DELETE FROM chunks WHERE noteId = ?", owner);
  for (const chunk of chunks) {
    const [row] = sql.all<{ id: number }>(
      `INSERT INTO chunks (noteId, rev, family, fileSha, page, header, text) VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
      owner,
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
    if (chunk.vector) {
      sql.all("INSERT INTO vectors (chunkId, model, q) VALUES (?, ?, ?)", row.id, EMBED_MODEL, chunk.vector);
    }
  }
}

export type Hit = { readonly chunkId: number; readonly rank: number } & (
  | { readonly noteId: string }
  | { readonly fileSha: string; readonly page: number }
);

interface Row {
  readonly owner: string;
  readonly fileSha: string | null;
  readonly page: number | null;
  readonly chunkId: number;
  /** BM25: lower is better. */
  readonly rank: number;
  /** The note's class, or a cleared file's; the SQL matched it to the family. */
  readonly class: Family;
  readonly type: string | null;
}

/**
 * Keyword search over the families `principal` may see, best first: notes, and the pages of cleared files.
 * Returns candidates only, never chunk text: a chunk can be from an older revision until it is re-indexed, and
 * snippets must come from the current text. Every word must match; the text is quoted, so FTS5 syntax in it
 * (`AND`, `*`, `"`) is just text.
 */
export function search(sql: Sql, principal: Principal, text: string, limit = 20): Hit[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const query = words.map((word) => `"${word.replaceAll('"', '""')}"`).join(" ");
  const families: readonly Family[] = principal.sensitive ? ["normal", "sensitive"] : ["normal"];
  const types = principal.types ? JSON.stringify(principal.types) : null;
  // The class and the type scope are checked in SQL, before ranking and the limit, and each hit again by
  // `project`, so a leak needs two bugs, not one. A file's class is the vault's (`viewFile`): only a cleared
  // file is in a family, and a file has no type, so a type-scoped principal sees none.
  return (
    families
      .flatMap((family) =>
        sql.all<Row>(
          `SELECT chunks.noteId AS owner, chunks.fileSha AS fileSha, chunks.page AS page,
             chunks.id AS chunkId, bm25(${FTS[family]}) AS rank,
             coalesce(notes.class, files.class) AS class, notes.type AS type
           FROM ${FTS[family]}
           JOIN chunks ON chunks.id = ${FTS[family]}.rowid
           LEFT JOIN notes ON notes.id = chunks.noteId AND notes.deletedAt IS NULL
           LEFT JOIN files ON files.sha256 = chunks.fileSha AND chunks.noteId = 'file:' || chunks.fileSha
           WHERE ${FTS[family]} MATCH ? AND coalesce(notes.class, files.class) = ?
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
      .map(({ owner, fileSha, page, chunkId, rank }): Hit =>
        fileSha !== null && owner === fileOwner(fileSha)
          ? { fileSha, page: page ?? 1, chunkId, rank }
          : { noteId: owner, chunkId, rank },
      )
  );
}

/** A body up to this long is one chunk with the fields; a longer one is cut at its H2 headings. */
export const LONG_BODY = 2_000;

/**
 * The chunks an `index` job installs for a note, all in the family of its class: one chunk for a short note
 * (its fields as text, then its body), or for a long one the fields and any text before the first H2, then one
 * chunk per H2 section. Each starts with a template header naming the type and title, with no model call:
 * `[TestScore · IELTS Academic, November 2026]`, and `› <heading>` for a section.
 */
export function chunkNote(note: Pick<NoteRow, "raw" | "class" | "type" | "title" | "path">): ChunkInput[] {
  const header = `[${note.type ?? "Note"} · ${note.title ?? note.path}]`;
  const { yaml, body } = splitNote(note.raw);
  const fields = fieldsText(yaml);
  const chunk = (text: string, heading?: string): ChunkInput => ({
    family: note.class,
    header: heading === undefined ? header : `${header.slice(0, -1)} › ${heading}]`,
    text,
  });
  if (body.length <= LONG_BODY) return [chunk([fields, body.trim()].filter(Boolean).join("\n\n"))];
  // A heading inside a code fence is text, not a section.
  const sections: { heading?: string; lines: string[] }[] = [{ lines: [] }];
  let fenced = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? undefined : h2(line);
    if (heading) sections.push({ heading, lines: [] });
    else sections.at(-1)?.lines.push(line);
  }
  const [lead, ...rest] = sections.map((s) => ({ heading: s.heading, text: s.lines.join("\n").trim() }));
  return [
    chunk([fields, lead?.text].filter(Boolean).join("\n\n")),
    ...rest.map((s) => chunk(s.text, s.heading)),
  ].filter((c) => c.text.length > 0 || c.header !== header);
}

/**
 * An H2 heading's text (`## Plan ##` is `Plan`), or `undefined` for any other line. Plain string steps, not a
 * regex, so a long line of spaces or `#` costs linear time.
 */
function h2(line: string): string | undefined {
  if (!line.startsWith("## ")) return undefined;
  let text = line.slice(3).trim();
  // A closing run of `#` goes only after a space, as in CommonMark: `## C#` stays `C#`.
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end--;
  if (end === 0 || /\s/.test(text[end - 1] ?? "")) text = text.slice(0, end).trim();
  return text || undefined;
}

/**
 * The chunks a cleared file installs, before the record gives them its class's family: one per page with text,
 * under a header naming the file's kind and page (`[transcript · page 2]`). The jobs consumer embeds the same
 * list, so its vectors pair with these by position.
 */
export function chunkFile(
  file: { readonly sha256: string; readonly kind: string | null },
  pages: readonly string[],
): Omit<ChunkInput, "family">[] {
  return pages.flatMap((page, i) =>
    page.trim()
      ? [
          {
            header: `[${file.kind ?? "document"} · page ${i + 1}]`,
            text: page.trim(),
            fileSha: file.sha256,
            page: i + 1,
          },
        ]
      : [],
  );
}

/**
 * An embedding as int8, scaled so its largest component is ±127. Cosine similarity ignores scale, so the scale
 * isn't kept; bge-m3's unit vectors keep a cosine above 0.999 against the original.
 */
export function quantize(vector: readonly number[]): Uint8Array {
  const max = Math.max(...vector.map(Math.abs)) || 1;
  return new Uint8Array(Int8Array.from(vector, (x) => Math.round((x / max) * 127)).buffer);
}

/** A stored vector's components (a BLOB comes back as an ArrayBuffer from the DO, a Uint8Array from Bun). */
export const dequantize = (q: ArrayBuffer | Uint8Array): Int8Array => new Int8Array(new Uint8Array(q).buffer);
