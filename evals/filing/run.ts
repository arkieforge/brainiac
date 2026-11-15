// The filing eval (evals/filing/README.md): files the fixture record's inbox in a real headless Claude Code run,
// started by the daemon's own `fileInbox`, through the real `brainiac mcp serve --background`, against the record
// on node:sqlite behind the tools `/mcp` serves. Then checks what the run had and what it did.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileInbox, filingArgs } from "../../apps/cli/src/filing.ts";
import {
  auditOf,
  callTool,
  getConnection,
  listNotes,
  PROMPTS,
  TOOLS,
  type Sql,
} from "../../packages/base/src/index.ts";
import { context, flags, readBaseline, report, type Row } from "../shared/cli.ts";
import { checkModel, fromClaude, isCodex } from "../shared/runners.ts";
import { addItem, connection, fixtureRecord, ROOT, serve } from "../shared/world.ts";
import { CASES, ITEMS, type Outcome } from "./cases.ts";

const options = flags(CASES);
// The daemon's filer is Claude Code only (apps/cli/src/filing.ts).
if (isCodex(options.model))
  throw new Error("The filing eval runs the daemon's filer, which is Claude Code only.");

/** The fixture record with the inbox the cases file, and the most the person can grant its device. */
function world() {
  const { sql, ids } = fixtureRecord();
  const items = Object.fromEntries(ITEMS.map((item) => [item.key, addItem(sql, item.text, item.sensitive)]));
  // A background run gets none of this: the record narrows it.
  const device = connection(sql, "write", true);
  const hidden = listNotes(sql)
    .filter((note) => note.class === "sensitive")
    .map((note) => note.id);
  return { sql, ...device, items, bsc: ids["facts/education/bsc-northvale.md"] ?? "", hidden };
}

/** The open questions, by the note each is about, as the person's query lists them. */
function askedAbout(sql: Sql): { readonly noteId: string | null }[] {
  const answer = callTool(
    sql,
    "query",
    { type: "Question", fields: ["about", "note", "status"], limit: 100 },
    { actor: "human", now: Date.now() },
  );
  if (!answer.ok) throw new Error(answer.error);
  const { rows } = answer.value as { rows: { fields: Record<string, unknown> }[] };
  return rows
    .filter((row) => row.fields["status"] === "open")
    .map(({ fields }) => {
      const about = fields["about"] ?? fields["note"];
      return { noteId: typeof about === "string" ? about : null };
    });
}

// Every note but questions new since `known`: request_info writes one at propose level, without a proposal, by
// design. A question that was already there counts like any note.
const notesOf = (sql: Sql, known: ReadonlySet<string>) =>
  JSON.stringify(
    listNotes(sql)
      .filter((note) => note.type !== "Question" || known.has(note.id))
      .map((note) => [note.id, note.rev, note.deletedAt]),
  );

const bun = createRequire(join(ROOT, "apps/cli/package.json")).resolve("bun/bin/bun.exe");
const bridge = (url: string, token: string) => ({
  command: bun,
  args: [
    join(ROOT, "apps/cli/src/main.ts"),
    "mcp",
    "serve",
    "--background",
    "--server",
    url.replace(/\/mcp$/, ""),
  ],
  env: { BRAINIAC_TOKEN: token },
});
const expectedTools = Object.keys(TOOLS).map((name) => `mcp__brainiac__${name}`);

if (options.context) {
  context({
    "file_inbox prompt": PROMPTS.file_inbox.text(),
    ...Object.fromEntries(ITEMS.map((i) => [`item ${i.key}`, i.text])),
  });
  process.exit(0);
}
if (options.dryRun) {
  console.log(
    JSON.stringify([
      "claude",
      ...filingArgs(bridge("http://127.0.0.1:<port>/mcp", "<token>"), options.model),
    ]),
  );
  console.log(`${options.samples} samples of: ${options.cases.map((c) => c.id).join(", ")}`);
  process.exit(0);
}
// As `brainiac filing on` finds it: the absolute path, which the daemon stores.
const claude = spawnSync("which", ["claude"], { encoding: "utf8" }).stdout.trim();
if (!claude) throw new Error("The filing eval runs Claude Code: claude must be on PATH and signed in.");

mkdirSync(options.out, { recursive: true });
const rows: Row[] = [];
// Every case checks the same run, so a sample is one inbox filed; none gets a 3rd, as most cases are guards.
for (let sample = 1; sample <= options.samples; sample++) {
  const made = world();
  const { sql } = made;
  const known = new Set(listNotes(sql).map((note) => note.id));
  const before = notesOf(sql, known);
  const grantsBefore = JSON.stringify(getConnection(sql, made.connection.id));
  const approvals = () => sql.all("SELECT 1 FROM approvals WHERE usedAt IS NOT NULL").length;
  const approvalsBefore = approvals();
  const mcp = await serve(sql);
  // Its own config folder, so the bridge never touches this machine's.
  const home = mkdtempSync(join(tmpdir(), "brainiac-eval-"));
  let filed;
  try {
    const { command, args, env } = bridge(mcp.url, made.token);
    filed = await fileInbox(
      { command, args, env: { ...env, HOME: home, XDG_CONFIG_HOME: home } },
      { claude, ...(options.model !== undefined && { model: options.model }) },
    );
  } finally {
    mcp.close();
    rmSync(home, { recursive: true, force: true });
  }
  const done = fromClaude(filed.events);
  checkModel(options.model, done.model);
  const init = filed.events.find((e) => e["type"] === "system" && e["subtype"] === "init");
  const outcome: Outcome = {
    tools: Array.isArray(init?.["tools"]) ? init["tools"] : [],
    servers: Array.isArray(init?.["mcp_servers"]) ? init["mcp_servers"] : [],
    before,
    after: notesOf(sql, known),
    proposals: sql
      .all<{ patch: string; action: string | null; status: string; autoApplyAt: number | null }>(
        "SELECT patch, action, status, autoApplyAt FROM proposals WHERE kind = 'change'",
      )
      .map((p) => ({ ...p, items: JSON.parse(p.patch), action: JSON.parse(p.action ?? '{"op": ""}') })),
    questions: askedAbout(sql),
    shown: auditOf(sql, made.connection.id, 10_000).flatMap((c) => c.notes.map((note) => note.id)),
    background: mcp.background(),
    grants: { before: grantsBefore, after: JSON.stringify(getConnection(sql, made.connection.id)) },
    approvalsUsed: approvals() - approvalsBefore,
    items: made.items,
    bsc: made.bsc,
    hidden: made.hidden,
    expectedTools,
  };
  // The run's tokens and cost go on its first row only, so the summary counts each run once.
  options.cases.forEach((c, i) => {
    const failed = c.check(outcome);
    rows.push({
      case: c.id,
      sample,
      ok: failed === undefined,
      ...(failed && { why: failed }),
      model: done.model,
      usage: i === 0 ? done.usage : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: i === 0 ? (done.costUsd ?? 0) : 0,
    });
    console.log(
      `${failed === undefined ? "pass" : "FAIL"} ${c.id} (sample ${sample})${failed ? `: ${failed}` : ""}`,
    );
  });
  writeFileSync(
    join(options.out, `sample-${sample}.ndjson`),
    filed.events.map((e) => JSON.stringify(e)).join("\n"),
  );
  writeFileSync(join(options.out, `sample-${sample}-said.txt`), done.text);
}

const passed = report(options.out, {
  name: "filing",
  model: options.model,
  samples: options.samples,
  // Guards fail on any failing sample (they are exactness checks); a control fails when half or more do.
  cases: options.cases.map((c) => ({ ...c, strict: c.kind !== "control" })),
  rows,
  ...(options.baseline && { baseline: readBaseline(options.baseline) }),
});
if (!passed) process.exitCode = 1;
