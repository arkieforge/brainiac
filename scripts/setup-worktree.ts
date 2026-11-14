#!/usr/bin/env node
// Runs when T3 Code creates a worktree (t3.json): install, link the main checkout's .env, and share
// reference repos cloned once into the main checkout.
import { spawnSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const run = (cmd: string, args: string[]) =>
  spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" }).status === 0;

/** The main checkout of this repo (the parent of the shared .git directory). */
export function mainCheckout(): string | undefined {
  const out = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.status === 0 ? dirname(out.stdout.trim()) : undefined;
}

if (import.meta.main) {
  if (!run("vp", ["i"])) process.exit(1);
  const main = mainCheckout() ?? ROOT;
  const env = join(main, ".env");
  if (main !== ROOT && existsSync(env) && !existsSync(join(ROOT, ".env"))) {
    symlinkSync(env, join(ROOT, ".env"));
    console.log("linked .env from the main checkout");
  }
  // This worktree's own sync script, aimed at the main checkout, so it works even when main is older.
  const synced = run("node", ["scripts/sync-reference-repos.ts", "--root", main, "--missing"]);
  if (main !== ROOT && existsSync(join(main, ".repos")) && !existsSync(join(ROOT, ".repos"))) {
    symlinkSync(join(main, ".repos"), join(ROOT, ".repos"));
  }
  if (!synced) {
    // Reference repos are optional for building; say so loudly instead of failing the worktree.
    console.warn("WARN: some reference repos are missing. Retry with `vp run repos:sync -- --missing`.");
  }
}
