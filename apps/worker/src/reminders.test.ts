// Expiry reminder emails against real Postgres (PGlite) with every migration deploys apply. When a reminder is due
// and what it may name is proved in packages/base (reminders-cases.ts); this is who gets one, what it says, and the
// queue consumer handing it over and marking it sent.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Reminder } from "@brainiac/base";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vite-plus/test";

import type { JobMessage, JobWork } from "./base.ts";
import type { Env } from "./env.ts";
import { consume, type Models, type Ocr } from "./jobs.ts";
import { remind, reminderEmail } from "./reminders.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../infra/migrations");
const ORIGIN = "https://brainiac.example";
const REMINDER: Reminder = {
  lines: ["APS certificate expires 2026-12-20, in 30 days"],
  private: 1,
  covered: [
    { noteId: "01M7AAAAAAAAAAAAAAAAAAAAAA", expires: "2026-12-20", stage: 30 },
    { noteId: "01M7BBBBBBBBBBBBBBBBBBBBBB", expires: "2026-12-20", stage: 30 },
  ],
};

it("emails a live record's verified owner, and nobody else", async () => {
  const db = new PGlite();
  for (const file of readdirSync(MIGRATIONS).toSorted())
    await db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  // Fictional people, tagged as `vp run dev:sign-in --as` makes them.
  for (const [tag, verified, deleted] of [
    ["ada", true, null],
    ["ada+unverified", false, null],
    ["ada+gone", true, "2026-11-01"],
  ] as const) {
    await db.query(`insert into "user" ("id", "name", "email", "emailVerified") values ($1, 'Ada', $2, $3)`, [
      tag,
      `${tag}@example.edu`,
      verified,
    ]);
    await db.query(`insert into "bases" ("id", "ownerId", "deletedAt") values ($1, $1, $2)`, [tag, deleted]);
  }
  const mail: { to: string }[] = [];
  const send = remind(db, async (message) => void mail.push(message), ORIGIN);
  for (const base of ["ada", "ada+unverified", "ada+gone", "nobody"]) await send(base, REMINDER);
  // Nothing left to say (renewed or superseded since): no email, not even a lookup.
  await send("ada", { lines: [], private: 0, covered: REMINDER.covered });
  expect(mail.map((m) => m.to)).toEqual(["ada@example.edu"]);
});

it("names only normal items, and its subject names nothing", () => {
  const email = reminderEmail("ada@example.edu", REMINDER, ORIGIN);
  expect(email.subject).toBe("Something in your Brainiac record expires soon");
  expect(email.text).toContain("- APS certificate expires 2026-12-20, in 30 days");
  expect(email.text).toContain("1 private item too, shown only when you sign in.");
  expect(email.text).toContain(`${ORIGIN}/`);
  expect(reminderEmail("ada@example.edu", { ...REMINDER, lines: [] }, ORIGIN).text).not.toContain("- ");
});

it("the queue hands a remind job's email over, then marks what it covered sent", async () => {
  const calls: unknown[] = [];
  const record = {
    jobInput: async (): Promise<JobWork> => ({ kind: "remind", reminder: REMINDER }),
    installReminders: async (jobId: string, covered: unknown) => void calls.push(["install", jobId, covered]),
  };
  const env = {
    BASE: { idFromString: (id: string) => id, get: () => record },
    TREG_TOKEN: undefined,
    BROWSER: undefined,
    AI: {} as Models,
    OCR: {} as Ocr,
  } as unknown as Pick<Env, "BASE" | "TREG_TOKEN" | "BROWSER"> & { readonly AI: Models; readonly OCR: Ocr };
  const acked: string[] = [];
  const batch = {
    messages: [
      {
        body: { base: "ada", jobId: "job-1" },
        ack: () => void acked.push("job-1"),
        retry: () => void acked.push("retry"),
      },
    ],
  } as unknown as MessageBatch<JobMessage>;
  await consume(batch, env, fetch, async (base, reminder) => void calls.push(["remind", base, reminder]));
  expect(calls).toEqual([
    ["remind", "ada", REMINDER],
    ["install", "job-1", REMINDER.covered],
  ]);
  expect(acked).toEqual(["job-1"]);
});
