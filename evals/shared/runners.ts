// The models users bring, run headless on the runner's own subscription: Claude Code (`claude -p`) and Codex
// (`codex exec`). Each run sees Brainiac's `/mcp` as its only MCP server and the agent skill, and none of this
// machine's settings, instructions, hooks, plugins or other servers. Both report the same shape, so a grader never
// knows which ran.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, copyFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type Event = Record<string, unknown>;

/** One tool call, its name as Claude Code says it: `mcp__brainiac__<tool>`, `Bash`, `Edit`. */
export interface Call {
  readonly tool: string;
  readonly input: unknown;
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
}

export const isCodex = (model: string | undefined) => model?.startsWith("gpt-") ?? false;

// Everything Codex adds beyond its shell and file tools: none of it is Brainiac's, and a person's plugins, skills and
// web access would make a run measure their setup instead.
const CODEX_OFF = [
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
  // No shell or file tools either: an answer comes from the record's tools, as Claude Code's `--tools ""`.
  "shell_tool",
  "unified_exec",
];

/** The command one run spawns. Its token is in `env`, never `args`, so a printed request carries none. */
export function command(ask: Ask) {
  if (isCodex(ask.model))
    return {
      bin: "codex",
      args: [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--model",
        ask.model ?? "",
        ...CODEX_OFF.flatMap((feature) => ["--disable", feature]),
        ...[
          "skills.include_instructions=false",
          'web_search="disabled"',
          'approval_policy="never"',
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
      "--restricted",
      "--tools",
      "",
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

/** Whether `bin` is on PATH, for a clear error before a paid run starts. */
export const installed = (bin: string) => spawnSync("which", [bin], { encoding: "utf8" }).status === 0;

/**
 * A Codex home holding only the person's sign-in, so their AGENTS.md, config, skills and plugins stay out. Codex
 * may refresh the sign-in during a run; if it replaced the link with a file, that file is the live one and goes
 * back, since the refresh retired the old token.
 */
function codexHome() {
  const home = mkdtempSync(join(tmpdir(), "brainiac-codex-"));
  const real = join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json");
  if (existsSync(real)) symlinkSync(real, join(home, "auth.json"));
  return {
    home,
    done: () => {
      const auth = join(home, "auth.json");
      if (existsSync(auth) && !lstatSync(auth).isSymbolicLink()) copyFileSync(auth, real);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const record = (value: unknown): Event => (typeof value === "object" && value !== null ? { ...value } : {});
const count = (value: unknown) => (typeof value === "number" ? value : 0);

/** Claude Code's stream-json events as a run. */
export function fromClaude(events: readonly Event[]): Omit<Run, "events"> {
  const init = events.find((e) => e["type"] === "system" && e["subtype"] === "init");
  const result = events.find((e) => e["type"] === "result");
  const usage = record(result?.["usage"]);
  return {
    calls: events.flatMap((event) => {
      const content = record(event["message"])["content"];
      return (Array.isArray(content) ? content : []).flatMap((part: Event) =>
        part["type"] === "tool_use" ? [{ tool: String(part["name"]), input: part["input"] }] : [],
      );
    }),
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
 * a command `Bash`, and a file change (`apply_patch`) `Edit`. Codex doesn't report its model, so it's the one asked.
 */
export function fromCodex(events: readonly Event[], model: string): Omit<Run, "events"> {
  const items = events.filter((e) => e["type"] === "item.completed").map((e) => record(e["item"]));
  const turns = events.filter((e) => e["type"] === "turn.completed").map((e) => record(e["usage"]));
  const sum = (key: string) => turns.reduce((total, usage) => total + count(usage[key]), 0);
  return {
    calls: items.flatMap((item): Call[] => {
      switch (item["type"]) {
        case "mcp_tool_call":
          return [
            { tool: `mcp__${String(item["server"])}__${String(item["tool"])}`, input: item["arguments"] },
          ];
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
    await ended;
    const done = codex ? fromCodex(events, ask.model ?? "") : fromClaude(events);
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
  if (asked !== undefined && !actual.includes(asked))
    throw new Error(`Asked for ${asked}, but ${actual} answered.`);
}
