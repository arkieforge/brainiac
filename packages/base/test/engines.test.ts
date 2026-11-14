import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import { cases, type CaseResult } from "./cases.ts";
import { fixtures } from "./fixtures.ts";

const names = Object.keys(cases);

// The Bun pinned in package.json, not whatever is on PATH, so CI and laptops run the same engine.
const BUN = createRequire(import.meta.url).resolve("bun/bin/bun.exe");

describe("bun:sqlite", () => {
  let results: Record<string, CaseResult>;
  beforeAll(() => {
    results = JSON.parse(execFileSync(BUN, [join(import.meta.dirname, "bun.ts")], { encoding: "utf8" }));
  });

  it.each(names)("%s", (name) => expect(results[name]).toEqual({ ok: true }));
});

describe("Durable Object SQLite (workerd)", () => {
  let mf: Miniflare;
  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: await bundleWorker(join(import.meta.dirname, "workerd.ts")),
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: { RUNNER: { className: "CaseRunner", useSQLite: true } },
    });
  });
  afterAll(() => mf.dispose());

  it.each(names)("%s", async (name) => {
    const runners = await mf.getDurableObjectNamespace("RUNNER");
    const response = await runners
      .get(runners.idFromName(name))
      .fetch("http://runner/", { method: "POST", body: JSON.stringify({ name, fixtures }) });
    expect(await response.json()).toEqual({ ok: true });
  });
});
