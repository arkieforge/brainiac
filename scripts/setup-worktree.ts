#!/usr/bin/env node
// Runs when T3 Code creates a worktree (t3.json): install, link the main checkout's .env, sync reference repos.
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
  const main = mainCheckout();
  const env = main && join(main, ".env");
  if (env && main !== ROOT && existsSync(env) && !existsSync(join(ROOT, ".env"))) {
    symlinkSync(env, join(ROOT, ".env"));
    console.log("linked .env from the main checkout");
  }
  if (main && main !== ROOT) {
    // Clone the reference repos once, into the main checkout, and share them with every worktree.
    if (!existsSync(join(main, ".repos"))) {
      spawnSync("node", ["scripts/sync-reference-repos.ts"], { cwd: main, stdio: "inherit" });
    }
    if (existsSync(join(main, ".repos")) && !existsSync(join(ROOT, ".repos"))) {
      symlinkSync(join(main, ".repos"), join(ROOT, ".repos"));
    }
  } else if (!existsSync(join(ROOT, ".repos"))) {
    run("node", ["scripts/sync-reference-repos.ts"]);
  }
}
