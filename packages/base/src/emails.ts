// The emails Brainiac sends the person, each with its own switch: on unless they turned it off. Only the site's
// session route changes one, so turning one off never touches the other.
import type { Sql } from "./sql.ts";

/** Each email, and the meta key that says it's off. */
const OFF = { questions: "questionEmails", reminders: "reminderEmails" } as const;

/** The weekly email of questions (questions.ts), and expiry reminders (reminders.ts). */
export type Email = keyof typeof OFF;

export const isEmail = (value: unknown): value is Email =>
  typeof value === "string" && Object.hasOwn(OFF, value);

export const emailOn = (sql: Sql, email: Email): boolean =>
  sql.all("SELECT 1 FROM meta WHERE key = ? AND value = 'off'", OFF[email]).length === 0;

/** Which emails are on. */
export const emails = (sql: Sql): Record<Email, boolean> => ({
  questions: emailOn(sql, "questions"),
  reminders: emailOn(sql, "reminders"),
});

export function setEmail(sql: Sql, email: Email, on: boolean): void {
  if (on) sql.all("DELETE FROM meta WHERE key = ?", OFF[email]);
  else
    sql.all(
      "INSERT INTO meta (key, value) VALUES (?, 'off') ON CONFLICT (key) DO UPDATE SET value = 'off'",
      OFF[email],
    );
}
