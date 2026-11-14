#!/usr/bin/env node
// `vp run doctor`: checks this machine can build, test and deploy Brainiac, and says how to fix what isn't.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

interface Check {
  name: string;
  run: () => string | true; // true = ok, string = how to fix
  optional?: boolean;
}

const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
const major = (v: string) => Number(v.replace(/^v/, "").split(".")[0]);

export const checks: Check[] = [
  {
    name: "Node 26 or newer",
    run: () => major(process.version) >= 26 || `Node ${process.version}; install Node 26 (mise use node@26).`,
  },
  {
    name: "Vite+ (vp)",
    run: () => sh("vp", ["--version"]).status === 0 || "Install Vite+: curl -fsSL https://vite.plus | bash",
  },
  {
    name: "Dependencies installed",
    run: () => existsSync(join(ROOT, "node_modules/.bin/vp")) || "Run `vp i` in the repo root.",
  },
  {
    name: "Git hooks installed",
    run: () => {
      const hooks = sh("git", ["config", "core.hooksPath"]).stdout.trim();
      return hooks.includes(".vite-hooks") || "Run `vp config --no-agent` (or `vp i`, which runs it).";
    },
  },
  {
    name: "GitHub CLI signed in",
    optional: true,
    run: () => sh("gh", ["auth", "token"]).status === 0 || "Run `gh auth login` to work with issues and PRs.",
  },
  {
    // Secrets (Cloudflare, Neon, treg) come from Doppler, scoped to this folder (see docs/operations/development.md).
    name: "Doppler set up for this folder",
    optional: true,
    run: () =>
      sh("doppler", ["configure", "get", "project", "--plain"]).stdout.trim() === "braniac" ||
      "Run `doppler login --scope <this folder>` with the LaunchPad account, then `doppler setup --no-interactive`.",
  },
  {
    name: "Reference repos synced",
    optional: true,
    run: () =>
      existsSync(join(ROOT, ".repos/effect")) || "Run `vp run repos:sync` so agents can read library source.",
  },
  {
    name: "Pinned Alchemy version",
    run: () => {
      const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
      return (
        pkg.devDependencies?.alchemy === "0.94.0" || "alchemy must stay pinned to 0.94.0 (see issue #2)."
      );
    },
  },
];

if (import.meta.main) {
  let failed = 0;
  for (const check of checks) {
    const result = check.run();
    const ok = result === true;
    if (!ok && !check.optional) failed++;
    console.log(
      `${ok ? "ok  " : check.optional ? "warn" : "FAIL"}  ${check.name}${ok ? "" : `\n      ${result}`}`,
    );
  }
  process.exitCode = failed ? 1 : 0;
}
