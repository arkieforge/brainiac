import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getAuthTables } from "better-auth/db";
import { describe, expect, it } from "vite-plus/test";

import { authOptions } from "./config.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../../infra/migrations");

/** Every `table.column` the migrations create, from `create table` and `alter table ... add column`. */
function migratedColumns(): Set<string> {
  const columns = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const [, table = "", body = ""] of sql.matchAll(/create table "(\w+)" \((.*)\);/g)) {
      for (const [, column] of body.matchAll(/(?:^|, )"(\w+)" /g)) columns.add(`${table}.${column}`);
    }
    for (const [, table, column] of sql.matchAll(/alter table "(\w+)" add column "(\w+)"/g)) {
      columns.add(`${table}.${column}`);
    }
  }
  return columns;
}

describe("auth schema", () => {
  // Deploys apply infra/migrations, not Better Auth's own migrator, so a new plugin or field needs a file there.
  it("has a migration for every table and column the auth options use", () => {
    const options = authOptions({
      database: undefined,
      baseURL: "https://brainiac.test",
      secret: "schema-only",
      sendEmail: async () => {},
    });
    const needed = Object.values(getAuthTables(options)).flatMap((table) => [
      `${table.modelName}.id`,
      ...Object.entries(table.fields).map(([key, field]) => `${table.modelName}.${field.fieldName ?? key}`),
    ]);
    const migrated = migratedColumns();
    expect(needed.filter((column) => !migrated.has(column))).toEqual([]);
  });
});
