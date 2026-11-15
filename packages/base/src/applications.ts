// Applications' requirement checks over the record's SQL (docs/product/features/applications.md): the notes a
// check reads, as one reader may see them, judged by `requirementsOf` in @brainiac/core so every surface agrees.
import { meetsEdges, requirementsOf, type ReviewNote } from "@brainiac/core";

import { listNotes, type NoteRow } from "./notes.ts";
import { project, type Principal } from "./project.ts";
import type { Sql } from "./sql.ts";

const asReview = (note: NoteRow): ReviewNote => ({ id: note.id, path: note.path, data: JSON.parse(note.fm) });

const isMapping = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The type each requirement's check reads, if it names one. */
const checkTypes = (application: ReviewNote) =>
  [application.data["requirements"]].flat().flatMap((item) => {
    const check = isMapping(item) ? item["check"] : undefined;
    return isMapping(check) && typeof check["type"] === "string" ? [check["type"]] : [];
  });

/**
 * The notes `applications`' checks read, as `reader` may see them: the applications and every live note of a type
 * a check names, so a requirement is judged only on what the reader could check for itself.
 */
function checkedNotes(sql: Sql, reader: Principal, applications: readonly ReviewNote[]): ReviewNote[] {
  const types = new Set(applications.flatMap(checkTypes));
  const ids = new Set(applications.map((application) => application.id));
  const read = [...types]
    .flatMap((type) => listNotes(sql, { type }))
    .filter((note) => !ids.has(note.id) && project(note, reader));
  return [...applications, ...read.map(asReview)];
}

/** What a requirement says to a reader: met with the notes behind it, or why not. */
export type Checks = ReturnType<typeof checksOf>;

/**
 * An application's requirements as `reader` reads them, as of `now`: passing with the notes that meet each, failing
 * with why. A reader that can't see every note (no sensitive scope, or a type scope) can't tell a computed check is
 * failing, as a note it can't see may meet it, so those are unsure; a manual one stays failing until ticked.
 */
export function checksOf(sql: Sql, reader: Principal, application: NoteRow, now: number) {
  const note = asReview(application);
  const judged = requirementsOf(note, checkedNotes(sql, reader, [note]), now);
  const partial = !reader.sensitive || reader.types !== undefined;
  const items = [note.data["requirements"]].flat();
  const missing = judged.flatMap((requirement, i) => {
    if (requirement.status === "met") return [];
    const check = isMapping(items[i]) ? items[i]["check"] : undefined;
    return [{ need: requirement.need, why: requirement.why ?? "", unsure: partial && isMapping(check) }];
  });
  return {
    passing: judged.flatMap(({ need, status, by }) => (status === "met" ? [{ need, by }] : [])),
    failing: missing.filter((m) => !m.unsure).map(({ need, why }) => ({ need, why })),
    ...(partial && {
      unsure: missing
        .filter((m) => m.unsure)
        .map(({ need, why }) => ({
          need,
          why: `${why}. This connection can't see every note, so one it can't see may meet it`,
        })),
    }),
  };
}

/**
 * The `meets` edges `reader` may follow as of `now`, as relations: from each note that meets a requirement to its
 * application, while the check passes on the notes the reader can see.
 */
export function meetsRelations(sql: Sql, reader: Principal, now: number) {
  const applications = listNotes(sql, { type: "Application" }).filter((note) => project(note, reader));
  if (applications.length === 0) return [];
  const notes = checkedNotes(sql, reader, applications.map(asReview));
  const paths = new Map(notes.map((note) => [note.id, note.path]));
  return meetsEdges(notes, now).map(({ from, to }) => ({
    id: from,
    path: paths.get(from) ?? "",
    field: "meets",
    value: to,
  }));
}
