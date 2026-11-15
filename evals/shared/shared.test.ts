// The shared harness's logic, which CI runs: verdicts and sampling, reading each harness's events, the model check,
// and baselines. Paid runs themselves don't run here (evals/README.md).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { readBaseline, report } from "./cli.ts";
import { checkModel, codexModel, command, fromClaude, fromCodex } from "./runners.ts";
import { another, passes, sampled } from "./sampling.ts";

const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** A run of two samples whose results are `oks`, a 3rd one passing. */
const sampleRun = (oks: boolean[], strict: boolean) =>
  sampled(2, strict, async (sample) => ({ sample, ok: oks[sample - 1] ?? true }));
const item = (value: object) => ({ type: "item.completed", item: value });
/** One shared run's rows: the guard's and the control's results, sample by sample. */
const rows = (guard: boolean[], control: boolean[]) => [
  ...guard.map((ok) => ({ case: "guard", ok })),
  ...control.map((ok) => ({ case: "control", ok })),
];
/** A line of Codex's session file naming the model a turn went to. */
const turn = (model: string) => JSON.stringify({ type: "turn_context", payload: { model } });
const ASK = {
  prompt: "Which university?",
  mcp: { url: "http://127.0.0.1:1/mcp", token: "secret-token" },
  system: "skill",
};

describe("sampling", () => {
  it("a strict case fails on any failing sample; the others when half or more fail", () => {
    expect([passes(true, 0, 2), passes(true, 1, 3), passes(true, 1, 2)]).toEqual([true, false, false]);
    expect([passes(false, 0, 2), passes(false, 1, 3), passes(false, 1, 2), passes(false, 2, 3)]).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("takes a 3rd sample only when two disagree and the case isn't strict", async () => {
    expect((await sampleRun([true, false, true], false)).map((r) => r.sample)).toEqual([1, 2, 3]);
    expect((await sampleRun([true, true], false)).map((r) => r.sample)).toEqual([1, 2]);
    expect((await sampleRun([true, false], true)).map((r) => r.sample)).toEqual([1, 2]);
  });

  it("takes a 3rd shared run when a control disagrees, never for a guard alone", () => {
    const cases = [
      { id: "guard", strict: true },
      { id: "control", strict: false },
    ];
    expect(another(2, 2, cases, [])).toBe(true);
    expect(another(3, 2, cases, rows([true, true], [true, false]))).toBe(true);
    expect(another(3, 2, cases, rows([true, false], [true, true]))).toBe(false);
    expect(another(4, 2, cases, rows([true, true, true], [true, false, true]))).toBe(false);
  });
});

describe("runners", () => {
  it("keeps the token out of the command, and Codex to Brainiac's server alone", () => {
    for (const model of [undefined, "opus", "gpt-6.1-sol"]) {
      const { args, env } = command({ ...ASK, model });
      expect(JSON.stringify(args)).not.toContain("secret-token");
      expect(env.BRAINIAC_TOKEN).toBe("secret-token");
    }
    const codex = command({ ...ASK, model: "gpt-6.1-sol" }).args;
    expect(codex.filter((arg) => arg.startsWith("mcp_servers.")).map((arg) => arg.split(".")[1])).toEqual([
      "brainiac",
      "brainiac",
      "brainiac",
    ]);
    expect(codex).toContain("shell_tool");
  });

  it("reads Codex's events as Claude Code names them: apply_patch is an Edit, a command is Bash", () => {
    const run = fromCodex(
      [
        item({ type: "mcp_tool_call", server: "brainiac", tool: "describe", arguments: {} }),
        item({ type: "command_execution", command: "cat me.md" }),
        item({ type: "file_change", changes: [{ path: "me.md", kind: "update" }] }),
        item({ type: "agent_message", text: "draft" }),
        item({ type: "agent_message", text: "Northvale University." }),
        { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 7 } },
      ],
      "gpt-6.1-sol",
    );
    expect(() => fromCodex([{ type: "turn.failed", error: { message: "limit" } }], "gpt-6.1-sol")).toThrow(
      /didn't finish/,
    );
    expect(() => fromCodex([item({ type: "agent_message", text: "half" })], "gpt-6.1-sol")).toThrow(
      /didn't finish/,
    );
    expect(run.calls.map((call) => call.tool)).toEqual(["mcp__brainiac__describe", "Bash", "Edit"]);
    expect([run.text, run.model, run.usage]).toEqual([
      "Northvale University.",
      "gpt-6.1-sol",
      { input: 40, output: 7, cacheRead: 60, cacheWrite: 0 },
    ]);
  });

  it("reads Claude Code's model from its init event, and its cost from the result", () => {
    const run = fromClaude([
      { type: "system", subtype: "init", model: "claude-opus-5-5" },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "mcp__brainiac__ask", input: { q: 1 } }] },
      },
      {
        type: "result",
        subtype: "success",
        result: "Northvale.",
        total_cost_usd: 0.25,
        usage: { input_tokens: 3, output_tokens: 9 },
      },
    ]);
    expect(run).toEqual({
      calls: [{ tool: "mcp__brainiac__ask", input: { q: 1 } }],
      text: "Northvale.",
      model: "claude-opus-5-5",
      usage: { ...NO_USAGE, input: 3, output: 9 },
      costUsd: 0.25,
    });
    expect(() => fromClaude([{ type: "result", subtype: "error_max_turns", is_error: true }])).toThrow(
      /didn't finish/,
    );
    expect(() => fromClaude([])).toThrow(/didn't finish/);
  });

  it("reads the model Codex sent each turn to from the session it wrote", () => {
    const home = mkdtempSync(join(tmpdir(), "brainiac-eval-test-"));
    try {
      expect(codexModel(home)).toBe("");
      const day = join(home, "sessions/2026/11/16");
      mkdirSync(day, { recursive: true });
      writeFileSync(
        join(day, "rollout.jsonl"),
        [JSON.stringify({ type: "session_meta" }), turn("gpt-6.1-sol")].join("\n"),
      );
      expect(codexModel(home)).toBe("gpt-6.1-sol");
      writeFileSync(join(day, "rollout.jsonl"), [turn("gpt-6.1-sol"), turn("gpt-6-luna")].join("\n"));
      expect(() => checkModel("gpt-6.1-sol", codexModel(home))).toThrow(
        /gpt-6.1-sol and gpt-6-luna answered/,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses a run that a model other than the one asked for answered", () => {
    expect(() => checkModel("opus", "claude-opus-5-5")).not.toThrow();
    expect(() => checkModel(undefined, "claude-sonnet-5-5")).not.toThrow();
    expect(() => checkModel("claude-opus-5-5", "claude-sonnet-5-5")).toThrow(/Asked for claude-opus-5-5/);
    expect(() => checkModel("opus", "")).toThrow(/no model/);
  });
});

describe("report", () => {
  it("marks a case that passed every baseline sample and now fails one as a regression", () => {
    const out = mkdtempSync(join(tmpdir(), "brainiac-eval-test-"));
    try {
      const row = (id: string, ok: boolean) => ({ case: id, sample: 1, ok, model: "m", usage: NO_USAGE });
      writeFileSync(
        join(out, "before.ndjson"),
        [row("a", true), row("b", false)].map((r) => JSON.stringify(r)).join("\n"),
      );
      const baseline = readBaseline(join(out, "before.ndjson"));
      expect([...baseline]).toEqual([
        ["a", 1],
        ["b", 0],
      ]);
      const ok = report(out, {
        name: "test",
        model: undefined,
        samples: 1,
        cases: [
          { id: "a", kind: "guard", strict: true },
          { id: "b", kind: "control", strict: false },
          { id: "c", kind: "control", strict: false },
        ],
        rows: [row("a", false), row("b", true)],
        baseline,
      });
      const summary = readFileSync(join(out, "summary.md"), "utf8");
      expect(ok).toBe(false);
      expect(summary).toContain("| a | guard | yes | 1/1 | FAIL | 100%, REGRESSED |");
      expect(summary).toContain("| b | control | no | 0/1 | pass | 0% |");
      // A case with no sample proves nothing.
      expect(summary).toContain("| c | control | no | 0/0 | FAIL | new |");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
