#!/usr/bin/env node
// `vp run repos:sync [id] [--root <dir>] [--missing]`: shallow-clone the reference repos into
// `<root>/.repos/` (gitignored, read-only). `--missing` keeps checkouts that already exist.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { type ReferenceRepo, referenceRepos } from "./reference-repos.ts";

const ROOT = join(import.meta.dirname, "..");

/** The ref to clone: the dependency's version tag when we pin one, else the configured ref. */
export function refFor(repo: ReferenceRepo, versions: Record<string, string>): string {
  const version = repo.versionOf ? versions[repo.versionOf] : undefined;
  return version && repo.tag && /^\d/.test(version) ? repo.tag(version) : repo.ref;
}

/** A checkout counts only when its git metadata exists, so a half-finished clone is retried. */
export const isCheckedOut = (dir: string) => existsSync(join(dir, ".git"));

if (import.meta.main) {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf("--root");
  const root = rootFlag >= 0 ? resolve(args[rootFlag + 1] ?? ".") : ROOT;
  const missingOnly = args.includes("--missing");
  const only = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--root");
  const repos = only ? referenceRepos.filter((r) => r.id === only) : referenceRepos;
  if (only && repos.length === 0) {
    throw new Error(`Unknown repo "${only}". Known: ${referenceRepos.map((r) => r.id).join(", ")}`);
  }
  const versions: Record<string, string> = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  ).devDependencies;
  const git = (a: string[]) => spawnSync("git", a, { cwd: root, stdio: "inherit" }).status === 0;
  for (const repo of repos) {
    const dir = join(root, ".repos", repo.id);
    if (missingOnly && isCheckedOut(dir)) continue;
    const ref = refFor(repo, versions);
    rmSync(dir, { recursive: true, force: true });
    // A pinned tag may not exist for every release; fall back to the default ref rather than failing.
    const ok =
      git(["clone", "--depth", "1", "--branch", ref, repo.url, dir]) ||
      (ref !== repo.ref && git(["clone", "--depth", "1", "--branch", repo.ref, repo.url, dir]));
    console.log(`${ok ? "synced" : "FAILED"} ${repo.id}${ok ? ` (${ref})` : ""}`);
    if (!ok) process.exitCode = 1;
  }
}
