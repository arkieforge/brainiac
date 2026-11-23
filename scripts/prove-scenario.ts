#!/usr/bin/env node
// `vp run scenarios:prove <scenario> --at "<step>" --stage <stage> [--base origin/main] [--base-stage <stage>]`: the
// proof for a fix a person can see on the site. The scenario, as this branch has it, must pass on `--stage` (this
// branch: a PR's preview, or `local` under `vp run dev`) and fail on the base at `--at`, the step that shows the bug;
// failing at another step, or before its first one, proves nothing. Without `--base-stage`, the base commit is
// deployed to a throwaway dev stage from a worktree beside this one, and both are removed afterwards; with it, that
// stage stands in for the base, and the proof names the stage, not a commit. A scenario that starts from a seeded
// record needs a base with /dev/seed, so against an older base it reports "before its first step".
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
 * fails at `at`, the step that shows the bug. A base that fails before its steps (the seed or the sign-in) never
 * reached the behaviour, and one that fails at another step shows some other difference.
 */
export function unproved(fix: Outcome, base: Outcome, at: string): string | undefined {
  if (fix.failure) return `it fails on the fix: ${fix.failure}`;
  if (!base.failure) return "it passes on the base too, so it doesn't show the bug";
  if (!base.step)
    return `on the base it failed before its first step, so it never got to the bug: ${base.failure}`;
  if (base.step !== at) return `on the base it failed at "${base.step}", not at "${at}": ${base.failure}`;
  return undefined;
}

/** Deploys `commit` to a throwaway stage, hands it to `use`, then destroys the stage and its worktree. */
async function withBaseStage<T>(commit: string, use: (stage: string) => Promise<T>): Promise<T> {
  // Unique per run, so two people proving against one commit never destroy each other's stage.
  const stage = `prove-${commit.slice(0, 8)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const dir = join(ROOT, "..", stage);
  // Ctrl-C ends this process mid-deploy, before any cleanup below can run.
  console.log(
    `If stopped early, clean up with: vp run destroy --stage ${stage}; git worktree remove --force ${dir}`,
  );
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
      at: { type: "string" },
      base: { type: "string", default: "origin/main" },
      "base-stage": { type: "string" },
      headed: { type: "boolean" },
      evidence: { type: "string" },
    },
  });
  const [name] = positionals;
  const { stage, at } = values;
  if (!name || !stage || !at)
    throw new Error(
      'Usage: vp run scenarios:prove <scenario> --at "<step that shows the bug>" --stage <stage|local> [--base origin/main]',
    );
  if (!isScenario(name))
    throw new Error(`No scenario ${name}; there are ${Object.keys(SCENARIOS).join(", ")}.`);
  const steps = SCENARIOS[name].steps.map((step) => step.name);
  if (!steps.includes(at))
    throw new Error(`${name} has no step "${at}"; its steps are: ${steps.join("; ")}.`);
  const runOn = (on: string, side: "fix" | "base") =>
    runScenarios(on, [name], {
      headed: values.headed,
      evidence: values.evidence && join(values.evidence, side),
    });

  console.log(`On the fix (${stage}):`);
  const [fix] = await runOn(stage, "fix");
  if (!fix) throw new Error("the scenario didn't run");
  if (fix.failure) throw new Error(`Not proved: it fails on the fix: ${fix.failure}`);

  const baseStage = values["base-stage"];
  let base: Outcome | undefined;
  let where: string;
  if (baseStage) {
    console.log(`\nOn the base (stage ${baseStage}):`);
    [base] = await runOn(baseStage, "base");
    where = `stage ${baseStage}`;
  } else {
    const commit = spawnSync("git", ["merge-base", values.base, "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).stdout.trim();
    if (!commit) throw new Error(`No merge base with ${values.base}. Fetch it first: git fetch origin main`);
    [base] = await withBaseStage(commit, (on) => {
      console.log(`\nOn the base (${commit.slice(0, 8)}, stage ${on}):`);
      return runOn(on, "base");
    });
    where = commit.slice(0, 8);
  }
  if (!base) throw new Error("the scenario didn't run on the base");
  const why = unproved(fix, base, at);
  if (why) throw new Error(`Not proved: ${why}`);
  console.log(
    `\nProved: ${name} fails on ${where} at "${at}" and passes on ${stage}.\n  On the base: ${base.failure}`,
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
