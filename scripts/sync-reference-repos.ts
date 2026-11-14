#!/usr/bin/env node
// `vp run repos:sync [id]`: shallow-clone or refresh the reference repos in `.repos/` (gitignored, read-only).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { type ReferenceRepo, referenceRepos } from "./reference-repos.ts";

const ROOT = join(import.meta.dirname, "..");
const deps: Record<string, string> = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
).devDependencies;

/** The ref to clone: the dependency's version tag when we pin one, else the configured ref. */
export function refFor(repo: ReferenceRepo, versions: Record<string, string> = deps): string {
  const version = repo.versionOf ? versions[repo.versionOf] : undefined;
  return version && repo.tag && /^\d/.test(version) ? repo.tag(version) : repo.ref;
}

function git(args: string[]) {
  return spawnSync("git", args, { cwd: ROOT, stdio: "inherit" }).status === 0;
}

if (import.meta.main) {
  const only = process.argv[2];
  const repos = only ? referenceRepos.filter((r) => r.id === only) : referenceRepos;
  if (only && repos.length === 0)
    throw new Error(`Unknown repo "${only}". Known: ${referenceRepos.map((r) => r.id).join(", ")}`);
  for (const repo of repos) {
    const dir = join(ROOT, ".repos", repo.id);
    const ref = refFor(repo);
    rmSync(dir, { recursive: true, force: true });
    // A pinned tag may not exist for every release; fall back to the default ref rather than failing.
    const ok =
      git(["clone", "--depth", "1", "--branch", ref, repo.url, dir]) ||
      (ref !== repo.ref && git(["clone", "--depth", "1", "--branch", repo.ref, repo.url, dir]));
    console.log(`${ok ? "synced" : "FAILED"} ${repo.id} (${ok && existsSync(dir) ? ref : "no checkout"})`);
    if (!ok) process.exitCode = 1;
  }
}
