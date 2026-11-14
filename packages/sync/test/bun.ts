// Runs every client case in Bun with the laptop's store: a state.db file per device, on the write-ahead log,
// opened again from disk on each restart. Prints the results as JSON; stores.test.ts runs it with the pinned Bun.
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bunSql } from "@brainiac/base/bun";

import { sqlStore } from "../src/index.ts";
import { cases, runCase, type CaseResult } from "./cases.ts";

const dir = mkdtempSync(join(tmpdir(), "brainiac-sync-"));
const results: Record<string, CaseResult> = {};
for (const [i, name] of Object.keys(cases).entries()) {
  results[name] = await runCase(name, (device) => {
    const db = new Database(join(dir, `${i}-${device}.db`), { strict: true });
    db.run("PRAGMA journal_mode = WAL");
    return sqlStore(bunSql(db));
  });
}
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify(results));
