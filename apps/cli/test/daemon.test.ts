// The daemon needs bun:ffi and bun:sqlite, so its cases run in the pinned Bun (test/bun.ts) on the real
// filesystem, once, and each case is reported here.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

type CaseResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

// The Bun pinned in package.json, not whatever is on PATH, so CI and laptops run the same engine.
const BUN = createRequire(import.meta.url).resolve("bun/bin/bun.exe");

// A case that hangs (a save that never arrives) fails the whole run instead of holding CI forever.
const results: Record<string, CaseResult> = JSON.parse(
  execFileSync(BUN, [join(import.meta.dirname, "bun.ts")], { encoding: "utf8", timeout: 120_000 }),
);

describe(`daemon on a real filesystem (${process.platform})`, () => {
  it.each(Object.keys(results))("%s", (name) => expect(results[name]).toEqual({ ok: true }));
});
