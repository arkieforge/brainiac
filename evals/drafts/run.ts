// The drafts eval (evals/drafts/README.md): asks the fixture record's own Claude for a statement of purpose, cover
// letter or essay in a real headless run of the model asked for, with only Brainiac's tools and the agent skill,
// then checks the draft: it started from `draft`, its last verify is ok, it invents no value and keeps the house rules.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getNoteByPath, listNotes, mutate, project } from "../../packages/base/src/index.ts";
import { factsOf } from "../answers/cases.ts";
import { context, dryRun, flags, readBaseline, report, type Row } from "../shared/cli.ts";
import { installed, isCodex, run } from "../shared/runners.ts";
import { sampled } from "../shared/sampling.ts";
import { connection, fixtureRecord, PERSON, serve, SKILL } from "../shared/world.ts";
import { CASES, draftsGates, HOUSE_RULES, type Case, type Drafted } from "./cases.ts";

const options = flags(CASES);

if (options.context) {
  context({
    "SKILL.md": SKILL,
    ...Object.fromEntries(options.cases.map((c) => [`prompt ${c.id}`, c.prompt])),
  });
  process.exit(0);
}
if (options.dryRun) {
  for (const c of options.cases) {
    console.log(`${c.id} (${c.kind}):`);
    dryRun({
      prompt: c.prompt,
      model: options.model,
      mcp: { url: "http://127.0.0.1:<port>/mcp", token: "<token>" },
      system: SKILL,
    });
  }
  console.log(`${options.samples} samples each; any failing sample fails its case.`);
  process.exit(0);
}
const bin = isCodex(options.model) ? "codex" : "claude";
if (!installed(bin)) throw new Error(`The drafts eval runs ${bin}: it must be on PATH and signed in.`);

mkdirSync(options.out, { recursive: true });

/** The fixture record with the person's house rules and what `c` plants, read by the person's own Claude. */
function world(c: Case) {
  const { sql } = fixtureRecord();
  const rules = mutate(
    sql,
    {
      op: "create",
      path: "settings/agents.md",
      raw: `---\nid: 01M6AM78G0STS7TB29G7A10HRS\ntype: Settings\nkind: agents\ntitle: House rules\n---\n${HOUSE_RULES}`,
      class: "normal",
    },
    PERSON,
  );
  if (rules.status !== "applied") throw new Error(`house rules: ${JSON.stringify(rules)}`);
  if (c.planted) {
    const note = getNoteByPath(sql, c.planted.path);
    if (!note) throw new Error(`${c.id}: no note ${c.planted.path}`);
    const put = mutate(
      sql,
      { op: "put", noteId: note.id, baseRev: note.rev, raw: `${note.raw}${c.planted.text}` },
      PERSON,
    );
    if (put.status !== "applied") throw new Error(`${c.id}: ${JSON.stringify(put)}`);
  }
  // The person's own Claude: it may read everything, sensitive notes included.
  const reader = connection(sql, "read", true);
  const facts = factsOf(listNotes(sql).flatMap((n) => (project(n, reader.connection) ? [n.raw] : [])));
  return { sql, reader, facts };
}

const rows: Row[] = [];
for (const c of options.cases) {
  const { sql, reader, facts } = world(c);
  const mcp = await serve(sql);
  try {
    rows.push(
      ...(await sampled(options.samples, true, async (sample) => {
        const done = await run({
          prompt: c.prompt,
          model: options.model,
          mcp: { url: mcp.url, token: reader.token },
          system: SKILL,
        });
        const drafted: Drafted = { said: done.text, calls: done.calls, ...facts };
        const failed = c.check(drafted);
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
}

const passed = report(options.out, {
  name: "drafts",
  model: options.model,
  samples: options.samples,
  cases: options.cases.map((c) => ({ ...c, strict: true })),
  rows,
  gates: draftsGates(rows),
  ...(options.baseline && { baseline: readBaseline(options.baseline) }),
});
if (!passed) process.exitCode = 1;
