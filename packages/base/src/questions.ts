// The weekly email of questions (docs/product/features/questions.md): what it may say, from the record itself.
// A sensitive question's words never leave the record this way, nor background filing's (mail apps make links of
// them); the email counts them and links to the site.
import { askNow, findQuestions, questionLine } from "@brainiac/core";

import { emailOn } from "./emails.ts";
import { manifestOf } from "./hold.ts";
import { listNotes } from "./notes.ts";
import type { Sql } from "./sql.ts";

/** What one week's email says: the questions asked now, each normal one in words and the sensitive ones counted. */
export interface Digest {
  readonly lines: readonly string[];
  /** Sensitive questions asked now, named only on the site. */
  readonly private: number;
  /** Background filing's questions asked now, named only on the site. */
  readonly filer: number;
  /** Questions still waiting beyond these. */
  readonly more: number;
}

/** This week's email, or `undefined` when the person turned it off or nothing is waiting: no email then. */
export function digest(sql: Sql, now: number): Digest | undefined {
  if (!emailOn(sql, "questions")) return undefined;
  const notes = listNotes(sql).map((note) => ({
    id: note.id,
    path: note.path,
    data: JSON.parse(note.fm),
    class: note.class,
  }));
  const open = findQuestions(notes, manifestOf(sql) ?? null, now);
  const asked = askNow(open, now);
  if (asked.length === 0) return undefined;
  return {
    lines: asked.filter((q) => !q.sensitive && !q.filer).map(questionLine),
    private: asked.filter((q) => q.sensitive).length,
    filer: asked.filter((q) => q.filer && !q.sensitive).length,
    more: open.length - asked.length,
  };
}
