// The weekly questions email against real Postgres (PGlite) with every migration deploys apply. What a record
// lets an email say is proved in packages/base (tool-cases.ts); this is who gets one and what it looks like.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Digest } from "@brainiac/base";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vite-plus/test";

import { digestEmail, sendDigests } from "./digest.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../infra/migrations");
const ORIGIN = "https://brainiac.example";

it("emails each live record's verified owner who has questions waiting, and nobody else", async () => {
  const db = new PGlite();
  for (const file of readdirSync(MIGRATIONS).toSorted())
    await db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  // Fictional people, tagged as `vp run dev:sign-in --as` makes them.
  const people = [
    ["ada", true, null],
    ["ada+quiet", true, null],
    ["ada+unverified", false, null],
    ["ada+gone", true, "2026-11-01"],
    ["ada+broken", true, null],
  ] as const;
  for (const [tag, verified, deleted] of people) {
    await db.query(`insert into "user" ("id", "name", "email", "emailVerified") values ($1, 'Ada', $2, $3)`, [
      tag,
      `${tag}@example.edu`,
      verified,
    ]);
    await db.query(`insert into "bases" ("id", "ownerId", "deletedAt") values ($1, $1, $2)`, [tag, deleted]);
  }
  const waiting: Digest = {
    lines: ["When did your role at Acme Robotics end? (Your Role has no end yet)"],
    private: 1,
    filer: 0,
    more: 3,
  };
  const mail: { to: string; subject: string; text: string }[] = [];
  const result = await sendDigests(
    db,
    (id) => ({
      questionDigest: () => {
        if (id === "ada+broken") throw new Error("the record is down");
        return id === "ada+quiet" ? undefined : waiting;
      },
    }),
    async (message) => void mail.push(message),
    ORIGIN,
  );
  expect(result).toEqual({ sent: 1, failed: 1 });
  expect(mail.map((m) => m.to)).toEqual(["ada@example.edu"]);
});

it("names only normal questions, and its subject says only how many", () => {
  const email = digestEmail(
    "ada@example.edu",
    {
      lines: ["When did your role at Acme Robotics end? (Your Role has no end yet)"],
      private: 2,
      filer: 1,
      more: 0,
    },
    ORIGIN,
  );
  expect(email.subject).toBe("4 questions about your Brainiac record");
  expect(email.text).toContain("- When did your role at Acme Robotics end?");
  expect(email.text).toContain("2 private questions, shown only when you sign in.");
  expect(email.text).toContain("1 question from background filing, shown only when you sign in.");
  expect(email.text).toContain(`${ORIGIN}/questions`);
  expect(email.text).not.toContain("more wait");
});
