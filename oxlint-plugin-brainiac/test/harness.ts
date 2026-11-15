import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { it } from "vite-plus/test";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURES = join(import.meta.dirname, "..", ".fixtures");

/**
 * Runs the real `vp lint` (root config, this plugin) on one source file and returns its output. `path` places the
 * file under the fixtures folder, for rules that read where a file lives.
 */
function lint(source: string, name: string, path = `${name.replace(/\W+/g, "-")}.ts`): string {
  const file = join(FIXTURES, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  try {
    const run = spawnSync(join(ROOT, "node_modules/.bin/vp"), ["lint", file], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return `${run.stdout}${run.stderr}`;
  } finally {
    rmSync(file, { force: true });
  }
}

/** valid/invalid cases for one rule, each a real lint run. */
export function ruleHarness(rule: string) {
  const tag = `brainiac(${rule})`;
  return {
    valid: (name: string, source: string, path?: string) =>
      it(`valid: ${name}`, ({ expect }) => expect(lint(source, name, path)).not.toContain(tag)),
    invalid: (name: string, source: string, path?: string) =>
      it(`invalid: ${name}`, ({ expect }) => expect(lint(source, name, path)).toContain(tag)),
  };
}
