// Expiry reminders (docs/product/features/applications.md): the person hears about an item 60, 30 and 7 days before
// it expires, and on the day. The record's alarm wakes at the start of each of those days (UTC); every item that
// reached a reminder it hasn't had waits in `reminders` until one `remind` job takes them out in one email, which
// the Worker sends to the record's owner (apps/worker/src/reminders.ts). The email names only normal notes: a
// sensitive one (a passport, a test score) is only counted, since the contract keeps its values out of email.
import { expiresIn, nextStageAt, remindable, stageOf, type Stage } from "@brainiac/core";

import { DAY_MS } from "./hold.ts";
import { finishJob } from "./jobs.ts";
import { listNotes } from "./notes.ts";
import type { Sql } from "./sql.ts";

/** The `remind` job's owner: one per record at a time, since one email carries every reminder waiting. */
export const REMINDERS = "reminders";

interface Expiring {
  readonly id: string;
  readonly expires: string;
  /** The expiry and reminder this note last reached, if any. */
  readonly remindedFor: string | null;
  readonly stage: Stage | null;
}

const expiring = (sql: Sql) =>
  sql.all<Expiring>(
    `SELECT notes.id, notes.expires, reminders.expires AS remindedFor, reminders.stage
     FROM notes LEFT JOIN reminders ON reminders.noteId = notes.id
     WHERE notes.deletedAt IS NULL AND notes.expires IS NOT NULL`,
  );

/**
 * The reminder a note reached and hasn't had: a nearer one than last time, or its first for this expiry. An item
 * saved already inside a window gets that window's reminder once; one that changes its expiry starts again.
 */
function reached(row: Expiring, now: number): Stage | undefined {
  const stage = stageOf(row.expires, now);
  if (stage === undefined) return undefined;
  return row.remindedFor !== row.expires || row.stage === null || stage < row.stage ? stage : undefined;
}

/**
 * When to send what waits: now, or a day after a send that failed every attempt; never while a send is on its way
 * or nothing waits.
 */
function sendAt(sql: Sql, now: number): number | undefined {
  if (sql.all("SELECT 1 FROM reminders WHERE sent = 0 LIMIT 1").length === 0) return undefined;
  const [job] = sql.all<{ status: string; dispatchedAt: number | null }>(
    "SELECT status, dispatchedAt FROM jobs WHERE kind = 'remind'",
  );
  if (!job) return now;
  return job.status === "failed" ? Math.max(now, (job.dispatchedAt ?? 0) + DAY_MS) : undefined;
}

/**
 * Records every reminder notes reached by `now`, in the caller's transaction, and says whether a `remind` job
 * should go out for what waits. A failed one goes first: the new job replaces it.
 */
export function remindersDue(sql: Sql, now: number): boolean {
  for (const row of expiring(sql)) {
    const stage = reached(row, now);
    if (stage !== undefined)
      sql.all(
        `INSERT INTO reminders (noteId, expires, stage, sent) VALUES (?, ?, ?, 0)
         ON CONFLICT (noteId) DO UPDATE SET expires = excluded.expires, stage = excluded.stage, sent = 0`,
        row.id,
        row.expires,
        stage,
      );
  }
  const at = sendAt(sql, now);
  if (at === undefined || at > now) return false;
  sql.all("DELETE FROM jobs WHERE kind = 'remind'");
  return true;
}

/** When the record next wakes for a reminder: a note reaching one, or a send due; undefined if none is coming. */
export function nextReminder(sql: Sql, now: number): number | undefined {
  const rows = expiring(sql);
  if (rows.some((row) => reached(row, now) !== undefined)) return now;
  const times = [sendAt(sql, now), ...rows.map((row) => nextStageAt(row.expires, now))].filter(
    (at) => at !== undefined,
  );
  return times.length > 0 ? Math.min(...times) : undefined;
}

/** One reminder as it waits: the note, and the expiry and reminder it reached. */
export interface Waiting {
  readonly noteId: string;
  readonly expires: string;
  readonly stage: Stage;
}

/**
 * What one reminder email says, from the record: each normal item that waits, in words, and the sensitive ones
 * counted. `covered` is every reminder it answers, sent or skipped (an item superseded or deleted since, or one
 * past that reminder already, is never named), for `installReminders` to mark done.
 */
export interface Reminder {
  readonly lines: readonly string[];
  readonly private: number;
  readonly covered: readonly Waiting[];
}

export function reminderWork(sql: Sql, now: number): Reminder {
  const covered = sql.all<Waiting>("SELECT noteId, expires, stage FROM reminders WHERE sent = 0");
  const notes = listNotes(sql).map((note) => ({
    id: note.id,
    path: note.path,
    data: JSON.parse(note.fm),
    class: note.class,
  }));
  const due = new Map(remindable(notes, now).map((item) => [item.note.id, item]));
  const named = covered.flatMap((row) => {
    const item = due.get(row.noteId);
    return item && item.stage === row.stage && item.note.data["expires"] === row.expires ? [item.note] : [];
  });
  return {
    lines: named
      .filter((note) => note.class === "normal")
      .map(
        (note) =>
          `${note.data["title"] ?? note.path} expires ${expiresIn(String(note.data["expires"]), now)}`,
      ),
    private: named.filter((note) => note.class === "sensitive").length,
    covered,
  };
}

/** Marks the reminders an email answered as sent, unless a note has reached another since, and finishes its job. */
export function installReminders(
  sql: Sql,
  jobId: string,
  covered: readonly Waiting[],
): "installed" | "dropped" {
  return finishJob(sql, jobId, () => {
    for (const row of covered)
      sql.all(
        "UPDATE reminders SET sent = 1 WHERE noteId = ? AND expires = ? AND stage = ?",
        row.noteId,
        row.expires,
        row.stage,
      );
  });
}
