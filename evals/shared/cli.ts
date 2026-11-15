// What every eval's run.ts shares at its edges: the flags (evals/README.md), and the files a run leaves in `--out`:
// `results.ndjson`, one row a sample, and `summary.md` for a person, with its token use and any baseline.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { TOOLS } from "../../packages/base/src/index.ts";
import { gateTable, type Gate } from "./gates.ts";
import { command, type Ask, type Usage } from "./runners.ts";
import { passes } from "./sampling.ts";

/** The flags every eval takes, and the cases they select from `all`. */
export function flags<C extends { readonly id: string }>(all: readonly C[]) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      model: { type: "string" },
      case: { type: "string", multiple: true },
      samples: { type: "string", default: "2" },
      baseline: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      context: { type: "boolean", default: false },
    },
  });
  if (!values.out) throw new Error("--out <dir> is required.");
  const unknown = values.case?.filter((id) => !all.some((c) => c.id === id)) ?? [];
  if (unknown.length > 0) throw new Error(`No case named ${unknown.join(", ")}.`);
  const samples = Number(values.samples);
  // Zero samples would pass every case without asking anything.
  if (!Number.isInteger(samples) || samples < 1)
    throw new Error("--samples must be a whole number, 1 or more.");
  return {
    out: values.out,
    model: values.model,
    cases: values.case ? all.filter((c) => values.case?.includes(c.id)) : all,
    samples,
    baseline: values.baseline,
    dryRun: values["dry-run"],
    context: values.context,
  };
}

/** One sample's row in `results.ndjson`. */
export interface Row {
  readonly case: string;
  readonly sample: number;
  readonly ok: boolean;
  readonly why?: string;
  /** The model that answered, as the harness reported it. */
  readonly model: string;
  readonly usage: Usage;
  readonly costUsd?: number;
}

/** Each case's pass rate in an earlier run's `results.ndjson`. */
export function readBaseline(file: string): Map<string, number> {
  const rows: { case: string; ok: boolean }[] = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  return new Map(
    [...Map.groupBy(rows, (row) => row.case)].map(([id, mine]) => [
      id,
      mine.filter((row) => row.ok).length / mine.length,
    ]),
  );
}

const percent = (rate: number) => `${Math.round(rate * 100)}%`;

/**
 * `--context`: how much of what the model sees is Brainiac's, by part, so a wording change shows its cost. Tokens
 * are estimated at 4 characters each; no model is called to count them.
 */
export function context(parts: Readonly<Record<string, string>>) {
  const all = {
    ...Object.fromEntries(
      Object.entries(TOOLS).map(([name, tool]) => [
        `tool ${name}`,
        tool.description + JSON.stringify(tool.input.toJsonSchema()),
      ]),
    ),
    ...parts,
  };
  for (const [part, text] of Object.entries(all))
    console.log(`${part}: ${text.length} chars, ~${Math.ceil(text.length / 4)} tokens`);
  const chars = Object.values(all).reduce((sum, text) => sum + text.length, 0);
  console.log(`total: ${chars} chars, ~${Math.ceil(chars / 4)} tokens`);
}

/** `--dry-run`: the command a run would spawn, with the skill shortened, and no model called. */
export function dryRun(ask: Ask) {
  const system = `<SKILL.md, ${ask.system.length} chars>`;
  const { bin, args } = command({ ...ask, system });
  console.log(JSON.stringify([bin, ...args]));
}

/**
 * Writes `results.ndjson` and `summary.md`, and says whether the run passed: every case's verdict and every gate.
 * With a baseline, a case that passed every earlier sample and now fails one is marked a regression.
 */
export function report(
  out: string,
  run: {
    readonly name: string;
    readonly model: string | undefined;
    readonly samples: number;
    readonly cases: readonly { readonly id: string; readonly kind: string; readonly strict: boolean }[];
    readonly rows: readonly Row[];
    readonly gates?: readonly Gate[];
    readonly baseline?: ReadonlyMap<string, number>;
  },
) {
  const verdicts = run.cases.map((c) => {
    const mine = run.rows.filter((row) => row.case === c.id);
    const failing = mine.filter((row) => !row.ok).length;
    const was = run.baseline?.get(c.id);
    return {
      ...c,
      ran: mine.length,
      failing,
      ok: mine.length > 0 && passes(c.strict, failing, mine.length),
      was,
      regressed: was === 1 && failing > 0,
    };
  });
  const gates = run.gates ?? [];
  const ok = verdicts.every((v) => v.ok) && gates.every((g) => g.ok);
  const total = (key: keyof Usage) => run.rows.reduce((sum, row) => sum + row.usage[key], 0);
  const costs = run.rows.flatMap((row) => (row.costUsd === undefined ? [] : [row.costUsd]));
  const answered = [...new Set(run.rows.map((row) => row.model))].join(", ") || "none";
  writeFileSync(join(out, "results.ndjson"), run.rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(
    join(out, "summary.md"),
    [
      `# ${run.name}: ${ok ? "pass" : "FAIL"}`,
      "",
      `- Model asked: ${run.model ?? "the harness's default"}. Answered by: ${answered}.`,
      `- ${run.samples} samples a case.`,
      `- Tokens: input ${total("input")}, output ${total("output")}, cache read ${total("cacheRead")}, cache write ${total("cacheWrite")}.`,
      costs.length === run.rows.length
        ? `- Cost $${costs.reduce((a, b) => a + b, 0).toFixed(2)}, as the harness reported it.`
        : "- Cost: not reported (Codex bills its sign-in's plan); the tokens above are the measure.",
      "",
      `| case | kind | strict | failing samples | verdict |${run.baseline ? " baseline |" : ""}`,
      `| --- | --- | --- | --- | --- |${run.baseline ? " --- |" : ""}`,
      ...verdicts.map(
        (v) =>
          `| ${v.id} | ${v.kind} | ${v.strict ? "yes" : "no"} | ${v.failing}/${v.ran} | ${v.ok ? "pass" : "FAIL"} |` +
          (run.baseline
            ? ` ${v.was === undefined ? "new" : `${percent(v.was)}${v.regressed ? ", REGRESSED" : ""}`} |`
            : ""),
      ),
      ...(gates.length > 0 ? ["", "## Release gates", "", ...gateTable(gates)] : []),
    ].join("\n") + "\n",
  );
  console.log(`${ok ? "pass" : "FAIL"}. Summary in ${join(out, "summary.md")}.`);
  return ok;
}
