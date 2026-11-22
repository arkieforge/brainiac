#!/usr/bin/env node
// `vp run scenarios:prove <scenario> --stage <stage> [--base origin/main] [--base-stage <stage>]`: the proof for a
// fix a person can see on the site. The scenario, as this branch has it, must pass on `--stage` (this branch: a PR's
// preview, or `local` under `vp run dev`) and fail on the base at one of its own steps, not before them. Without
// `--base-stage`, the base commit is deployed to a throwaway dev stage from a worktree beside this one, and both are
// removed afterwards; with it, that stage stands in for the base, and the proof names the stage, not a commit.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { isScenario, runScenarios, type Outcome } from "./e2e.ts";
import { SCENARIOS } from "./scenarios/index.ts";

const ROOT = join(import.meta.dirname, "..");

function run(cmd: string, args: string[], cwd: string) {
  console.log(`\n▸ ${cmd} ${args.join(" ")}`);
  if (spawnSync(cmd, args, { cwd, stdio: "inherit" }).status !== 0)
    throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd}`);
}

/**
 * Why the two runs prove nothing, or undefined when they prove the fix: it passes on the fix, and on the base it
 * fails at one of the scenario's own steps. A base that fails before them (its seed or sign-in) never reached the
 * behaviour.
 */
export function unproved(fix: Outcome, base: Outcome): string | undefined {
  if (fix.failure) return `it fails on the fix too: ${fix.failure}`;
  if (!base.failure) return "it passes on the base too, so it doesn't show the bug";
  if (!base.step)
    return `on the base it failed before its first step, so it never got to the bug: ${base.failure}`;
  return undefined;
}

/** Deploys `commit` to a throwaway stage, hands it to `use`, then destroys the stage and its worktree. */
async function withBaseStage<T>(commit: string, use: (stage: string) => Promise<T>): Promise<T> {
  // Unique per run, so two people proving against one commit never destroy each other's stage.
  const stage = `prove-${commit.slice(0, 8)}-${Date.now().toString(36)}`;
  const dir = join(ROOT, "..", stage);
  run("git", ["worktree", "add", "--detach", dir, commit], ROOT);
  try {
    run("node", ["scripts/setup-worktree.ts"], dir);
    try {
      // Inside the try: a deploy that fails halfway has still made resources to destroy.
      run("vp", ["run", "deploy", "--stage", stage, "--yes", "--no-input"], dir);
      return await use(stage);
    } finally {
      run("vp", ["run", "destroy", "--stage", stage, "--yes", "--no-input"], dir);
    }
  } finally {
    run("git", ["worktree", "remove", "--force", dir], ROOT);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      stage: { type: "string" },
      base: { type: "string", default: "origin/main" },
      "base-stage": { type: "string" },
      headed: { type: "boolean" },
      evidence: { type: "string" },
    },
  });
  const [name] = positionals;
  if (!name || !values.stage)
    throw new Error("Usage: vp run scenarios:prove <scenario> --stage <stage|local> [--base origin/main]");
  if (!isScenario(name))
    throw new Error(`No scenario ${name}; there are ${Object.keys(SCENARIOS).join(", ")}.`);
  const runOn = (stage: string, side: "fix" | "base") =>
    runScenarios(stage, [name], {
      headed: values.headed,
      evidence: values.evidence && join(values.evidence, side),
    });

  console.log(`On the fix (${values.stage}):`);
  const [fix] = await runOn(values.stage, "fix");
  if (!fix) throw new Error("the scenario didn't run");
  if (fix.failure) throw new Error(`Not proved: ${unproved(fix, fix)}`);

  const commit = spawnSync("git", ["merge-base", values.base, "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim();
  if (!commit) throw new Error(`No merge base with ${values.base}. Fetch it first: git fetch origin main`);
  const baseStage = values["base-stage"];
  const onBase = (stage: string) => {
    console.log(`\nOn the base (${baseStage ? `stage ${stage}` : `${commit.slice(0, 8)}, stage ${stage}`}):`);
    return runOn(stage, "base");
  };
  const [base] = await (baseStage ? onBase(baseStage) : withBaseStage(commit, onBase));
  if (!base) throw new Error("the scenario didn't run on the base");
  const why = unproved(fix, base);
  if (why) throw new Error(`Not proved: ${why}`);
  console.log(
    `\nProved: ${name} fails on ${baseStage ? `stage ${baseStage}` : commit.slice(0, 8)} at "${base.step}" and ` +
      `passes on ${values.stage}.\n  On the base: ${base.failure}`,
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
