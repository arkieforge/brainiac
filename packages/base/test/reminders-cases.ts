// Conformance cases for expiry reminders, the record's half: the alarm wakes at 60, 30 and 7 days before an item
// expires and on the day, each reminder goes out once in one email for everything waiting, a sensitive item is
// only counted, and a send that keeps failing waits a day rather than looping. cases.ts runs them on both engines.
import { deepStrictEqual as same, equal, ok } from "node:assert/strict";

import {
  DAY_MS,
  digest,
  dueJobs,
  emails,
  getNote,
  installReminders,
  jobInput,
  markDispatched,
  MAX_ATTEMPTS,
  migrate,
  mutate,
  nextReminder,
  nextWake,
  reminderWork,
  setEmail,
  type Context,
  type Sql,
} from "../src/index.ts";
import type { Case, Fixture } from "./cases.ts";

const day = (d: string) => Date.parse(`${d}T00:00:00Z`);
const T0 = day("2026-11-15") + 9 * 3_600_000;
const human = (now = T0): Context => ({ actor: "human", now });

const note = (id: string, type: string, title: string, expires: string, extra: readonly string[] = []) =>
  ["---", `id: ${id}`, `type: ${type}`, `title: ${title}`, `expires: ${expires}`, ...extra, "---", ""].join(
    "\n",
  );

/** A fictional record: a normal certificate and a sensitive passport, both expiring on 2026-12-20. */
function record(sql: Sql, fixtures: readonly Fixture[]) {
  migrate(sql);
  const manifest = fixtures.find((f) => f.path === "okf-base.yaml");
  ok(manifest);
  sql.all("INSERT INTO schema (version, manifest) VALUES (1, ?)", manifest.raw);
  const create = (path: string, raw: string, cls: "normal" | "sensitive") => {
    const created = mutate(sql, { op: "create", path, raw, class: cls }, human());
    ok(created.status === "applied", JSON.stringify(created));
    return created.noteId;
  };
  const certificate = create(
    "documents/aps-certificate.md",
    note("01M7AAAAAAAAAAAAAAAAAAAAAA", "Document", "APS certificate", "2026-12-20", ["kind: certificate"]),
    "normal",
  );
  const passport = create(
    "identity/passport-uto.md",
    note("01M7BBBBBBBBBBBBBBBBBBBBBB", "IdDocument", "Passport, Utopia", "2026-12-20", [
      "kind: passport",
      "issuer: UTO",
    ]),
    "sensitive",
  );
  // Index jobs aren't what these cases are about.
  sql.all("DELETE FROM jobs");
  return { certificate, passport };
}

/** The remind job due at `now`, dispatched, with what its email says. */
function send(sql: Sql, now: number) {
  const job = dueJobs(sql, now).find((j) => j.kind === "remind");
  ok(job, "no remind job");
  markDispatched(sql, [job.id], now);
  ok(jobInput(sql, job.id), "the remind job went stale");
  return { id: job.id, reminder: reminderWork(sql, now) };
}

const reminds = (sql: Sql, now: number) => dueJobs(sql, now).filter((j) => j.kind === "remind");

const set = (sql: Sql, id: string, expires: string, now: number) => {
  const rev = getNote(sql, id)?.rev ?? 0;
  const result = mutate(
    sql,
    { op: "patch", noteId: id, baseRev: rev, ops: [{ op: "set", path: ["expires"], value: expires }] },
    human(now),
  );
  ok(result.status === "applied", JSON.stringify(result));
  sql.all("DELETE FROM jobs WHERE kind = 'index'");
};

export const remindersCases: Record<string, Case> = {
  "an expiring item is reminded once at each of 60, 30, 7 and 0 days, in one email, naming only normal notes":
    (sql, fixtures) => {
      const { certificate } = record(sql, fixtures);
      // 35 days out: both reached the 60-day reminder when they were saved, so the record wakes now.
      equal(nextWake(sql, T0), T0);
      const first = send(sql, T0);
      same(first.reminder.lines, ["APS certificate expires 2026-12-20, in 35 days"]);
      // The passport is sensitive: counted, never named.
      equal(first.reminder.private, 1);
      equal(first.reminder.covered.length, 2);
      equal(installReminders(sql, first.id, first.reminder.covered), "installed");
      // Sent once: nothing more until the 30-day reminder, at the start of that day.
      same(reminds(sql, T0 + 1), []);
      equal(nextWake(sql, T0 + 1), day("2026-11-20"));
      // History past its window wakes the record from mid-December too; from here only the reminders' own times count.
      same(reminds(sql, day("2026-11-20") - 1), []);
      const thirty = send(sql, day("2026-11-20"));
      same(thirty.reminder.lines, ["APS certificate expires 2026-12-20, in 30 days"]);
      equal(installReminders(sql, thirty.id, thirty.reminder.covered), "installed");
      for (const [at, line] of [
        ["2026-12-13", "APS certificate expires 2026-12-20, in 7 days"],
        ["2026-12-20", "APS certificate expires 2026-12-20, today"],
      ] as const) {
        equal(nextReminder(sql, day(at) - DAY_MS), day(at));
        const sent = send(sql, day(at));
        same(sent.reminder.lines, [line]);
        installReminders(sql, sent.id, sent.reminder.covered);
      }
      // After the day itself nothing more comes; the review's flags carry it from there.
      equal(nextReminder(sql, day("2026-12-20") + 1), undefined);
      same(reminds(sql, day("2026-12-25")), []);

      // A renewal pushes the expiry out of the window: no reminder; one saved already 5 days out gets its 7-day one.
      set(sql, certificate, "2027-12-20", day("2026-12-21"));
      same(reminds(sql, day("2026-12-21")), []);
      set(sql, certificate, "2026-12-26", day("2026-12-21"));
      const late = send(sql, day("2026-12-21"));
      same(late.reminder.lines, ["APS certificate expires 2026-12-26, in 5 days"]);
    },

  "a superseded item is never named, and a send that fails every attempt waits a day": (sql, fixtures) => {
    const { certificate } = record(sql, fixtures);
    const first = send(sql, T0);
    equal(installReminders(sql, first.id, first.reminder.covered), "installed");
    // A newer certificate supersedes the old one before its 30-day reminder: only the new one is named.
    const newer = mutate(
      sql,
      {
        op: "create",
        path: "documents/aps-certificate-2027.md",
        raw: note("01M7CCCCCCCCCCCCCCCCCCCCCC", "Document", "APS certificate, renewed", "2027-01-10", [
          "supersedes: aps-certificate.md",
        ]),
        class: "normal",
      },
      human(day("2026-11-19")),
    );
    ok(newer.status === "applied");
    sql.all("DELETE FROM jobs WHERE kind = 'index'");
    const second = send(sql, day("2026-11-20"));
    same(second.reminder.lines, [
      "APS certificate, renewed expires 2027-01-10, in 51 days",
      // The passport's 30-day reminder, counted.
    ]);
    equal(second.reminder.private, 1);
    ok(second.reminder.covered.some((row) => row.noteId === certificate));

    // The send fails every attempt: the job is marked failed, and the reminders wait a day, then go again.
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++)
      markDispatched(sql, [second.id], day("2026-11-20") + attempt);
    const failedAt = day("2026-11-20") + MAX_ATTEMPTS * 60 * 60_000;
    same(reminds(sql, failedAt), []);
    equal(sql.all<{ status: string }>("SELECT status FROM jobs WHERE kind = 'remind'")[0]?.status, "failed");
    const retry = (nextWake(sql, failedAt) ?? 0) - day("2026-11-20");
    ok(retry > 0 && retry <= DAY_MS + MAX_ATTEMPTS, `retries after ${retry} ms`);
    const again = send(sql, day("2026-11-21") + MAX_ATTEMPTS);
    equal(again.reminder.covered.length, second.reminder.covered.length);
    equal(installReminders(sql, again.id, again.reminder.covered), "installed");
    same(reminds(sql, day("2026-11-21") + MAX_ATTEMPTS + 1), []);
  },

  "turning reminders off stops them and leaves the weekly email on, and the reverse": (sql, fixtures) => {
    record(sql, fixtures);
    setEmail(sql, "reminders", false);
    same(emails(sql), { questions: true, reminders: false });
    // Both items reach their 60-day reminder, and no email goes; the record doesn't keep waking for it either.
    same(reminds(sql, T0), []);
    equal(nextReminder(sql, T0 + 1), day("2026-11-20"));

    // On again: the next reminder comes, not the one reached while off.
    setEmail(sql, "reminders", true);
    same(reminds(sql, T0 + 1), []);
    const thirty = send(sql, day("2026-11-20"));
    same(thirty.reminder.lines, ["APS certificate expires 2026-12-20, in 30 days"]);
    equal(thirty.reminder.private, 1);
    // Turned off after the job was queued: it says nothing, so no email goes, and what it covered counts as had.
    setEmail(sql, "reminders", false);
    same(reminderWork(sql, day("2026-11-20")), { lines: [], private: 0, covered: thirty.reminder.covered });
    equal(installReminders(sql, thirty.id, thirty.reminder.covered), "installed");
    same(reminds(sql, day("2026-11-20") + 1), []);

    // The reverse: the weekly email off leaves reminders on.
    setEmail(sql, "reminders", true);
    setEmail(sql, "questions", false);
    same(emails(sql), { questions: false, reminders: true });
    equal(digest(sql, day("2026-12-13")), undefined);
    const seven = send(sql, day("2026-12-13"));
    same(seven.reminder.lines, ["APS certificate expires 2026-12-20, in 7 days"]);
  },
};
