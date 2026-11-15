// Local vs cloud parity: the fixture record, made through the mutation path and indexed, answers the same
// questions for the person and for a connection without the sensitive scope. engines.test.ts runs this on
// bun:sqlite and in a Durable Object and expects identical answers, rank for rank.
import { changesSince, listNotes, PERSON, project, search, type Sql } from "../src/index.ts";
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

export function answers(sql: Sql, fixtures: readonly Fixture[]) {
  const { ids } = record(sql, fixtures);
  const paths = new Map(Object.entries(ids).map(([path, id]) => [id, path]));
  const as = (reader: typeof PERSON) => ({
    notes: listNotes(sql).flatMap((note) => {
      const seen = project(note, reader);
      return seen ? [[seen.path, seen.rev, seen.hash, seen.class, seen.fm]] : [];
    }),
    feed: changesSince(sql, 0, reader),
    search: Object.fromEntries(
      QUESTIONS.map((q) => [q, search(sql, reader, q).map((hit) => [paths.get(hit.noteId), hit.rank])]),
    ),
  });
  return { person: as(PERSON), agent: as(AGENT) };
}

export type Answers = ReturnType<typeof answers>;
