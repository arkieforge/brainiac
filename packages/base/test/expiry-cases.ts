// Conformance cases for expiry reminders: each mark (60, 30, 7, 0 days) goes out once, a late one is skipped, a
// renewed date starts again, and what the email may say about each item. cases.ts runs them on both engines.
import { deepStrictEqual as same, equal, ok } from "node:assert/strict";

import { parseNote } from "@brainiac/core";

import {
  DAY_MS,
  getNote,
  markReminded,
  migrate,
  mutate,
  nextReminder,
  nextWake,
  putNote,
  reminders,
  remindersDue,
  setQuestionEmails,
  type Context,
  type Sql,
} from "../src/index.ts";
import type { Case, Fixture } from "./cases.ts";

const T0 = Date.UTC(2026, 10, 15);
const revOf = (sql: Sql, id: string) => getNote(sql, id)?.rev ?? -1;
const human = (now = T0): Context => ({ actor: "human", now });
const PASSPORT = [
  "---",
  "id: 01M6AM78G0STS7TB29G7A10PPT",
  "type: Document",
  "title: Passport scan",
  "kind: id",
  "expires: 2027-01-31",
  "---",
  "",
].join("\n");
/** When the reminder `days` before 2027-01-31 goes out: 08:00 UTC that day. */
const mark = (days: number) => Date.UTC(2027, 0, 31, 8) - days * DAY_MS;

/** A record with the fixture's manifest and the given fixture notes, stored as the fixture has them. */
function record(sql: Sql, fixtures: readonly Fixture[], paths: readonly string[] = []) {
  migrate(sql);
  const manifest = fixtures.find((f) => f.path === "okf-base.yaml");
  ok(manifest);
  sql.all("INSERT INTO schema (version, manifest) VALUES (1, ?)", manifest.raw);
  return new Map(
    paths.map((path, i) => {
      const fixture = fixtures.find((f) => f.path === path);
      ok(fixture, path);
      const id = String(parseNote(fixture.raw).data["id"]);
      const kind = path.startsWith("facts/tests/") ? "sensitive" : "normal";
      putNote(sql, { id, path, raw: fixture.raw, rev: 1, hash: `hash-${i}`, seq: i + 1, class: kind });
      return [path, id];
    }),
  );
}

const passport = (sql: Sql) => {
  const made = mutate(
    sql,
    { op: "create", path: "documents/passport.md", raw: PASSPORT, class: "normal" },
    human(),
  );
  ok(made.status === "applied", JSON.stringify(made));
  return made.noteId;
};

export const expiryCases: Record<string, Case> = {
  "an expiry reminder goes out at each mark once, the alarm wakes for the next, and a late one is skipped": (
    sql,
    fixtures,
  ) => {
    record(sql, fixtures);
    const id = passport(sql);
    equal(nextReminder(sql, T0), mark(60));
    ok((nextWake(sql, T0 + 10) ?? Infinity) <= mark(60));
    same(remindersDue(sql, mark(60) - 1), []);
    const due = remindersDue(sql, mark(60));
    same(due, [{ noteId: id, expires: "2027-01-31", days: 60 }]);
    same(reminders(sql, due, mark(60)), {
      lines: ["Passport scan expires 2027-01-31, in 60 days."],
      private: 0,
    });
    markReminded(sql, due, mark(60));
    // Sent once: the same mark isn't due again, and the alarm points at the next one.
    same(remindersDue(sql, mark(60) + DAY_MS), []);
    equal(nextReminder(sql, mark(60) + DAY_MS), mark(30));
    // The alarm never fired for the 30-day mark; three weeks on, only the 7-day one goes out.
    const late = remindersDue(sql, mark(7));
    same(late, [{ noteId: id, expires: "2027-01-31", days: 7 }]);
    markReminded(sql, late, mark(7));
    equal(nextReminder(sql, mark(7)), mark(0));
    const today = remindersDue(sql, mark(0) + 60_000);
    same(reminders(sql, today, mark(0) + 60_000)?.lines, ["Passport scan expires today."]);
    markReminded(sql, today, mark(0));
    same(remindersDue(sql, mark(0) + 30 * DAY_MS), []);
    equal(nextReminder(sql, mark(0) + 1), null);
  },

  "a renewed expiry date starts its reminders again": (sql, fixtures) => {
    record(sql, fixtures);
    const id = passport(sql);
    const due = remindersDue(sql, mark(7));
    markReminded(sql, due, mark(7));
    const renewed = mutate(
      sql,
      {
        op: "patch",
        noteId: id,
        baseRev: revOf(sql, id),
        ops: [{ op: "set", path: ["expires"], value: "2037-01-31" }],
      },
      human(mark(7) + 1),
    );
    equal(renewed.status, "applied");
    same(remindersDue(sql, mark(7) + 1), []);
    equal(nextReminder(sql, mark(7) + 1), Date.UTC(2037, 0, 31, 8) - 60 * DAY_MS);
  },

  "a reminder names the applications relying on a normal item, only counts a sensitive one, and skips superseded notes and a document of a note with its own expiry":
    (sql, fixtures) => {
      const ids = record(sql, fixtures, [
        "applications/tum-msc-informatics-2027/application.md",
        "facts/tests/ielts-2025-03.md",
        "facts/tests/ielts-2026-11.md",
        "documents/ielts-trf-2026.md",
        "documents/transcript-bsc.md",
      ]);
      const transcript = ids.get("documents/transcript-bsc.md");
      ok(transcript);
      const dated = mutate(
        sql,
        {
          op: "patch",
          noteId: transcript,
          baseRev: revOf(sql, transcript),
          ops: [{ op: "set", path: ["expires"], value: "2026-12-15" }],
        },
        human(),
      );
      equal(dated.status, "applied");
      const now = Date.UTC(2026, 10, 15, 8);
      // Every dated note due at once, to see which of them the email names.
      const due = [...ids]
        .filter(([path]) => !path.startsWith("applications/"))
        .map(([, noteId]) => ({ noteId, expires: "2026-12-15", days: 30 }));
      // The old IELTS is superseded, the TRF proves the new one, which says its own expiry: one private item.
      same(reminders(sql, due, now), {
        lines: [
          "Bachelor transcript, Northvale University expires 2026-12-15, in 30 days. TUM MSc Informatics, Winter 2027 relies on it.",
        ],
        private: 1,
      });
      // Turned off, nothing goes out; the alarm marks it sent all the same, so nothing piles up for later.
      setQuestionEmails(sql, false);
      equal(reminders(sql, due, now), undefined);
    },
};
