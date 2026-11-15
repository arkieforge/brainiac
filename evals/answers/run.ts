// The answers eval (evals/answers/README.md): asks the fixture record a question in a real headless Claude Code
// run that has only Brainiac's tools and the agent skill, then checks the answer: values quoted exactly, unverified
// ones labeled, and "not in your record" when it isn't.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { serveTools } from "../../packages/base/src/mcp.ts";
import {
  authenticate,
  callTool,
  chunkNote,
  connect,
  grant,
  listNotes,
  migrate,
  mintToken,
  mutate,
  project,
  putChunks,
  recordApproval,
  TOOLS,
  type Connection,
  type Sql,
} from "../../packages/base/src/index.ts";
import { nodeSql } from "../../packages/base/src/node.ts";
import { CASES, factsOf, passes, type Answered } from "./cases.ts";

const ROOT = join(import.meta.dirname, "../..");
const FIXTURES = join(ROOT, "fixtures/nadia");
const SKILL = readFileSync(join(ROOT, "apps/cli/plugin/skills/brainiac/SKILL.md"), "utf8");

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "2" },
    "dry-run": { type: "boolean" },
  },
});
if (!values.out) throw new Error("--out <dir> is required.");
const cases = values.case ? CASES.filter((c) => values.case?.includes(c.id)) : CASES;
if (cases.length === 0) throw new Error(`No case named ${values.case?.join(", ")}.`);
const samples = Number(values.samples);
// Zero samples would pass every case without asking anything.
if (!Number.isInteger(samples) || samples < 1)
  throw new Error("--samples must be a whole number, 1 or more.");

let signatures = 0;
const signature = () => ({ credentialId: "eval", counter: ++signatures, assertion: `{"n":${signatures}}` });

/**
 * The fixture record as the person made it, indexed as a laptop's copy is (keyword only: no model embeds here),
 * and a connection that may read it all, sensitive notes included: the person's own Claude.
 */
function world(sql: Sql) {
  migrate(sql);
  const person = { actor: "human", now: Date.now() };
  sql.all(
    "INSERT INTO schema (version, manifest) VALUES (1, ?)",
    readFileSync(join(FIXTURES, "okf-base.yaml"), "utf8"),
  );
  for (const path of readdirSync(FIXTURES, { recursive: true, encoding: "utf8" }).filter((p) =>
    p.endsWith(".md"),
  )) {
    const mutation = {
      op: "create",
      path,
      raw: readFileSync(join(FIXTURES, path), "utf8"),
      class: path.startsWith("facts/tests/") ? "sensitive" : "normal",
    } as const;
    let result = mutate(sql, mutation, person);
    // The November score arrives verified, which takes the person's passkey.
    if (result.status === "needsApproval") {
      const approved = recordApproval(sql, result.items, signature(), person.now);
      if (!("approvalId" in approved))
        throw new Error(`fixture approval failed: ${JSON.stringify(approved)}`);
      result = mutate(sql, mutation, { ...person, approvalId: approved.approvalId });
    }
    if (result.status !== "applied") throw new Error(`${path}: ${JSON.stringify(result)}`);
  }
  for (const note of listNotes(sql)) putChunks(sql, note.id, note.rev, chunkNote(note));
  const floor = connect(sql, { kind: "cli" }, person.now);
  const granted = grant(
    sql,
    { connectionId: floor.id, rev: floor.rev, level: "read", sensitive: true, holdDays: 0 },
    signature(),
  );
  if (!("connection" in granted)) throw new Error(granted.error);
  return { connection: granted.connection, token: mintToken(sql, "e0a1", floor.id, person.now) };
}

/** What the notes `connection` may see hold, as the graders compare an answer with it. */
function recordOf(sql: Sql, connection: Connection) {
  const reader = { sensitive: connection.sensitive };
  return factsOf(listNotes(sql).flatMap((note) => (project(note, reader) ? [note.raw] : [])));
}

/** This record's `/mcp` on a local port, answering as the Worker does: as the token's connection. */
function serve(sql: Sql) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (typeof value === "string") headers.set(key, value);
    const connection = authenticate(
      sql,
      headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
      Date.now(),
    );
    if (!connection) return void res.writeHead(401).end();
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method ?? "POST",
      headers,
      ...(req.method === "POST" && { body: Buffer.concat(chunks) }),
    });
    const response = await serveTools(request, async (name, args) =>
      callTool(sql, name, args, { actor: `connection:${connection.id}`, connection, now: Date.now() }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return {
    listen: () =>
      new Promise<number>((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
      ),
    close: () => server.close(),
  };
}

/**
 * One headless run asking `question`, in a new empty folder: Brainiac's tools over remote MCP and nothing else (no
 * built-in tool, none of this machine's settings, hooks, plugins or MCP servers), with the agent skill a person's
 * plugin would load.
 */
async function ask(claude: string, question: string, port: number, token: string) {
  const config = {
    mcpServers: {
      brainiac: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { authorization: `Bearer ${token}` },
      },
    },
  };
  const cwd = mkdtempSync(join(tmpdir(), "brainiac-answers-"));
  try {
    const child = spawn(
      claude,
      [
        ...(values.model === undefined ? [] : ["--model", values.model]),
        "-p",
        question,
        "--restricted",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        JSON.stringify(config),
        "--allowedTools",
        "mcp__brainiac__*",
        "--append-system-prompt",
        SKILL,
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      { cwd, stdio: ["ignore", "pipe", "inherit"] },
    );
    const ended = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    ended.catch(() => {});
    const events: Record<string, unknown>[] = [];
    for await (const line of createInterface({ input: child.stdout })) {
      try {
        events.push(JSON.parse(line));
      } catch {} // not an event: Claude Code's own warnings
    }
    await ended;
    return events;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** The tool calls a run made, in order, as `name {args}`. */
const toolCalls = (events: readonly Record<string, unknown>[]) =>
  events.flatMap((event) => {
    const message = event["message"];
    const content =
      typeof message === "object" && message !== null && "content" in message ? message.content : [];
    return (Array.isArray(content) ? content : []).flatMap((part: Record<string, unknown>) =>
      part["type"] === "tool_use" ? [`${String(part["name"])} ${JSON.stringify(part["input"])}`] : [],
    );
  });

const expectedTools = Object.keys(TOOLS).map((name) => `mcp__brainiac__${name}`);
if (values["dry-run"]) {
  for (const c of cases) console.log(`${c.id} (${c.kind}${c.exact ? ", exact" : ""}): ${c.question}`);
  console.log(`${samples} samples each. Tools: ${expectedTools.join(", ")}`);
  process.exit(0);
}
const claude = spawnSync("which", ["claude"], { encoding: "utf8" }).stdout.trim();
if (!claude) throw new Error("The answers eval runs Claude Code: claude must be on PATH and signed in.");

mkdirSync(values.out, { recursive: true });
const sql = nodeSql(new DatabaseSync(":memory:"));
const made = world(sql);
const facts = recordOf(sql, made.connection);
const mcp = serve(sql);
const port = await mcp.listen();
const rows: Record<string, unknown>[] = [];
let cost = 0;
try {
  for (const c of cases) {
    // A 3rd sample when two disagree; an exact-value case has failed already by then.
    for (let sample = 1; sample <= samples + 1; sample++) {
      const mine = rows.filter((r) => r["case"] === c.id);
      if (sample > samples && (c.exact || mine.every((r) => r["ok"] === mine[0]?.["ok"]))) break;
      const events = await ask(claude, c.question, port, made.token);
      const result = events.find((e) => e["type"] === "result");
      cost += typeof result?.["total_cost_usd"] === "number" ? result["total_cost_usd"] : 0;
      const run: Answered = { said: String(result?.["result"] ?? ""), ...facts };
      const failed = c.check(run);
      const calls = toolCalls(events);
      rows.push({ case: c.id, sample, ok: failed === undefined, ...(failed && { why: failed }), calls });
      console.log(
        `${failed === undefined ? "pass" : "FAIL"} ${c.id} (sample ${sample})${failed ? `: ${failed}` : ""}`,
      );
      writeFileSync(
        join(values.out, `${c.id}-${sample}.ndjson`),
        events.map((e) => JSON.stringify(e)).join("\n"),
      );
      writeFileSync(
        join(values.out, `${c.id}-${sample}-said.txt`),
        `${run.said}\n\n---\n${calls.join("\n")}\n`,
      );
    }
  }
} finally {
  mcp.close();
}

const verdicts = cases.map((c) => {
  const mine = rows.filter((r) => r["case"] === c.id);
  const failing = mine.filter((r) => !r["ok"]).length;
  return { ...c, ran: mine.length, failing, ok: passes(c.exact, failing, mine.length) };
});
writeFileSync(join(values.out, "results.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n"));
writeFileSync(
  join(values.out, "summary.md"),
  [
    `# answers: ${verdicts.every((v) => v.ok) ? "pass" : "FAIL"}`,
    "",
    `${samples} samples a case, model ${values.model ?? "Claude Code's default"}, cost $${cost.toFixed(2)}`,
    "",
    "| case | kind | exact | failing samples | verdict |",
    "| --- | --- | --- | --- | --- |",
    ...verdicts.map(
      (v) =>
        `| ${v.id} | ${v.kind} | ${v.exact ? "yes" : "no"} | ${v.failing}/${v.ran} | ${v.ok ? "pass" : "FAIL"} |`,
    ),
  ].join("\n") + "\n",
);
console.log(`Cost $${cost.toFixed(2)}. Summary in ${join(values.out, "summary.md")}.`);
if (!verdicts.every((v) => v.ok)) process.exitCode = 1;
