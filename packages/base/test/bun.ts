// Runs every conformance case on bun:sqlite, one in-memory database each, with the parity answers
// (parity.ts). engines.test.ts runs this file with the pinned Bun and reads one JSON line per case as it
// finishes, then the parity answers, so each test waits only for its own case.
import { Database } from "bun:sqlite";

import { bunSql } from "../src/bun.ts";
import { cases, runCase } from "./cases.ts";
import { fixtures } from "./fixtures.ts";
import { answers } from "./parity.ts";

for (const name of Object.keys(cases)) {
  const db = new Database(":memory:", { strict: true });
  console.log(JSON.stringify({ name, result: runCase(name, bunSql(db), fixtures) }));
  db.close();
}
const db = new Database(":memory:", { strict: true });
console.log(JSON.stringify({ parity: answers(bunSql(db), fixtures) }));
db.close();
