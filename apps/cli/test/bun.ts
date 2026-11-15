// Runs every daemon case in Bun on the real filesystem and prints the results as JSON (daemon.test.ts runs it
// with the pinned Bun). Pass names to run only those.
import { rmSync } from "node:fs";

import { cases, folders, NOT_ON_WINDOWS, runCase, type CaseResult } from "./cases.ts";

const only = Bun.argv.slice(2);
const results: Record<string, CaseResult> = {};
for (const name of Object.keys(cases)) {
  if (process.platform === "win32" && NOT_ON_WINDOWS.has(name)) continue;
  if (only.length === 0 || only.some((part) => name.includes(part))) results[name] = await runCase(name);
}
for (const folder of folders) rmSync(folder, { recursive: true, force: true });
console.log(JSON.stringify(results));
process.exit(0);
