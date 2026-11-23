// The registry against real Postgres (PGlite), with every migration deploys apply.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { baseOf, type Db } from "./registry.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../infra/migrations");

// Fictional people: the fixture student and a tagged second account, as `vp run dev:sign-in --as` makes.
const ADA = "user-ada";
const OTHER = "user-ada-other";

let db: PGlite;
let ids = 0;
const newId = () => `${++ids}`.padStart(64, "0");

beforeEach(async () => {
  db = new PGlite();
  for (const file of readdirSync(MIGRATIONS).toSorted()) {
    await db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  await db.query(
    `insert into "user" ("id", "name", "email", "emailVerified") values ($1, 'Nadia Karim', 'nadia.karim@example.edu', true), ($2, 'Nadia Karim', 'nadia.karim+other@example.edu', true)`,
    [ADA, OTHER],
  );
});

describe("the base registry", () => {
  it("gives two racing first lookups the same record", async () => {
    const inserts: string[] = [];
    const watched: Db = {
      query: (text, values) => {
        if (text.startsWith("insert")) inserts.push(String(values[0]));
        return db.query(text, values);
      },
    };
    const [first, second] = await Promise.all([baseOf(watched, ADA, newId), baseOf(watched, ADA, newId)]);
    // Both found nothing and both inserted, so the race really ran: one insert won, and both read its row.
    expect(inserts).toHaveLength(2);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(await baseOf(db, ADA, newId)).toBe(first);
    expect((await db.query(`select "id" from "bases"`)).rows).toHaveLength(1);
  });

  it("gives each person their own record, and never another's", async () => {
    const ada = await baseOf(db, ADA, newId);
    const other = await baseOf(db, OTHER, newId);
    expect(other).not.toBe(ada);
    expect(await baseOf(db, ADA, newId)).toBe(ada);
    expect(await baseOf(db, OTHER, newId)).toBe(other);
  });

  it("reaches no record once it is deleted, and makes no new one in its place", async () => {
    const ada = await baseOf(db, ADA, newId);
    await db.query(`update "bases" set "deletedAt" = now() where "id" = $1`, [ada]);
    expect(await baseOf(db, ADA, newId)).toBeUndefined();
    expect((await db.query(`select "id" from "bases"`)).rows).toHaveLength(1);
  });

  it("is one round trip once the record exists", async () => {
    await baseOf(db, ADA, newId);
    let queries = 0;
    const counted: Db = { query: (text, values) => (queries++, db.query(text, values)) };
    await baseOf(counted, ADA, newId);
    expect(queries).toBe(1);
  });
});
