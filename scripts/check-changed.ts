#!/usr/bin/env node
// `vp run check:changed [--base origin/main]`: CI's checks, cut to what this branch changed, for the loop before a
// push. CI still runs every check in full.
//   format and lint   the changed files, or every file when the lint rules or their config changed
//   typecheck         every package (cached per package, so unchanged ones cost nothing)
//   tests             those whose imports reach a changed file (Vitest's --changed), plus the ones that reach files
//                     without importing them, which no import graph shows: workerd suites bundle a Worker by path,
//                     and tests read the fixtures and the agent skill from disk (then every test runs)
//   browser tests     the site's, when the site or a package it uses changed
//   unused code       knip over the repo, since a change can orphan a file it never touched
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dirname, "..");

/** git's output split on `separator`. */
const git = (args: string[], separator = "\n") => {
  const out = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr.trim()}`);
  return out.stdout.split(separator).filter(Boolean);
};

/** Files changed since `from`, committed or not, deleted ones included. */
function changedFiles(from: string): string[] {
  // -z: paths come NUL-separated and unquoted, so one with spaces or non-ASCII letters still matches the rules below.
  const files = [
    // --no-renames: a moved file counts at both paths, so moving one out of a watched folder still picks its tests.
    ...git(["diff", "--name-only", "--no-renames", "-z", from], "\0"),
    ...git(["ls-files", "-z", "--others", "--exclude-standard"], "\0"),
  ];
  return [...new Set(files)].toSorted();
}

/** Where a change can alter what a bundled Worker does: its app, the packages it bundles, or the bundlers. */
const REACHES_A_WORKER = /^(apps\/(worker|ocr|typst)\/|packages\/|scripts\/(bundle|ocr|typst)-worker\.ts$)/;
/** Files tests read from disk rather than import: the fixture student, the skill the evals hand to a model, and
 * the shared database's migrations. */
const READ_BY_PATH = /^(fixtures\/|apps\/cli\/plugin\/|infra\/migrations\/)/;
/** The site, the packages it bundles, and the fixture notes its browser tests import. */
const REACHES_THE_SITE = /^(apps\/web\/|packages\/|fixtures\/)/;
/** The lint rules, their config and the linter's own version, which judge files nobody changed. */
const LINTS_EVERYTHING = /^(oxlint-plugin-brainiac\/|vite\.config\.ts$|package\.json$|pnpm-lock\.yaml$)/;

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

/** Which tests `changed` calls for beyond what Vitest's import graph finds. */
export function testsFor(changed: readonly string[], suites: readonly string[]) {
  return {
    /** Every test, since one read a changed file by path. */
    all: changed.some((path) => READ_BY_PATH.test(path)),
    /** Every file to lint, since the rules changed. */
    lintAll: changed.some((path) => LINTS_EVERYTHING.test(path)),
    bundled: changed.some((path) => REACHES_A_WORKER.test(path)) ? [...suites] : [],
    browser: changed.some((path) => REACHES_THE_SITE.test(path)),
  };
}

function run(name: string, cmd: string, args: string[]): boolean {
  console.log(`\n▸ ${name}: ${cmd} ${args.join(" ")}`);
  const ok = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" }).status === 0;
  if (!ok) console.log(`✗ ${name} failed`);
  return ok;
}

function main() {
  const { values } = parseArgs({ options: { base: { type: "string", default: "origin/main" } } });
  const [from] = git(["merge-base", values.base, "HEAD"]);
  if (!from) throw new Error(`No merge base with ${values.base}. Fetch it first: git fetch origin main`);
  const changed = changedFiles(from);
  if (changed.length === 0) {
    console.log(`Nothing changed since ${values.base}.`);
    return;
  }
  console.log(`${changed.length} files changed since ${values.base}.`);
  const tests = testsFor(changed, bundledSuites());
  // A deleted file has nothing to format or lint; its absence still picks the tests above.
  const present = changed.filter((path) => existsSync(join(ROOT, path)));
  const results = [
    tests.lintAll
      ? run("Format and lint (all: the lint rules changed)", "vp", ["check"])
      : present.length === 0 ||
        run("Format and lint", "vp", ["check", "--no-error-on-unmatched-pattern", ...present]),
    run("Typecheck", "vp", ["run", "typecheck"]),
    tests.all
      ? run("Tests (all: a file tests read from disk changed)", "vp", ["test", "run"])
      : run("Tests", "vp", [
          "test",
          "run",
          "--changed",
          from,
          "--passWithNoTests",
          // Run once, below, rather than again here when the import graph happens to reach one.
          ...tests.bundled.flatMap((suite) => ["--exclude", suite]),
        ]) &&
        (tests.bundled.length === 0 || run("Bundled Worker tests", "vp", ["test", "run", ...tests.bundled])),
    !tests.browser || run("Browser tests", "vp", ["run", "test:browser"]),
    run("Unused code", "vp", ["run", "knip"]),
  ];
  if (results.includes(false)) process.exitCode = 1;
}

if (import.meta.main) main();
