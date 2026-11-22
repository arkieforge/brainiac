#!/usr/bin/env node
// `vp run scenarios:prove <scenario> --stage <stage> [--base origin/main] [--base-stage <stage>]`: the proof for a
// fix a person can see on the site. The scenario, as this branch has it, must pass on `--stage` (this branch: a PR's
// preview, or `local` under `vp run dev`) and fail on the base commit. Without `--base-stage`, the base commit is
// deployed to a throwaway dev stage from a worktree beside this one, and both are removed afterwards.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { runScenarios, type Outcome } from "./e2e.ts";

const ROOT = join(import.meta.dirname, "..");

function run(cmd: string, args: string[], cwd: string) {
  console.log(`\n▸ ${cmd} ${args.join(" ")}`);
  if (spawnSync(cmd, args, { cwd, stdio: "inherit" }).status !== 0)
    throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd}`);
}

/** The verdict: proved only when the scenario passes on the fix and fails on the base. */
export function verdict(fix: Outcome, base: Outcome): string | undefined {
  if (fix.failure) return `it fails on the fix too, so it proves nothing yet: ${fix.failure}`;
  if (!base.failure) return "it passes on the base too, so it doesn't show the bug";
  return undefined;
}

/** Deploys `commit` to a throwaway stage, hands it to `use`, then destroys the stage and its worktree. */
async function withBaseStage<T>(commit: string, use: (stage: string) => Promise<T>): Promise<T> {
  const stage = `prove-${commit.slice(0, 8)}`;
  const dir = join(ROOT, "..", stage);
  run("git", ["worktree", "add", "--detach", dir, commit], ROOT);
  try {
    run("node", ["scripts/setup-worktree.ts"], dir);
    run("vp", ["run", "deploy", "--stage", stage, "--yes", "--no-input"], dir);
    try {
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
  const opts = { headed: values.headed, evidence: values.evidence };

  console.log(`On the fix (${values.stage}):`);
  const [fix] = await runScenarios(values.stage, [name], opts);
  if (!fix) throw new Error("the scenario didn't run");
  if (fix.failure) throw new Error(`Not proved: ${verdict(fix, fix)}`);

  const commit = spawnSync("git", ["merge-base", values.base, "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim();
  if (!commit) throw new Error(`No merge base with ${values.base}. Fetch it first: git fetch origin main`);
  const onBase = (stage: string) => {
    console.log(`\nOn the base (${commit.slice(0, 8)}, stage ${stage}):`);
    return runScenarios(stage, [name], opts);
  };
  const [base] = await (values["base-stage"] ? onBase(values["base-stage"]) : withBaseStage(commit, onBase));
  if (!base) throw new Error("the scenario didn't run on the base");
  const why = verdict(fix, base);
  if (why) throw new Error(`Not proved: ${why}`);
  console.log(`\nProved: ${name} fails on ${commit.slice(0, 8)} and passes on ${values.stage}.`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
