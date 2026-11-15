// The answers eval (evals/answers/README.md): asks the fixture record a question in a real headless run of the
// model asked for, with only Brainiac's tools and the agent skill, then checks the answer: values quoted exactly,
// unverified ones labeled, and "not in your record" when it isn't.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { listNotes, project, type Connection, type Sql } from "../../packages/base/src/index.ts";
import { context, dryRun, flags, readBaseline, report, type Row } from "../shared/cli.ts";
import { installed, isCodex, run } from "../shared/runners.ts";
import { sampled } from "../shared/sampling.ts";
import { connection, fixtureRecord, serve, SKILL } from "../shared/world.ts";
import { answersGates, CASES, factsOf, type Answered } from "./cases.ts";

const options = flags(CASES);

/** What the notes `connection` may see hold, as the graders compare an answer with it. */
function recordOf(sql: Sql, reader: Connection) {
  return factsOf(listNotes(sql).flatMap((note) => (project(note, reader) ? [note.raw] : [])));
}

if (options.context) {
  context({
    "SKILL.md": SKILL,
    ...Object.fromEntries(options.cases.map((c) => [`question ${c.id}`, c.question])),
  });
  process.exit(0);
}
if (options.dryRun) {
  for (const c of options.cases) {
    console.log(`${c.id} (${c.kind}${c.exact ? ", exact" : ""}):`);
    dryRun({
      prompt: c.question,
      model: options.model,
      mcp: { url: "http://127.0.0.1:<port>/mcp", token: "<token>" },
      system: SKILL,
    });
  }
  console.log(`${options.samples} samples each, a 3rd when they disagree (not for exact cases).`);
  process.exit(0);
}
const bin = isCodex(options.model) ? "codex" : "claude";
if (!installed(bin)) throw new Error(`The answers eval runs ${bin}: it must be on PATH and signed in.`);

mkdirSync(options.out, { recursive: true });
// The person's own Claude: it may read everything, sensitive notes included.
const { sql } = fixtureRecord();
const reader = connection(sql, "read", true);
const facts = recordOf(sql, reader.connection);
const mcp = await serve(sql);
const rows: Row[] = [];
try {
  for (const c of options.cases)
    rows.push(
      ...(await sampled(options.samples, c.exact, async (sample) => {
        const done = await run({
          prompt: c.question,
          model: options.model,
          mcp: { url: mcp.url, token: reader.token },
          system: SKILL,
        });
        const answered: Answered = { said: done.text, ...facts };
        const failed = c.check(answered);
        const calls = done.calls.map((call) => `${call.tool} ${JSON.stringify(call.input)}`);
        console.log(
          `${failed === undefined ? "pass" : "FAIL"} ${c.id} (sample ${sample})${failed ? `: ${failed}` : ""}`,
        );
        const base = join(options.out, `${c.id}-${sample}`);
        writeFileSync(`${base}.ndjson`, done.events.map((e) => JSON.stringify(e)).join("\n"));
        writeFileSync(`${base}-said.txt`, `${done.text}\n\n---\n${calls.join("\n")}\n`);
        return {
          case: c.id,
          sample,
          ok: failed === undefined,
          ...(failed && { why: failed }),
          model: done.model,
          usage: done.usage,
          ...(done.costUsd !== undefined && { costUsd: done.costUsd }),
        };
      })),
    );
} finally {
  mcp.close();
}

const passed = report(options.out, {
  name: "answers",
  model: options.model,
  samples: options.samples,
  cases: options.cases.map((c) => ({ ...c, strict: c.exact })),
  rows,
  gates: answersGates(options.cases, rows),
  ...(options.baseline && { baseline: readBaseline(options.baseline) }),
});
if (!passed) process.exitCode = 1;
