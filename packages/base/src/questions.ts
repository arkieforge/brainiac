// The weekly email of questions (docs/product/features/questions.md): what it may say, from the record itself.
// A sensitive question's words never leave the record this way; the email counts it and links to the site.
import { askNow, findQuestions, questionLine } from "@brainiac/core";

import { manifestOf } from "./hold.ts";
import { listNotes } from "./notes.ts";
import type { Sql } from "./sql.ts";

/** What one week's email says: the questions asked now, each normal one in words and the sensitive ones counted. */
export interface Digest {
  readonly lines: readonly string[];
  /** Sensitive questions asked now, named only on the site. */
  readonly private: number;
  /** Questions still waiting beyond these. */
  readonly more: number;
}

const OFF = "questionEmails";

/** Whether the person gets the weekly email; on unless they turned it off. */
export const questionEmails = (sql: Sql): boolean =>
  sql.all("SELECT 1 FROM meta WHERE key = ? AND value = 'off'", OFF).length === 0;

export function setQuestionEmails(sql: Sql, on: boolean): void {
  if (on) sql.all("DELETE FROM meta WHERE key = ?", OFF);
  else
    sql.all(
      "INSERT INTO meta (key, value) VALUES (?, 'off') ON CONFLICT (key) DO UPDATE SET value = 'off'",
      OFF,
    );
}

/** This week's email, or `undefined` when the person turned it off or nothing is waiting: no email then. */
export function digest(sql: Sql, now: number): Digest | undefined {
  if (!questionEmails(sql)) return undefined;
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
    lines: asked.filter((q) => !q.sensitive).map(questionLine),
    private: asked.filter((q) => q.sensitive).length,
    more: open.length - asked.length,
  };
}
