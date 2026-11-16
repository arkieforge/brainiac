// Expiry reminder emails against real Postgres (PGlite) with every migration deploys apply. When a reminder is due
// and what it may say is proved in packages/base (expiry-cases.ts); this is who gets one and what it looks like.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vite-plus/test";

import { reminderEmail, sendReminders } from "./reminders.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../infra/migrations");
const ORIGIN = "https://brainiac.example";
const SAID = {
  lines: ["Passport scan expires 2027-01-31, in 30 days. TUM MSc Informatics, Winter 2027 relies on it."],
  private: 2,
};

it("emails the record's verified owner, and nobody for a deleted record or an unverified address", async () => {
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
  const mail: string[] = [];
  for (const base of ["ada", "ada+unverified", "ada+gone"])
    await sendReminders(db, base, SAID, async ({ to }) => void mail.push(to), ORIGIN);
  expect(mail).toEqual(["ada@example.edu"]);
});

it("names only normal items, and its subject says only how many", () => {
  const email = reminderEmail("ada@example.edu", SAID, ORIGIN);
  expect(email.subject).toBe("3 items in your Brainiac record expire soon");
  expect(email.text).toContain("- Passport scan expires 2027-01-31, in 30 days.");
  expect(email.text).toContain("2 private items too, shown only when you sign in.");
  expect(email.text).toContain(`${ORIGIN}/review`);
  expect(reminderEmail("ada@example.edu", { lines: [], private: 1 }, ORIGIN).subject).toBe(
    "1 item in your Brainiac record expires soon",
  );
});
