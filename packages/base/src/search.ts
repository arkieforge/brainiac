import { fieldsText, splitNote } from "@brainiac/core";

import { meetsRelations } from "./applications.ts";
import { relationResolver } from "./approvals.ts";
import { getNote, type NoteRow } from "./notes.ts";
import { project, type Principal } from "./project.ts";
import type { Sql } from "./sql.ts";

/** Chunks never mix privacy classes: each family has its own FTS table. */
export type Family = "normal" | "sensitive";

const FTS = { normal: "chunks_fts_normal", sensitive: "chunks_fts_sensitive" } as const satisfies Record<
  Family,
  string
>;

/** How notes and files are cut into chunks (`chunkNote`, `chunkFile`) and folded for FTS5 (`fold`). Bump it when that changes, to re-index. */
export const CHUNKS = "chunks-2";

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
      fold(chunk.header),
      fold(chunk.text),
    );
    if (chunk.vector) {
      sql.all("INSERT INTO vectors (chunkId, model, q) VALUES (?, ?, ?)", row.id, EMBED_MODEL, chunk.vector);
    }
  }
}

/** What search found: a note, or a page of a cleared file. */
type Found = { readonly noteId: string } | { readonly fileSha: string; readonly page: number };

export type Hit = Found & {
  /** Reciprocal rank fusion of the keyword and vector rankings: higher is better. */
  readonly score: number;
  /** Where it matched, cut from the current text: a chunk from an older revision only nominates its note. */
  readonly snippet: string;
  /**
   * Which rankings found it: its `words` (keyword), its `meaning` (vector) or `both`. A hit found by meaning alone
   * holds none of the question's words, so an answer must not read it as a match.
   */
  readonly matched: "words" | "meaning" | "both";
};

/** A note one hop from a hit: a relation on the hit names it (`out`), or a relation on it names the hit (`in`). */
export interface Neighbor {
  readonly noteId: string;
  readonly via: { readonly noteId: string; readonly field: string; readonly direction: "out" | "in" };
}

export interface Results {
  /** `keyword` when no vector took part (offline, or nothing embedded yet), so an answer can say it is keyword-only. */
  readonly mode: "hybrid" | "keyword";
  readonly hits: readonly Hit[];
  readonly neighbors: readonly Neighbor[];
}

export interface Query {
  /** The question's embedding with `EMBED_MODEL`, which only the cloud makes; without one, search is keyword-only. */
  readonly vector?: readonly number[];
  /** At most this many hits (20 by default, never more than 100), and as many neighbors. */
  readonly limit?: number;
  /**
   * Match chunks holding any of the words, best BM25 first, instead of all of them: for a question in the person's
   * own words (`ask`), where "what was my writing score" shares only some words with the note that answers it.
   */
  readonly anyWord?: boolean;
  /** The time `meets` edges are judged at, since a check can depend on the day; without it they're left out. */
  readonly now?: number;
}

/** A chunk the principal may see, as a ranking found it. */
interface Candidate {
  readonly chunkId: number;
  readonly owner: string;
  readonly fileSha: string | null;
  readonly page: number | null;
  /** The note's class, or a cleared file's; the SQL matched it to the chunk's family. */
  readonly class: Family;
  readonly type: string | null;
  /** 1 when the chunk is from an older revision of its note, which it only nominates; 0 when current. */
  readonly stale: number;
}

/** Reciprocal rank fusion's constant: a ranking adds 1 / (RRF_K + rank) to each hit's score. */
const RRF_K = 60;
/** How many notes or pages each ranking puts into the fusion, and so the most a search returns: a limit only cuts. */
const POOL = 100;

/**
 * The chunks of `family` a principal may see, joined on `id`. The class and the type scope are checked here, in
 * SQL, before any ranking or limit, and every hit again by `project`, so a leak needs two bugs, not one. A file's
 * class is the vault's (`viewFile`): only a cleared file is in a family, and a file has no type, so a type-scoped
 * principal sees none. Takes the family and the type scope twice as parameters.
 */
const visible = (id: string) => `
  JOIN chunks ON chunks.id = ${id}
  LEFT JOIN notes ON notes.id = chunks.noteId AND notes.deletedAt IS NULL
  LEFT JOIN files ON files.sha256 = chunks.fileSha AND chunks.noteId = 'file:' || chunks.fileSha
  WHERE chunks.family = ? AND coalesce(notes.class, files.class) = chunks.family
    AND (? IS NULL OR notes.type IN (SELECT value FROM json_each(?)))`;

const CANDIDATE = `chunks.id AS chunkId, chunks.noteId AS owner, chunks.fileSha AS fileSha, chunks.page AS page,
  coalesce(notes.class, files.class) AS class, notes.type AS type, coalesce(chunks.rev < notes.rev, 0) AS stale`;

/**
 * Search over the families `principal` may see, best first: notes and the pages of cleared files, by keyword
 * (FTS5, every word must match, FTS5 syntax in the text is just text) and, given the question's vector, by exact
 * cosine over every stored int8 vector, merged by reciprocal rank fusion; then one hop of graph neighbors. The
 * DO and a laptop's local copy run it alike; a local copy has no vectors and no way to embed offline, so there it
 * is keyword-only and `mode` says so.
 */
export function search(sql: Sql, principal: Principal, text: string, query: Query = {}): Results {
  const { vector } = query;
  // A whole number from 0 to POOL, whatever a caller passes.
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 20) || 0, 0), POOL);
  const words = fold(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return { mode: "keyword", hits: [], neighbors: [] };
  const match = words.map((word) => `"${word.replaceAll('"', '""')}"`).join(query.anyWord ? " OR " : " ");
  const families: readonly Family[] = principal.sensitive ? ["normal", "sensitive"] : ["normal"];
  const types = principal.types ? JSON.stringify(principal.types) : null;
  // BM25 from two tables isn't one scale, so each family is its own ranking, of notes and pages: a note's best
  // chunk stands for it (SQLite takes the other columns from the row `min` picks). An older revision's words are no
  // match unless the current text holds them too; such rows are dropped before the fusion, the order and the
  // limit. One query, read until a full pool of the rest: a row per matched note or page.
  const rankings = families.map((family) => {
    const kept: Candidate[] = [];
    const rows = sql.all<Candidate>(
      // Materialized, so SQLite doesn't fold `bm25` into the aggregate, where FTS5 can't run it.
      `WITH matches AS MATERIALIZED (
         SELECT ${CANDIDATE}, bm25(${FTS[family]}) AS bm25 FROM ${FTS[family]}
         ${visible(`${FTS[family]}.rowid`)} AND ${FTS[family]} MATCH ?)
       SELECT chunkId, owner, fileSha, page, class, type, stale FROM matches
       GROUP BY owner, page ORDER BY min(bm25), chunkId`,
      family,
      types,
      types,
      match,
    );
    for (const row of rows) {
      if (kept.length === POOL) break;
      if (project(row, principal) && (!row.stale || holdsNow(sql, row.owner, words, query.anyWord ?? false)))
        kept.push(row);
    }
    return kept;
  });
  const keyword = rankings.length;
  const nearest = vector ? nearestChunks(sql, principal, families, types, vector) : [];
  if (nearest.length > 0) rankings.push(nearest);

  const fused = new Map<
    string,
    { candidate: Candidate; score: number; best: number; by: Set<Hit["matched"]> }
  >();
  rankings.forEach((ranking, i) => {
    const ranked = new Set<string>();
    for (const candidate of ranking) {
      const key = keyOf(candidate);
      // A note's best chunk in a ranking stands for it there.
      if (ranked.has(key)) continue;
      ranked.add(key);
      if (ranked.size > POOL) break;
      const rank = ranked.size;
      const seen = fused.get(key);
      fused.set(key, {
        candidate: seen && seen.best <= rank ? seen.candidate : candidate,
        score: (seen?.score ?? 0) + 1 / (RRF_K + rank),
        best: Math.min(seen?.best ?? rank, rank),
        by: (seen?.by ?? new Set()).add(i < keyword ? "words" : "meaning"),
      });
    }
  });
  const hits = [...fused.entries()]
    .toSorted(([ka, a], [kb, b]) => b.score - a.score || a.best - b.best || (ka < kb ? -1 : 1))
    .slice(0, limit)
    .flatMap(([, { candidate, score, by }]): Hit[] => {
      const snippet = snippetOf(sql, principal, candidate, by.has("words") ? words : []);
      const matched = by.size === 2 ? "both" : by.has("words") ? "words" : "meaning";
      return snippet === undefined ? [] : [{ ...found(candidate), score, snippet, matched }];
    });
  const noteHits = hits.flatMap((hit) => ("noteId" in hit ? [hit.noteId] : []));
  return {
    mode: nearest.length > 0 ? "hybrid" : "keyword",
    hits,
    neighbors: neighbors(sql, principal, noteHits, limit, query.now),
  };
}

/**
 * The visible chunks with an `EMBED_MODEL` vector, nearest the question first, by exact cosine over every one.
 * shortcut: every vector is read from SQLite for each question, so nothing has to stay in step with the index. A
 * 20k-chunk record is about 20 MB of the DO's 128 MB and 70 ms p95 of search in workerd, not counting the question's
 * embedding (a Workers AI call); the graph hop adds about 10 ms at 2k notes. Keep vectors in the DO's memory, or
 * read them in batches, if search nears its 150 ms budget (docs/operations/quality-bar.md) or a record its memory.
 */
function nearestChunks(
  sql: Sql,
  principal: Principal,
  families: readonly Family[],
  types: string | null,
  vector: readonly number[],
): Candidate[] {
  return families
    .flatMap((family) =>
      sql.all<Candidate & { readonly q: ArrayBuffer | Uint8Array }>(
        `SELECT ${CANDIDATE}, vectors.q AS q FROM vectors ${visible("vectors.chunkId")} AND vectors.model = ?`,
        family,
        types,
        types,
        EMBED_MODEL,
      ),
    )
    .filter((row) => project(row, principal))
    .flatMap(({ q, ...candidate }) => {
      const similarity = cosine(vector, dequantize(q));
      return similarity === undefined ? [] : [{ candidate, similarity }];
    })
    .toSorted((a, b) => b.similarity - a.similarity || a.candidate.chunkId - b.candidate.chunkId)
    .map(({ candidate }) => candidate);
}

/** Cosine similarity, up to the question's own length, which is the same for every vector; undefined if the sizes differ. */
function cosine(question: readonly number[], stored: Int8Array): number | undefined {
  if (stored.length !== question.length) return undefined;
  let dot = 0;
  let norm = 0;
  for (let i = 0; i < stored.length; i++) {
    const x = stored[i] ?? 0;
    dot += x * (question[i] ?? 0);
    norm += x * x;
  }
  return norm === 0 ? undefined : dot / Math.sqrt(norm);
}

const isFilePage = (candidate: Candidate): candidate is Candidate & { readonly fileSha: string } =>
  candidate.fileSha !== null && candidate.owner === fileOwner(candidate.fileSha);

const found = (candidate: Candidate): Found =>
  isFilePage(candidate)
    ? { fileSha: candidate.fileSha, page: candidate.page ?? 1 }
    : { noteId: candidate.owner };

const keyOf = (candidate: Candidate) =>
  isFilePage(candidate) ? `${candidate.fileSha}#p${candidate.page ?? 1}` : candidate.owner;

/**
 * A hit's snippet. A note's chunk can be from an older revision until the note is re-indexed, so its snippet is cut
 * from the note's current text, never the chunk's: from the same section, or after a retitle (a header names the
 * title) from the first section that holds a word. A file's pages are its bytes' text, which never changes.
 * `undefined` when the note is gone or no longer visible. `words` is empty for a hit found by meaning alone.
 */
function snippetOf(
  sql: Sql,
  principal: Principal,
  candidate: Candidate,
  words: readonly string[],
): string | undefined {
  const [chunk] = sql.all<{ header: string; text: string }>(
    "SELECT header, text FROM chunks WHERE id = ?",
    candidate.chunkId,
  );
  if (!chunk) return undefined;
  if (isFilePage(candidate)) return excerpt(chunk.text, words);
  const note = project(getNote(sql, candidate.owner), principal);
  if (!note || note.deletedAt !== null) return undefined;
  const sections = chunkNote(note);
  const same = sections.find((s) => s.header === chunk.header);
  const holds = (s: ChunkInput | undefined) => s !== undefined && locate(`${s.header} ${s.text}`, words) >= 0;
  const section = (words.length > 0 ? [same, ...sections].find(holds) : undefined) ?? same ?? sections[0];
  return excerpt(section?.text ?? "", words);
}

/**
 * Whether a section of the note's current text holds every word of the question (or, with `any`, one of them) as
 * FTS5 matches a chunk: each one a whole word, and one that cuts into several (`transit-apps`) as those words in a row.
 */
function holdsNow(sql: Sql, noteId: string, words: readonly string[], any: boolean): boolean {
  const note = getNote(sql, noteId);
  if (!note) return false;
  const phrases = words.map(tokens).filter((phrase) => phrase.length > 0);
  // A phrase stays inside one column, header or text, as in FTS5.
  return chunkNote(note).some((s) => {
    const columns = [tokens(s.header), tokens(s.text)];
    const holds = (phrase: readonly string[]) => columns.some((have) => phraseAt(have, phrase) >= 0);
    return any ? phrases.some(holds) : phrases.every(holds);
  });
}

/** Where `phrase` starts in `have`, its words in a row, or -1. */
const phraseAt = (have: readonly string[], phrase: readonly string[]) =>
  have.findIndex((_, i) => phrase.every((token, k) => have[i + k] === token));

// A word as unicode61 cuts one with marks as word characters (schema.ts); the joiners `fold` drops stay inside it.
const WORD = /[\p{L}\p{N}\p{M}\p{Co}\u200C\u200D]+/gu;

/** The words of `text` in `loose` form, each with where it starts in `text`. */
const wordsAt = (text: string) =>
  Array.from(text.matchAll(WORD), ({ 0: word, index }) => ({ word: loose(word), index })).filter(
    (w) => w.word,
  );

/** The words of `text` as FTS5 compares them. */
const tokens = (text: string) => wordsAt(text).map((w) => w.word);

/** About this many characters of text around a hit's first matching word. */
const SNIPPET = 240;

function excerpt(text: string, words: readonly string[]): string {
  const flat = text.replace(/\s+/g, " ").trim().normalize("NFC");
  const place = locate(flat, words);
  const at = place < 0 ? flat.length : place;
  let start = at === flat.length ? 0 : Math.max(0, at - SNIPPET / 3);
  if (start > 0) start = flat.lastIndexOf(" ", start) + 1;
  let end = Math.min(flat.length, start + SNIPPET);
  if (end < flat.length && flat.lastIndexOf(" ", end) > at) end = flat.lastIndexOf(" ", end);
  // Never half of a character outside the Basic Multilingual Plane.
  const cut = flat.slice(start, end).replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, "");
  return `${start > 0 ? "…" : ""}${cut}${end < flat.length ? "…" : ""}`;
}

/**
 * Where in `text` the first of the question's `words` starts, matched as FTS5 matches it (whole words, and a word
 * that cuts into several as those words in a row), or -1.
 */
function locate(text: string, words: readonly string[]): number {
  const have = wordsAt(text);
  const cut = have.map((w) => w.word);
  // A word of punctuation alone is no phrase, as FTS5 ignores it.
  const starts = words
    .map(tokens)
    .filter((phrase) => phrase.length > 0)
    .map((phrase) => have[phraseAt(cut, phrase)]?.index)
    .filter((index) => index !== undefined);
  return starts.length > 0 ? Math.min(...starts) : -1;
}

/**
 * Text as FTS5 compares it, to find a word in it: folded (`fold`), without case, and without the diacritics
 * `remove_diacritics` drops from Latin letters. Other marks stay, as unicode61 keeps them inside words.
 */
const loose = (text: string) =>
  fold(text)
    .normalize("NFD")
    .replace(/(?<=\p{Script=Latin})\p{M}+/gu, "")
    .toLowerCase();

// Every text value in a live note's front-matter that could be a relation: a relative `.md` path or a note id,
// with the top-level field it sits in (`supersedes`, `proves`, a source's `resource`). Body links come after.
const RELATIONS = `SELECT notes.id AS id, notes.path AS path, top.key AS field, j.value AS value
  FROM notes, json_each(notes.fm) AS top, json_tree(notes.fm, top.fullkey) AS j
  WHERE notes.deletedAt IS NULL AND top.key != 'id' AND j.type = 'text'
    AND (j.value LIKE '%.md' OR length(j.value) = 26)
  ORDER BY notes.path, j.fullkey`;

/** A body link to a note, `[text](../people/dr-okafor.md)`, with an optional `#heading`. */
const LINK = /\]\(<?([^()<>\s]+?\.md)(?:#[^()<>\s]*)?>?\)/g;

/** Every body link in the live notes, as a relation in a field named `body`. */
function bodyLinks(sql: Sql) {
  return sql
    .all<{ id: string; path: string; raw: string }>(
      "SELECT id, path, raw FROM notes WHERE deletedAt IS NULL AND raw LIKE '%](%.md%' ORDER BY path",
    )
    .flatMap(({ id, path, raw }) =>
      Array.from(splitNote(raw).body.matchAll(LINK), ([, link = ""]) => ({
        id,
        path,
        field: "body",
        value: decodeLink(link),
      })),
    );
}

/** A link's path with `%20` and the like decoded, as Obsidian writes a space; one that doesn't decode, as it is. */
function decodeLink(link: string): string {
  try {
    return decodeURIComponent(link);
  } catch {
    return link;
  }
}

/** A path's file name as `pathKey` compares it. */
const fileName = (path: string) => path.normalize("NFC").toLowerCase().split("/").at(-1) ?? "";

/**
 * One hop of the graph from the note hits, best hit first: the notes a hit's relations and body links name, and
 * the notes whose relations or body links name a hit, and, given `now`, the `meets` edges from a note to an
 * application whose requirement it meets then. Edges are read from the notes at query time and resolved as
 * approvals resolve relations (`relationResolver`), so they are always the current revision's. Every neighbor
 * passes `project`.
 */
export function neighbors(
  sql: Sql,
  principal: Principal,
  hits: readonly string[],
  limit: number,
  now: number | undefined,
): Neighbor[] {
  if (hits.length === 0) return [];
  const resolve = relationResolver(sql);
  const isHit = new Set(hits);
  // A relative relation ends with its target's file name, so only those, or a hit's id, can name a hit.
  const names = new Set(
    sql
      .all<{ path: string }>(
        "SELECT path FROM notes WHERE id IN (SELECT value FROM json_each(?))",
        JSON.stringify(hits),
      )
      .map((note) => fileName(note.path)),
  );
  const near = new Map<string, Neighbor[]>(hits.map((id) => [id, []]));
  // `meets` first: a neighbor is listed once, under its first edge, and a letter `for` an application it meets is
  // better read as meeting it.
  const edges = [
    ...(now === undefined ? [] : meetsRelations(sql, principal, now)),
    ...sql.all<{ id: string; path: string; field: string; value: string }>(RELATIONS),
    ...bodyLinks(sql),
  ];
  for (const edge of edges) {
    const fromHit = isHit.has(edge.id);
    if (!fromHit && !isHit.has(edge.value) && !names.has(fileName(edge.value))) continue;
    const to = resolve(edge, edge.value);
    if (to === undefined) continue;
    const { field } = edge;
    if (fromHit) near.get(edge.id)?.push({ noteId: to, via: { noteId: edge.id, field, direction: "out" } });
    if (isHit.has(to)) near.get(to)?.push({ noteId: edge.id, via: { noteId: to, field, direction: "in" } });
  }
  const taken = new Set(hits);
  const result: Neighbor[] = [];
  for (const neighbor of hits.flatMap((id) => near.get(id) ?? [])) {
    if (result.length >= limit) break;
    if (taken.has(neighbor.noteId) || !project(getNote(sql, neighbor.noteId), principal)) continue;
    taken.add(neighbor.noteId);
    result.push(neighbor);
  }
  return result;
}

/**
 * Text as FTS5 holds and matches it: NFC, so a word typed in either Unicode form matches; without the Arabic
 * script's combining marks (harakat) or tatweel, so a vocalized word matches the plain one; and without zero-width
 * joiners, which unicode61 reads as spaces, so Bangla র‍্য and Persian or Urdu words with a ZWNJ stay whole. The
 * tokenizer (schema.ts) keeps other combining marks inside words, so Bangla and Hindi words stay whole.
 */
const fold = (text: string) =>
  text.normalize("NFC").replace(/\u0640|\u200C|\u200D|[\p{Script_Extensions=Arabic}&&\p{Mn}]/gv, "");

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
