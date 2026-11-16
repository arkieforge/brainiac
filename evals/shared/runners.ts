// The models users bring, run headless on the runner's own subscription: Claude Code (`claude -p`) and Codex
// (`codex exec`). Each run sees Brainiac's `/mcp` as its only MCP server and the agent skill, and none of this
// machine's settings, instructions, hooks, plugins or other servers. Both report the same shape, so a grader never
// knows which ran.
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type Event = Record<string, unknown>;

/** One tool call, its name as Claude Code says it: `mcp__brainiac__<tool>`, `Bash`, `Edit`. */
export interface Call {
  readonly tool: string;
  readonly input: unknown;
  /** The tool refused it or it errored, so it did nothing. */
  readonly failed?: boolean;
  /** What the tool answered: its JSON when it was JSON, else its text. */
  readonly result?: unknown;
}

export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface Run {
  readonly events: readonly Event[];
  readonly calls: readonly Call[];
  /** The final answer, as the person reads it. */
  readonly text: string;
  /** The model that answered, as the harness reports it. */
  readonly model: string;
  readonly usage: Usage;
  /** What Claude Code says the run cost; Codex reports none. */
  readonly costUsd: number | undefined;
}

export interface Ask {
  readonly prompt: string;
  /** Claude Code's default when absent; Codex runs only on a model named here (`gpt-*`). */
  readonly model: string | undefined;
  readonly mcp: { readonly url: string; readonly token: string };
  /** Appended to the system prompt, as the plugin would load it. */
  readonly system: string;
  /**
   * A folder the run works in a throwaway copy of, with the model's own shell and file tools, its harness's sandbox
   * confining writes to the copy. Without one the run has no native tools at all.
   */
  readonly vault?: string;
}

export const isCodex = (model: string | undefined) => model?.startsWith("gpt-") ?? false;

// Everything Codex adds beyond its shell and file tools: none of it is Brainiac's, and a person's plugins, skills and
// web access would make a run measure their setup instead.
const CODEX_EXTRAS = [
  "plugins",
  "apps",
  "hooks",
  "skill_search",
  "tool_suggest",
  "browser_use",
  "computer_use",
  "image_generation",
  "multi_agent",
  "goals",
  "memories",
];
// Without a vault, no shell or file tools either: an answer comes from the record's tools, as Claude Code's `--tools ""`.
const CODEX_NATIVE = ["shell_tool", "unified_exec"];
/** The native tools a run with a vault has: the ones a person's Claude Code uses on files. */
const CLAUDE_NATIVE = "Bash,Read,Edit,Write,Glob,Grep";

/** The command one run spawns. Its token is in `env`, never `args`, so a printed request carries none. */
export function command(ask: Ask) {
  if (isCodex(ask.model))
    return {
      bin: "codex",
      args: [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        ask.vault === undefined ? "read-only" : "workspace-write",
        "--model",
        ask.model ?? "",
        ...[...CODEX_EXTRAS, ...(ask.vault === undefined ? CODEX_NATIVE : [])].flatMap((feature) => [
          "--disable",
          feature,
        ]),
        ...[
          "skills.include_instructions=false",
          'web_search="disabled"',
          'approval_policy="never"',
          // The sandbox may write only the vault's copy: never the temp folder where this run's CODEX_HOME lives.
          "sandbox_workspace_write.exclude_tmpdir_env_var=true",
          "sandbox_workspace_write.exclude_slash_tmp=true",
          `mcp_servers.brainiac.url=${JSON.stringify(ask.mcp.url)}`,
          'mcp_servers.brainiac.bearer_token_env_var="BRAINIAC_TOKEN"',
          // Brainiac's tools run without asking, as `--allowedTools` does for Claude Code: nobody is there to ask.
          'mcp_servers.brainiac.default_tools_approval_mode="approve"',
          // A TOML basic string: JSON's escapes are valid in one.
          `developer_instructions=${JSON.stringify(ask.system)}`,
        ].flatMap((setting) => ["-c", setting]),
        ask.prompt,
      ],
      env: { BRAINIAC_TOKEN: ask.mcp.token },
    };
  const config = {
    mcpServers: {
      brainiac: {
        type: "http",
        url: ask.mcp.url,
        headers: { authorization: "Bearer ${BRAINIAC_TOKEN}" },
      },
    },
  };
  return {
    bin: "claude",
    args: [
      ...(ask.model === undefined ? [] : ["--model", ask.model]),
      "-p",
      ask.prompt,
      // Restricted confines the file tools to the working folder (the vault's copy) and keeps none it doesn't name.
      "--restricted",
      "--tools",
      ask.vault === undefined ? "" : CLAUDE_NATIVE,
      ...(ask.vault === undefined
        ? []
        : [
            // Nobody is there to approve, so edits apply and sandboxed commands run, all inside the copy.
            "--permission-mode",
            "acceptEdits",
            "--settings",
            JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } }),
          ]),
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify(config),
      "--allowedTools",
      "mcp__brainiac__*",
      "--append-system-prompt",
      ask.system,
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    env: { BRAINIAC_TOKEN: ask.mcp.token },
  };
}

/** Whether the Codex sign-in at `file` is one, with tokens, refreshed after the one at `real`. */
export function refreshedAfter(file: string, real: string) {
  try {
    const read = (path: string) => record(JSON.parse(readFileSync(path, "utf8")));
    const next = read(file);
    const last = existsSync(real) ? Date.parse(String(read(real)["last_refresh"])) : Number.NaN;
    return (
      typeof record(next["tokens"])["refresh_token"] === "string" &&
      Date.parse(String(next["last_refresh"])) > (Number.isNaN(last) ? 0 : last)
    );
  } catch {
    return false; // not a sign-in Codex wrote
  }
}

/** Whether `bin` is on PATH, for a clear error before a paid run starts. */
export const installed = (bin: string) => spawnSync("which", [bin], { encoding: "utf8" }).status === 0;

/**
 * A Codex home holding only the person's sign-in, so their AGENTS.md, config, skills and plugins stay out. Codex
 * may refresh the sign-in during a run; if it replaced the link with a file, that file is the live one and goes
 * back, since the refresh retired the old token. Only a sign-in Codex refreshed goes back: valid, and refreshed
 * after the real one, so nothing the model wrote can stand in for it.
 */
function codexHome() {
  const home = mkdtempSync(join(tmpdir(), "brainiac-codex-"));
  const real = join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json");
  if (existsSync(real)) symlinkSync(real, join(home, "auth.json"));
  return {
    home,
    done: () => {
      const auth = join(home, "auth.json");
      if (existsSync(auth) && !lstatSync(auth).isSymbolicLink() && refreshedAfter(auth, real))
        copyFileSync(auth, real);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * The model Codex sent each turn to, from the session it wrote in `home`: what its config resolved, not just what
 * the command asked for. Several different ones read as all of them, which no asked model matches.
 */
export function codexModel(home: string) {
  const sessions = join(home, "sessions");
  const lines = existsSync(sessions)
    ? readdirSync(sessions, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".jsonl"))
        .flatMap((file) => readFileSync(join(sessions, file), "utf8").split("\n"))
    : [];
  const models = new Set(
    lines.flatMap((line) => {
      if (!line.includes('"turn_context"')) return [];
      const entry = record(JSON.parse(line));
      const model = record(entry["payload"])["model"];
      return entry["type"] === "turn_context" && typeof model === "string" ? [model] : [];
    }),
  );
  return [...models].join(" and ");
}

/** A tool answer's text blocks, read as the JSON Brainiac answers with. */
function answerOf(content: unknown): unknown {
  const text =
    typeof content === "string"
      ? content
      : (Array.isArray(content) ? content : [])
          .map((block) => record(block)["text"])
          .filter((part) => typeof part === "string")
          .join("");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const record = (value: unknown): Event => (typeof value === "object" && value !== null ? { ...value } : {});
const count = (value: unknown) => (typeof value === "number" ? value : 0);

/** Claude Code's stream-json events as a run. Throws unless it ended in a successful result: no answer to grade. */
export function fromClaude(events: readonly Event[]): Omit<Run, "events"> {
  const init = events.find((e) => e["type"] === "system" && e["subtype"] === "init");
  const result = events.find((e) => e["type"] === "result");
  if (result?.["subtype"] !== "success" || result["is_error"] === true)
    throw new Error(`The run didn't finish: ${JSON.stringify(result ?? "no result event")}`);
  const usage = record(result?.["usage"]);
  const parts = events.flatMap((event) => {
    const content = record(event["message"])["content"];
    return Array.isArray(content) ? content.map(record) : [];
  });
  const results = new Map(
    parts.filter((part) => part["type"] === "tool_result").map((part) => [part["tool_use_id"], part]),
  );
  return {
    calls: parts.flatMap((part) =>
      part["type"] === "tool_use"
        ? [
            {
              tool: String(part["name"]),
              input: part["input"],
              ...(results.get(part["id"])?.["is_error"] === true && { failed: true }),
              ...(results.has(part["id"]) && { result: answerOf(results.get(part["id"])?.["content"]) }),
            },
          ]
        : [],
    ),
    text: String(result?.["result"] ?? ""),
    model: String(init?.["model"] ?? ""),
    usage: {
      input: count(usage["input_tokens"]),
      output: count(usage["output_tokens"]),
      cacheRead: count(usage["cache_read_input_tokens"]),
      cacheWrite: count(usage["cache_creation_input_tokens"]),
    },
    costUsd: typeof result?.["total_cost_usd"] === "number" ? result["total_cost_usd"] : undefined,
  };
}

/**
 * Codex's `--json` events as a run, its tools named as Claude Code names them: an MCP call `mcp__<server>__<tool>`,
 * a command `Bash`, and a file change (`apply_patch`) `Edit`. Its events don't name the model, so `model` comes from
 * the session Codex wrote (`codexModel`). Throws unless every turn completed.
 */
export function fromCodex(events: readonly Event[], model: string): Omit<Run, "events"> {
  const failed = events.find((e) => e["type"] === "turn.failed");
  if (failed || !events.some((e) => e["type"] === "turn.completed"))
    throw new Error(`The run didn't finish: ${JSON.stringify(failed ?? "no completed turn")}`);
  const items = events.filter((e) => e["type"] === "item.completed").map((e) => record(e["item"]));
  const turns = events.filter((e) => e["type"] === "turn.completed").map((e) => record(e["usage"]));
  const sum = (key: string) => turns.reduce((total, usage) => total + count(usage[key]), 0);
  return {
    calls: items.flatMap((item): Call[] => {
      switch (item["type"]) {
        case "mcp_tool_call": {
          const result = record(item["result"]);
          const refused =
            (item["error"] ?? null) !== null || item["status"] === "failed" || result["isError"] === true;
          return [
            {
              tool: `mcp__${String(item["server"])}__${String(item["tool"])}`,
              input: item["arguments"],
              ...(refused && { failed: true }),
              ...(item["result"] !== undefined && { result: answerOf(result["content"]) }),
            },
          ];
        }
        case "command_execution":
          return [{ tool: "Bash", input: { command: item["command"] } }];
        case "file_change":
          return [{ tool: "Edit", input: { changes: item["changes"] } }];
        default:
          return [];
      }
    }),
    text: String(items.findLast((item) => item["type"] === "agent_message")?.["text"] ?? ""),
    model,
    usage: {
      // Codex counts cached input inside input; the summary keeps them apart, as Claude Code does.
      input: sum("input_tokens") - sum("cached_input_tokens"),
      output: sum("output_tokens"),
      cacheRead: sum("cached_input_tokens"),
      cacheWrite: sum("cache_write_input_tokens"),
    },
    costUsd: undefined,
  };
}

/**
 * Runs one ask in a new empty folder and reads its events. A run that reports a different model than the one asked
 * throws: a cheaper model answering in its place would pass or fail for the wrong reason.
 */
export async function run(ask: Ask): Promise<Run> {
  const { bin, args, env } = command(ask);
  const cwd = mkdtempSync(join(tmpdir(), "brainiac-eval-"));
  if (ask.vault !== undefined) cpSync(ask.vault, cwd, { recursive: true });
  const codex = isCodex(ask.model) ? codexHome() : undefined;
  try {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, ...env, ...(codex && { CODEX_HOME: codex.home }) },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const ended = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    ended.catch(() => {});
    const events: Event[] = [];
    for await (const line of createInterface({ input: child.stdout })) {
      try {
        events.push(JSON.parse(line));
      } catch {} // not an event: the harness's own warnings
    }
    const code = await ended;
    if (code !== 0) throw new Error(`${bin} exited with ${code}.`);
    const done = codex ? fromCodex(events, codexModel(codex.home)) : fromClaude(events);
    checkModel(ask.model, done.model);
    return { events, ...done };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    codex?.done();
  }
}

/** Throws unless `actual` is the model asked for: its id, or an alias it resolves to ("opus"). */
export function checkModel(asked: string | undefined, actual: string) {
  if (actual === "")
    throw new Error("The run reported no model, so it can't be trusted to be the one asked for.");
  if (asked !== undefined && (actual.includes(" and ") || !actual.includes(asked)))
    throw new Error(`Asked for ${asked}, but ${actual} answered.`);
}
