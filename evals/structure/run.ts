// The structure eval (evals/structure/README.md): the fixture student tells their own Claude something new, in a real
// headless run of the model asked for with only Brainiac's tools and the agent skill, and the eval checks where it
// landed: the schema's type, in that type's folder, and no type the schema doesn't have.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { listNotes, type Sql } from "../../packages/base/src/index.ts";
import type { PlanItem } from "../../packages/core/src/index.ts";
import { context, dryRun, flags, readBaseline, report, type Row } from "../shared/cli.ts";
import { installed, isCodex, run } from "../shared/runners.ts";
import { sampled } from "../shared/sampling.ts";
import { connection, fixtureRecord, serve, SKILL } from "../shared/world.ts";
import { CASES, check, type Filed } from "./cases.ts";

const options = flags(CASES);
const ask = (prompt: string, url: string, token: string) => ({
  prompt,
  model: options.model,
  mcp: { url, token },
  system: SKILL,
});

/** The notes the run added, live or waiting in an open proposal: a note only the person can now decide counts. */
function filedSince(sql: Sql, before: ReadonlySet<string>): Filed[] {
  const filed: Filed[] = listNotes(sql)
    .filter((note) => note.deletedAt === null && !before.has(note.id))
    .map((note) => ({ id: note.id, type: note.type ?? "", path: note.path, fields: JSON.parse(note.fm) }));
  const plans = sql.all<{ patch: string }>(
    "SELECT patch FROM proposals WHERE status = 'open' AND kind = 'change'",
  );
  for (const item of plans.flatMap(({ patch }): PlanItem[] => JSON.parse(patch))) {
    if (before.has(item.noteId) || filed.some((note) => note.id === item.noteId)) continue;
    const fields = Object.fromEntries(
      Object.entries(item.patch.fields).map(([key, change]) => [key, change.after]),
    );
    filed.push({ id: item.noteId, type: String(fields["type"] ?? ""), path: item.path, fields });
  }
  return filed;
}

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
    dryRun(ask(c.prompt, "http://127.0.0.1:<port>/mcp", "<token>"));
  }
  process.exit(0);
}
const bin = isCodex(options.model) ? "codex" : "claude";
if (!installed(bin)) throw new Error(`The structure eval runs ${bin}: it must be on PATH and signed in.`);

mkdirSync(options.out, { recursive: true });
const rows: Row[] = [];
for (const c of options.cases)
  rows.push(
    ...(await sampled(options.samples, false, async (sample) => {
      // A fresh record each sample, since every case adds to it: the person's own Claude, which may write it all.
      const { sql } = fixtureRecord();
      const { token } = connection(sql, "write", true);
      const before = new Set(listNotes(sql).map((note) => note.id));
      const mcp = await serve(sql);
      let done;
      try {
        done = await run(ask(c.prompt, mcp.url, token));
      } finally {
        mcp.close();
      }
      const filed = filedSince(sql, before);
      const failed = check(c, { calls: done.calls, filed });
      console.log(
        `${failed === undefined ? "pass" : "FAIL"} ${c.id} (sample ${sample})${failed ? `: ${failed}` : ""}`,
      );
      const base = join(options.out, `${c.id}-${sample}`);
      writeFileSync(`${base}.ndjson`, done.events.map((e) => JSON.stringify(e)).join("\n"));
      const calls = done.calls.map((call) => `${call.tool} ${JSON.stringify(call.input)}`);
      writeFileSync(
        `${base}-said.txt`,
        `${done.text}\n\n---\n${calls.join("\n")}\n\n---\n${JSON.stringify(filed, null, 2)}\n`,
      );
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

const passed = report(options.out, {
  name: "structure",
  model: options.model,
  samples: options.samples,
  cases: options.cases.map((c) => ({ ...c, strict: false })),
  rows,
  ...(options.baseline && { baseline: readBaseline(options.baseline) }),
});
if (!passed) process.exitCode = 1;
