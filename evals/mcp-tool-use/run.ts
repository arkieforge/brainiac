// The mcp-tool-use eval (evals/mcp-tool-use/README.md): each case asks the person's own Claude (or Codex) for one
// ordinary job on the fixture record, in a real headless run with Brainiac's tools and the agent skill, then grades
// the tool calls it made and the answer it gave. No tool result is mocked: every call reaches the record.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { listNotes, project, type Connection, type Sql } from "../../packages/base/src/index.ts";
import type { PlanItem } from "../../packages/core/src/index.ts";
import { factsOf } from "../answers/cases.ts";
import { context, dryRun, flags, readBaseline, report, type Row } from "../shared/cli.ts";
import { atLeast, FLOORS, noFailing } from "../shared/gates.ts";
import { installed, isCodex, run } from "../shared/runners.ts";
import { sampled } from "../shared/sampling.ts";
import { connection, FIXTURES, fixtureRecord, serve, SKILL } from "../shared/world.ts";
import { CASES, grade, type State } from "./cases.ts";

const options = flags(CASES);
const ask = (prompt: string, native: boolean | undefined, url: string, token: string) => ({
  prompt,
  model: options.model,
  mcp: { url, token },
  system: SKILL,
  ...(native && { vault: FIXTURES }),
});

/**
 * Every live note, and each note as an open proposal would leave it: what a case's `record` checks read. A change the
 * record holds for the person counts as made, since only the person decides it.
 */
function statesOf(sql: Sql): State[] {
  const live = listNotes(sql).filter((note) => note.deletedAt === null);
  const states: State[] = live.map((note) => ({
    id: note.id,
    type: note.type ?? "",
    fields: JSON.parse(note.fm),
  }));
  const plans = sql.all<{ patch: string }>(
    "SELECT patch FROM proposals WHERE status = 'open' AND kind = 'change'",
  );
  for (const item of plans.flatMap(({ patch }): PlanItem[] => JSON.parse(patch))) {
    const base = states.find((state) => state.id === item.noteId);
    const after = Object.fromEntries(
      Object.entries(item.patch.fields).map(([key, change]) => [key, change.after]),
    );
    const fields = { ...base?.fields, ...after };
    states.push({ id: item.noteId, type: String(fields["type"] ?? base?.type ?? ""), fields });
  }
  return states;
}

/** What the notes `reader` may see hold, as the answers graders read it. */
const factsFor = (sql: Sql, reader: Connection) =>
  factsOf(listNotes(sql).flatMap((note) => (project(note, reader) ? [note.raw] : [])));

if (options.context) {
  context({
    "SKILL.md": SKILL,
    ...Object.fromEntries(options.cases.map((c) => [`prompt ${c.id}`, c.prompt])),
  });
  process.exit(0);
}
if (options.dryRun) {
  for (const c of options.cases) {
    console.log(`${c.id} (${c.kind}${c.exact ? ", exact" : ""}${c.native ? ", native tools" : ""}):`);
    dryRun(ask(c.prompt, c.native, "http://127.0.0.1:<port>/mcp", "<token>"));
  }
  process.exit(0);
}
const bin = isCodex(options.model) ? "codex" : "claude";
if (!installed(bin)) throw new Error(`The mcp-tool-use eval runs ${bin}: it must be on PATH and signed in.`);

mkdirSync(options.out, { recursive: true });
const rows: Row[] = [];
for (const c of options.cases)
  rows.push(
    ...(await sampled(options.samples, c.exact === true, async (sample) => {
      // A fresh record each sample, since cases change it: the person's own Claude, which may write and see it all.
      const { sql } = fixtureRecord();
      const { token, connection: reader } = connection(sql, "write", true);
      // The values before the run: an answer quotes the record as it was asked.
      const facts = factsFor(sql, reader);
      const mcp = await serve(sql);
      let done;
      try {
        done = await run(ask(c.prompt, c.native, mcp.url, token));
      } finally {
        mcp.close();
      }
      const failed = grade(c.expect, { ...done, facts, states: statesOf(sql) }).filter(
        (check) => !check.pass,
      );
      const why = failed.map((check) => check.check).join("; ");
      console.log(
        `${failed.length === 0 ? "pass" : "FAIL"} ${c.id} (sample ${sample})${why ? `: ${why}` : ""}`,
      );
      const base = join(options.out, `${c.id}-${sample}`);
      writeFileSync(`${base}.ndjson`, done.events.map((e) => JSON.stringify(e)).join("\n"));
      const calls = done.calls.map((call) => `${call.tool} ${JSON.stringify(call.input)}`);
      writeFileSync(`${base}-said.txt`, `${done.text}\n\n---\n${calls.join("\n")}\n`);
      return {
        case: c.id,
        sample,
        ok: failed.length === 0,
        ...(why && { why }),
        model: done.model,
        usage: done.usage,
        ...(done.costUsd !== undefined && { costUsd: done.costUsd }),
      };
    })),
  );

const baseline = options.baseline === undefined ? undefined : readBaseline(options.baseline);
const exact = rows.filter((row) => options.cases.some((c) => c.id === row.case && c.exact));
// A case that passed every baseline sample and now fails one is a regression, which the quality bar allows none of.
const regressed = options.cases.filter(
  (c) => baseline?.get(c.id) === 1 && rows.some((row) => row.case === c.id && !row.ok),
);
const passed = report(options.out, {
  name: "mcp-tool-use",
  model: options.model,
  samples: options.samples,
  cases: options.cases.map((c) => ({ ...c, strict: c.exact === true })),
  rows,
  gates: [
    atLeast("tasks completed", FLOORS.toolUse, rows.filter((row) => row.ok).length, rows.length),
    ...(exact.length > 0
      ? [noFailing("exact-value canaries", exact.filter((row) => !row.ok).length, exact.length)]
      : []),
    ...(baseline ? [noFailing("no regression on any case", regressed.length, options.cases.length)] : []),
  ],
  ...(baseline && { baseline }),
});
if (!passed) process.exitCode = 1;
