// The mcp-tool-use eval's cases (cases.ndjson) and grader: what a run's tool calls and final answer must and must not
// hold. The grader reads tool names as Claude Code says them, which the runners give Codex's calls too.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CASES as ANSWERS, type Answered } from "../answers/cases.ts";
import type { Call } from "../shared/runners.ts";

/** A tool call a check looks for: a Brainiac tool by its bare name (`update`), or a native one (`Edit`). */
export interface Expected {
  readonly tool: string;
  /** Matched as `matches` reads it; absent matches any call to `tool`. */
  readonly args?: unknown;
}

/** A value the record must hold after the run: in a live note, or in an open proposal waiting for the person. */
export interface Held {
  /** The note's id, or any note of `type`. */
  readonly note?: string;
  readonly type?: string;
  readonly field: string;
  /** Matched as `matches` reads it. */
  readonly value: unknown;
}

export interface Expect {
  /** The first Brainiac call. */
  readonly first?: string;
  readonly calls?: readonly Expected[];
  readonly callsMustNot?: readonly Expected[];
  /** Each pair [a, b]: if `b` was called, `a` was called before it. */
  readonly before?: readonly (readonly [string, string])[];
  /** Regexes, case-insensitive, on the final answer. */
  readonly finalTextMust?: readonly string[];
  readonly finalTextMustNot?: readonly string[];
  /** No Edit or Write, and no shell command that writes the vault or reads its sensitive folders. */
  readonly noVaultWrites?: boolean;
  readonly record?: readonly Held[];
  /** An answers eval case (evals/answers/cases.ts) whose grader the final answer must pass: its tested checks. */
  readonly answer?: string;
}

export interface Case {
  readonly id: string;
  readonly kind: "bad" | "guard" | "control";
  /** Where it comes from: the issue, the skill rule or the mistake. */
  readonly source: string;
  readonly prompt: string;
  /** Exact-value canary: fails on any failing sample. */
  readonly exact?: boolean;
  /** The model's own shell and file tools run in a throwaway copy of the fixture vault. */
  readonly native?: boolean;
  readonly expect: Expect;
}

const EXPECT_KEYS = [
  "first",
  "calls",
  "callsMustNot",
  "before",
  "finalTextMust",
  "finalTextMustNot",
  "noVaultWrites",
  "record",
  "answer",
];

/** Cases from ndjson, one a line. A misspelled check would pass silently, so an unknown key throws. */
export function parseCases(text: string): Case[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const parsed: Case = JSON.parse(line);
      const unknown = Object.keys(parsed.expect ?? {}).filter((key) => !EXPECT_KEYS.includes(key));
      if (
        !parsed.id ||
        !parsed.prompt ||
        !parsed.source ||
        !["bad", "guard", "control"].includes(parsed.kind)
      )
        throw new Error(`A case needs id, kind, source and prompt: ${line}`);
      if (unknown.length > 0) throw new Error(`${parsed.id}: unknown check ${unknown.join(", ")}`);
      const answer = parsed.expect.answer;
      if (answer !== undefined && !ANSWERS.some((c) => c.id === answer))
        throw new Error(`${parsed.id}: no answers case ${answer}`);
      return parsed;
    });
}

export const CASES = parseCases(readFileSync(join(import.meta.dirname, "cases.ndjson"), "utf8"));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether `actual` holds `expected`: equal values; a string starting `~` is a case-insensitive substring of the
 * value's JSON; an array needs each of its items matched by some item of the actual one; an object needs each of
 * its keys, read as a dotted path into `actual`, to match.
 */
export function matches(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "string" && expected.startsWith("~"))
    return (
      actual !== undefined && JSON.stringify(actual).toLowerCase().includes(expected.slice(1).toLowerCase())
    );
  if (Array.isArray(expected))
    return Array.isArray(actual) && expected.every((item) => actual.some((at) => matches(item, at)));
  if (!isRecord(expected)) return expected === actual;
  return Object.entries(expected).every(([path, value]) =>
    matches(
      value,
      path.split(".").reduce<unknown>((at, key) => (isRecord(at) ? at[key] : undefined), actual),
    ),
  );
}

/** A Brainiac tool's bare name as the harness calls it. */
const named = (tool: string) => (/^[a-z_]+$/.test(tool) ? `mcp__brainiac__${tool}` : tool);

// Shell commands that change files (redirects to /dev/null and between streams don't).
const WRITES =
  /(^|[\s;&|('"])["']?(\S*\/)?(rm|mv|cp|touch|tee|mkdir|rmdir|ln|chmod|truncate|dd|install|patch|python3?|node|ruby|perl|bun|deno)["']?\s|\bsed\s+(-\w+\s+)*-\w*i|\bgit\s+(commit|checkout|apply|reset|restore|mv|rm|stash)\b|>(?!\s*\/dev\/null|&)/;
// The folders the skill says never to read from disk.
const SENSITIVE = /\b(facts\/tests|documents\/files|unorganized|inbox)\b/;
const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** Why `call` touched the vault directly, or undefined when it didn't. */
export function vaultTouch(call: Call): string | undefined {
  if (FILE_TOOLS.has(call.tool)) return `${call.tool} wrote a file`;
  if (call.tool !== "Bash") return undefined;
  const command = String(isRecord(call.input) ? call.input["command"] : "").replaceAll(/\d?>&\d/g, "");
  if (WRITES.test(command)) return `a shell command changed files: ${command}`;
  if (SENSITIVE.test(command)) return `a shell command read a sensitive folder: ${command}`;
  return undefined;
}

/** A note as the record holds it after the run, or as an open proposal would leave it. */
export interface State {
  readonly id: string;
  readonly type: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** What a run did, for the grader. */
export interface Graded {
  readonly calls: readonly Call[];
  readonly text: string;
  /** What the notes the run could see hold, as the answers graders compare an answer with it. */
  readonly facts: Omit<Answered, "said">;
  readonly states: readonly State[];
}

// A change's answers that leave the record as it was. Applied, proposed and needsApproval (waiting for the person's
// passkey) all made the change the agent could make.
const UNCHANGED = new Set(["duplicate", "invalid", "forbidden", "conflict", "rejected"]);

/** Whether a call did nothing: the tool refused it, it was a dry run, or its answer says nothing changed. */
const didNothing = (call: Call) =>
  call.failed === true ||
  (isRecord(call.input) && call.input["dry_run"] === true) ||
  (isRecord(call.result) && UNCHANGED.has(String(call.result["status"])));

const label = ({ tool, args }: Expected) => (args === undefined ? tool : `${tool} ${JSON.stringify(args)}`);

/** Every check a case makes and whether this run passed it. */
export function grade(expect: Expect, run: Graded): { readonly check: string; readonly pass: boolean }[] {
  const checks: { check: string; pass: boolean }[] = [];
  const add = (check: string, pass: boolean) => checks.push({ check, pass });
  // A call that did nothing can't be the call a case needs; it still counts as attempted.
  const found = ({ tool, args }: Expected, attempts = false) =>
    run.calls.some(
      (call) =>
        call.tool === named(tool) &&
        (attempts || !didNothing(call)) &&
        (args === undefined || matches(args, call.input)),
    );
  if (expect.first !== undefined)
    add(
      `first ${expect.first}`,
      run.calls.find((call) => call.tool.startsWith("mcp__brainiac__"))?.tool === named(expect.first),
    );
  for (const call of expect.calls ?? []) add(`calls ${label(call)}`, found(call));
  for (const call of expect.callsMustNot ?? []) add(`callsMustNot ${label(call)}`, !found(call, true));
  for (const [a, b] of expect.before ?? []) {
    const at = (tool: string) => run.calls.findIndex((call) => call.tool === named(tool));
    add(`${a} before ${b}`, at(b) < 0 || (at(a) >= 0 && at(a) < at(b)));
  }
  for (const pattern of expect.finalTextMust ?? [])
    add(`finalTextMust /${pattern}/`, new RegExp(pattern, "i").test(run.text));
  for (const pattern of expect.finalTextMustNot ?? [])
    add(`finalTextMustNot /${pattern}/`, !new RegExp(pattern, "i").test(run.text));
  for (const held of expect.record ?? [])
    add(
      `record ${JSON.stringify(held)}`,
      run.states.some(
        (state) =>
          (held.note === undefined || state.id === held.note) &&
          (held.type === undefined || state.type === held.type) &&
          matches(held.value, state.fields[held.field]),
      ),
    );
  if (expect.answer !== undefined) {
    const why = ANSWERS.find((c) => c.id === expect.answer)?.check({ said: run.text, ...run.facts });
    add(`answer ${expect.answer}${why ? `: ${why}` : ""}`, why === undefined);
  }
  if (expect.noVaultWrites) {
    const touched = run.calls.map(vaultTouch).find((why) => why !== undefined);
    add(`noVaultWrites${touched ? `: ${touched}` : ""}`, touched === undefined);
  }
  return checks;
}
