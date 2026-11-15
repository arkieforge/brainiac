// The daemon's background filer (docs/internals/security.md, "Filer access"): a headless Claude Code run on the
// person's own subscription that files the inbox through Brainiac's tools and can reach nothing else. Its bridge
// is `brainiac mcp serve --background`, so the record narrows the device's connection for it: normal items only,
// and every change waits for the person.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { PROMPTS } from "@brainiac/base";
import type { Remote } from "@brainiac/sync";

/** How Claude Code starts the Brainiac MCP server: `brainiac mcp serve --background`. */
export interface Bridge {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Claude Code's arguments for one filing run. `--restricted --tools ""`: no built-in tool (no shell, no files, no
 * web) and none of the person's settings, hooks or plugins. `--strict-mcp-config` with a config holding only
 * Brainiac: none of their other MCP servers. `--allowedTools "mcp__brainiac__*"`: Brainiac's tools run without
 * asking, since nobody is there to ask. The prompt comes before them, so no list-taking flag reads it as a value.
 */
export function filingArgs(bridge: Bridge, model?: string): string[] {
  const config = { mcpServers: { brainiac: { type: "stdio", ...bridge } } };
  return [
    ...(model === undefined ? [] : ["--model", model]),
    "-p",
    PROMPTS.file_inbox.text(),
    "--restricted",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify(config),
    "--allowedTools",
    "mcp__brainiac__*",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
}

/** A run that goes on this long is stopped: its leases run out on their own and the items go to the next one. */
const RUN_MS = 30 * 60_000;

/** What a run printed (Claude Code's stream-json events), and how it ended. */
export interface Filed {
  readonly code: number | null;
  readonly events: readonly Record<string, unknown>[];
}

/**
 * One filing run, in a new empty folder removed after it, so no project's files or settings are near it.
 * `claude` is the binary `brainiac filing on` found: a login service's PATH is the system's, so its folder (which
 * also holds the Node a mise or npm install runs on) goes first on the run's PATH. `model` is for the filing eval;
 * the daemon uses the person's default. A binary that is gone rejects; it never takes the daemon down.
 */
export async function fileInbox(
  bridge: Bridge,
  { claude, model }: { readonly claude: string; readonly model?: string },
): Promise<Filed> {
  const cwd = mkdtempSync(join(tmpdir(), "brainiac-filing-"));
  try {
    const PATH = [dirname(claude), process.env["PATH"]].filter(Boolean).join(delimiter);
    const child = spawn(claude, filingArgs(bridge, model), {
      cwd,
      env: { ...process.env, PATH },
      stdio: ["ignore", "pipe", "inherit"],
    });
    // A run that ignores the stop is killed outright, so a hung one can't keep the daemon from filing again.
    let kill: ReturnType<typeof setTimeout> | undefined;
    const stop = setTimeout(() => {
      child.kill();
      kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, RUN_MS);
    const ended = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    // Handled here too: a spawn error rejects while stdout is still being read, before `ended` is awaited.
    ended.catch(() => {});
    const events: Record<string, unknown>[] = [];
    for await (const line of createInterface({ input: child.stdout })) {
      try {
        events.push(JSON.parse(line));
      } catch {} // not an event: Claude Code's own warnings
    }
    const code = await ended.finally(() => {
      clearTimeout(stop);
      clearTimeout(kill);
    });
    return { code, events };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Whether a note the record holds (deleted ones it no longer does) is one a background run may file: normal, in `inbox/`. */
export const fileable = (note: Remote | undefined): boolean =>
  note !== undefined && note.class === "normal" && note.path.toLowerCase().startsWith("inbox/");

/**
 * Starts `run` for inbox items it hasn't seen, one run at a time; items that arrive during a run start one more
 * after it. An item a run leaves (it asked the person) doesn't start another until something new arrives.
 */
export function filer(run: () => Promise<void>): (ids: Iterable<string>) => void {
  const seen = new Set<string>();
  let running = false;
  let again = false;
  const start = () => {
    if (running) return void (again = true);
    running = true;
    void run()
      .catch((error: unknown) => console.error("brainiac filing failed:", error))
      .finally(() => {
        running = false;
        if (again) {
          again = false;
          start();
        }
      });
  };
  return (ids) => {
    const fresh = [...ids].filter((id) => !seen.has(id));
    for (const id of fresh) seen.add(id);
    if (fresh.length > 0) start();
  };
}
