// The review detectors eval (evals/review-detectors/README.md): every seeded error and clean control against the
// detectors, once, as CI runs it in cases.test.ts, with the rows and a summary in `--out` for a person to read.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { gateTable } from "../shared/gates.ts";
import { CASES, measure } from "./cases.ts";

const { values } = parseArgs({
  options: { out: { type: "string" }, case: { type: "string", multiple: true } },
});
if (!values.out) throw new Error("--out <dir> is required.");
const unknown = values.case?.filter((id) => !CASES.some((c) => c.id === id)) ?? [];
if (unknown.length > 0) throw new Error(`No case named ${unknown.join(", ")}.`);
const cases = values.case ? CASES.filter((c) => values.case?.includes(c.id)) : CASES;

const { results, gates } = measure(cases);
const ok = gates.every((g) => g.ok);
const list = (flags: readonly string[]) => flags.map((f) => `\`${f}\``).join(", ") || "none";
mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, "results.ndjson"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(
  join(values.out, "summary.md"),
  [
    `# review-detectors: ${ok ? "pass" : "FAIL"}`,
    "",
    "- No model: the detectors are deterministic, so each case runs once. Cost $0.",
    "",
    "| case | kind | missed | false alarms |",
    "| --- | --- | --- | --- |",
    ...results.map((r) => `| ${r.id} | ${r.kind} | ${list(r.missed)} | ${list(r.falseAlarms)} |`),
    "",
    "## Release gates",
    "",
    ...gateTable(gates),
  ].join("\n") + "\n",
);
console.log(`${ok ? "pass" : "FAIL"}. Summary in ${join(values.out, "summary.md")}.`);
process.exitCode = ok ? 0 : 1;
