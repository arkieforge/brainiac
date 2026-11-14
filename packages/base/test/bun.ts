// Runs every conformance case on bun:sqlite, one in-memory database each, and prints the results as JSON.
// engines.test.ts runs this file with the pinned Bun.
import { Database } from "bun:sqlite";

import { bunSql } from "../src/bun.ts";
import { cases, runCase, type CaseResult } from "./cases.ts";
import { fixtures } from "./fixtures.ts";

const results: Record<string, CaseResult> = {};
for (const name of Object.keys(cases)) {
  const db = new Database(":memory:", { strict: true });
  results[name] = runCase(name, bunSql(db), fixtures);
  db.close();
}
console.log(JSON.stringify(results));
