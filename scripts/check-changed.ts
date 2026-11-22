#!/usr/bin/env node
// `vp run check:changed [--base origin/main]`: CI's checks, cut to what this branch changed, for the loop before a
// push. CI still runs every check in full.
//   format and lint   the changed files only
//   typecheck         every package (cached per package, so unchanged ones cost nothing)
//   tests             those whose imports reach a changed file (Vitest's --changed), plus the workerd suites that
//                     bundle a Worker by path, which no import graph shows
//   unused code       knip over the repo, since a change can orphan a file it never touched
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dirname, "..");

const git = (...args: string[]) => {
  const out = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr.trim()}`);
  return out.stdout.split("\n").filter(Boolean);
};

/** Files changed since the branch left `base`, committed or not, that still exist. */
function changedFiles(base: string): string[] {
  const [from] = git("merge-base", base, "HEAD");
  if (!from) throw new Error(`No merge base with ${base}. Fetch it first: git fetch origin main`);
  const files = [
    ...git("diff", "--name-only", "--diff-filter=d", from),
    ...git("ls-files", "--others", "--exclude-standard"),
  ];
  return [...new Set(files)].toSorted();
}

/** Where a change can alter what a bundled Worker does: its app, the packages it bundles, or the bundlers. */
const REACHES_A_WORKER = /^(apps\/(worker|ocr|typst)\/|packages\/|scripts\/(bundle|ocr|typst)-worker\.ts$)/;

/** Test files that load a Worker into workerd from a bundle (scripts/bundle-worker.ts), found by what they import. */
function bundledSuites(): string[] {
  return ["apps", "packages"].flatMap((top) =>
    readdirSync(join(ROOT, top), { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".test.ts") && !path.includes("node_modules"))
      .map((path) => `${top}/${path}`)
      .filter((path) =>
        /scripts\/(bundle|ocr|typst)-worker\.ts/.test(readFileSync(join(ROOT, path), "utf8")),
      ),
  );
}

/** The bundled suites to run for `changed`: all of them once anything a Worker bundles changed, else none. */
export function suitesFor(changed: readonly string[], suites: readonly string[]): string[] {
  return changed.some((path) => REACHES_A_WORKER.test(path)) ? [...suites] : [];
}

function run(name: string, cmd: string, args: string[]): boolean {
  console.log(`\n▸ ${name}: ${cmd} ${args.join(" ")}`);
  const ok = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" }).status === 0;
  if (!ok) console.log(`✗ ${name} failed`);
  return ok;
}

function main() {
  const { values } = parseArgs({ options: { base: { type: "string", default: "origin/main" } } });
  const changed = changedFiles(values.base);
  if (changed.length === 0) {
    console.log(`Nothing changed since ${values.base}.`);
    return;
  }
  console.log(`${changed.length} files changed since ${values.base}.`);
  const suites = suitesFor(changed, bundledSuites());
  const results = [
    run("Format and lint", "vp", ["check", "--no-error-on-unmatched-pattern", ...changed]),
    run("Typecheck", "vp", ["run", "typecheck"]),
    run("Tests", "vp", [
      "test",
      "run",
      "--changed",
      values.base,
      "--passWithNoTests",
      // Run once, below, rather than again here when the import graph happens to reach one.
      ...suites.flatMap((suite) => ["--exclude", suite]),
    ]),
    suites.length === 0 || run("Bundled Worker tests", "vp", ["test", "run", ...suites]),
    run("Unused code", "vp", ["run", "knip"]),
  ];
  if (results.includes(false)) process.exitCode = 1;
}

if (import.meta.main) main();
