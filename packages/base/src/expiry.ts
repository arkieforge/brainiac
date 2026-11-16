// Expiry reminders (docs/product/features/applications.md): the record's alarm wakes on the days an item with an
// `expires` date is 60, 30, 7 and 0 days from it, and the Worker emails the owner what the record lets it say.
// Each reminder goes out once per expiry date: renewing the item (a new date) starts its reminders again.
import { reminderItems } from "@brainiac/core";

import { DAY_MS } from "./hold.ts";
import { listNotes } from "./notes.ts";
import { questionEmails } from "./questions.ts";
import type { Sql } from "./sql.ts";

/** Days before an expiry date that a reminder goes out; 0 is the day itself. */
const REMIND_DAYS = [60, 30, 7, 0] as const;
/** shortcut: 08:00 UTC, like the weekly email, not the person's own morning; upgrade once a record knows its zone. */
const SEND_AT_MS = 8 * 60 * 60_000;
/** A reminder missed by more than this is skipped, so an item filed after its 60-day mark waits for the 30-day one. */
const LATE_MS = 7 * DAY_MS;

/** A reminder due now: `days` before the note's expiry date `expires`. */
export interface DueReminder {
  readonly noteId: string;
  readonly expires: string;
  readonly days: number;
}

/** Each live note with an expiry date: the reminder due now, if any, and when the next one is. */
function schedule(sql: Sql, now: number) {
  const rows = sql.all<{ id: string; expires: string; sent: number | null }>(
    `SELECT id, substr(expires, 1, 10) AS expires,
       (SELECT min(days) FROM reminders
         WHERE reminders.noteId = notes.id AND reminders.expires = substr(notes.expires, 1, 10)) AS sent
     FROM notes WHERE deletedAt IS NULL AND expires IS NOT NULL`,
  );
  return rows.flatMap((row) => {
    const day = Date.parse(row.expires);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.expires) || Number.isNaN(day)) return [];
    // A reminder is sent once; after the 30-day one, only the 7 and 0 are left.
    const times = REMIND_DAYS.filter((days) => row.sent === null || days < row.sent).map((days) => ({
      days,
      at: day + SEND_AT_MS - days * DAY_MS,
    }));
    const passed = times.findLast((t) => t.at <= now);
    return [
      {
        noteId: row.id,
        expires: row.expires,
        due: passed && now - passed.at <= LATE_MS ? passed.days : undefined,
        next: times.find((t) => t.at > now)?.at,
      },
    ];
  });
}

/** The reminders due now, one per note: the latest mark each has passed and not been reminded of. */
export const remindersDue = (sql: Sql, now: number): DueReminder[] =>
  schedule(sql, now).flatMap(({ noteId, expires, due }) =>
    due === undefined ? [] : [{ noteId, expires, days: due }],
  );

/** When the next reminder is due, or null if none is. One already due is due `now`. */
export function nextReminder(sql: Sql, now: number): number | null {
  const times = schedule(sql, now).flatMap(({ due, next }) => (due !== undefined ? [now] : (next ?? [])));
  return times.length > 0 ? Math.min(...times) : null;
}

/** What a reminder email may say: a line per normal item, and how many sensitive ones, which are only counted. */
export interface Reminders {
  readonly lines: readonly string[];
  readonly private: number;
}

const daysBetween = (from: number, day: string) =>
  Math.round((Date.parse(day) - Date.parse(new Date(from).toISOString().slice(0, 10))) / DAY_MS);

/**
 * The email `due` makes, or undefined when there is nothing to send: the person turned emails off, or every due
 * note is superseded or a document of a note that reminds on its own. A sensitive note, and the applications that
 * rely on it, are never named.
 */
export function reminders(sql: Sql, due: readonly DueReminder[], now: number): Reminders | undefined {
  if (due.length === 0 || !questionEmails(sql)) return undefined;
  const rows = listNotes(sql);
  const normal = new Map(rows.filter((row) => row.class === "normal").map((row) => [row.id, row]));
  const notes = rows.map((row) => ({ id: row.id, path: row.path, data: JSON.parse(row.fm) }));
  const told = reminderItems(notes, new Set(due.map((d) => d.noteId)), now);
  const expires = new Map(due.map((d) => [d.noteId, d.expires]));
  const lines = told.flatMap(({ id, label, usedBy }) => {
    const day = expires.get(id);
    if (!normal.has(id) || !day) return [];
    const left = daysBetween(now, day);
    const when =
      left > 0
        ? `expires ${day}, in ${left} ${left === 1 ? "day" : "days"}`
        : left === 0
          ? "expires today"
          : `expired ${day}`;
    const apps = usedBy.flatMap((app) => {
      const row = normal.get(app);
      return row ? [String(JSON.parse(row.fm)["title"] ?? row.path)] : [];
    });
    const rely =
      apps.length === 0 ? "" : ` ${apps.join(", ")} ${apps.length === 1 ? "relies" : "rely"} on it.`;
    return [`${label} ${when}.${rely}`];
  });
  const counted = told.filter(({ id }) => !normal.has(id)).length;
  return lines.length + counted > 0 ? { lines, private: counted } : undefined;
}

/** Records that `due` went out (or had nothing to say), so none of them is sent again. */
export function markReminded(sql: Sql, due: readonly DueReminder[], now: number): void {
  sql.transaction(() => {
    for (const { noteId, expires, days } of due)
      sql.all(
        "INSERT OR IGNORE INTO reminders (noteId, expires, days, at) VALUES (?, ?, ?, ?)",
        noteId,
        expires,
        days,
        now,
      );
  });
}
