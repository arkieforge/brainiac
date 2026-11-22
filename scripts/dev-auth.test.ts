import { DatabaseSync } from "node:sqlite";

import { listNotes, migrate, mutate } from "../packages/base/src/index.ts";
import { nodeSql } from "../packages/base/src/node.ts";
import { expect, it } from "vite-plus/test";

import { fixtureNotes } from "./dev-auth.ts";

it("seeds the whole fixture through the record's mutation path, nothing waiting on a passkey", () => {
  const sql = nodeSql(new DatabaseSync(":memory:"));
  migrate(sql);
  const notes = fixtureNotes();
  // Every note the fixture has, so a new one can't quietly fail to seed.
  expect(notes.length).toBeGreaterThanOrEqual(10);
  for (const note of notes) {
    expect(mutate(sql, { op: "create", ...note }, { actor: "human", now: Date.now() })).toMatchObject({
      status: "applied",
    });
  }
  const seeded = listNotes(sql);
  expect(seeded.map((note) => note.path).toSorted()).toEqual(notes.map((note) => note.path));
  expect(seeded.filter((note) => note.class === "sensitive").map((note) => note.path)).toEqual(
    expect.arrayContaining(["facts/tests/ielts-2025-03.md", "facts/tests/ielts-2026-11.md"]),
  );
});
