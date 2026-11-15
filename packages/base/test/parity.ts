// Local vs cloud parity: the fixture record, made through the mutation path and indexed, answers the same
// questions for the person and for a connection without the sensitive scope. engines.test.ts runs this on
// bun:sqlite and in a Durable Object and expects identical answers, rank for rank, keyword-only and hybrid.
import {
  changesSince,
  chunkNote,
  listNotes,
  PERSON,
  project,
  putChunks,
  quantize,
  search,
  type Sql,
} from "../src/index.ts";
import { AGENT, type Fixture } from "./cases.ts";
import { record } from "./privacy-cases.ts";

/** What people ask of their record; the canary is planted only in a sensitive note. */
export const QUESTIONS = [
  "IELTS",
  "TUM informatics",
  "Okafor supervisor",
  "Acme intern",
  "Northvale computer science",
  "transcript",
  "CANARY-BODY-7Q3X",
];

/** A stand-in for bge-m3 that is the same on every engine: how often each letter occurs. */
const embed = (text: string) =>
  Array.from("abcdefghijklmnopqrstuvwxyz", (letter) => text.toLowerCase().split(letter).length - 1);

export function answers(sql: Sql, fixtures: readonly Fixture[]) {
  const { ids } = record(sql, fixtures);
  // Ids are made by the record, paths by the fixture: answers name notes by path.
  const paths = new Map(Object.entries(ids).map(([path, id]) => [id, path]));
  const byPath = <T>(value: T): T =>
    JSON.parse(JSON.stringify(value), (_, v: unknown) => (typeof v === "string" ? (paths.get(v) ?? v) : v));
  const searches = (reader: typeof PERSON, vectors: boolean) =>
    Object.fromEntries(
      QUESTIONS.map((q) => [q, byPath(search(sql, reader, q, vectors ? { vector: embed(q) } : {}))]),
    );
  const as = (reader: typeof PERSON) => ({
    notes: listNotes(sql).flatMap((note) => {
      const seen = project(note, reader);
      return seen ? [[seen.path, seen.rev, seen.hash, seen.class, seen.fm]] : [];
    }),
    feed: changesSince(sql, 0, reader),
    search: searches(reader, false),
  });
  const keyword = { person: as(PERSON), agent: as(AGENT) };
  // The same chunks embedded, as the jobs consumer would.
  for (const note of listNotes(sql)) {
    const chunks = chunkNote(note).map((c) => ({ ...c, vector: quantize(embed(`${c.header}\n${c.text}`)) }));
    putChunks(sql, note.id, note.rev, chunks);
  }
  return { ...keyword, hybrid: { person: searches(PERSON, true), agent: searches(AGENT, true) } };
}

export type Answers = ReturnType<typeof answers>;
