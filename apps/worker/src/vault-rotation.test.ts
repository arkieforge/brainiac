// The rotation sweep against real Postgres (PGlite) with every migration deploys apply. Rewrapping itself is
// proved in packages/base (vault-cases.ts) and workerd (test/rotation.test.ts); this is which records it wakes and
// what the doctor's count says.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vite-plus/test";

import { rewrapRecords, waitingToRewrap } from "./vault-rotation.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../infra/migrations");

it("wakes each record not yet on the current key, counts it until it rewraps, and never again after", async () => {
  const db = new PGlite();
  for (const file of readdirSync(MIGRATIONS).toSorted())
    await db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  // Fictional people, tagged as `vp run dev:sign-in --as` makes them. A deleted record still holds sealed files.
  for (const [tag, deleted] of [
    ["ada", null],
    ["ada+gone", "2026-11-01"],
    ["ada+broken", null],
  ] as const) {
    await db.query(
      `insert into "user" ("id", "name", "email", "emailVerified") values ($1, 'Ada', $2, true)`,
      [tag, `${tag}@example.edu`],
    );
    await db.query(`insert into "bases" ("id", "ownerId", "deletedAt") values ($1, $1, $2)`, [tag, deleted]);
  }
  expect(await waitingToRewrap(db, "key-two")).toBe(3);

  const woken: string[] = [];
  const records = (id: string) => ({
    rewrapDataKey: async () => {
      woken.push(id);
      if (id === "ada+broken") throw new Error("wrapped by vault key key-zero");
      return "key-two";
    },
  });
  expect(await rewrapRecords(db, "key-two", records)).toEqual({ rewrapped: 2, failed: 1 });
  expect(await waitingToRewrap(db, "key-two")).toBe(1);

  woken.length = 0;
  expect(await rewrapRecords(db, "key-two", records)).toEqual({ rewrapped: 0, failed: 1 });
  expect(woken).toEqual(["ada+broken"]);
  // The next rotation counts every record again.
  expect(await waitingToRewrap(db, "key-three")).toBe(3);
});
