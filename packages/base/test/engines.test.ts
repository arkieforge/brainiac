import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import { cases, type CaseResult } from "./cases.ts";
import { fixtures } from "./fixtures.ts";
import { QUESTIONS, type Answers } from "./parity.ts";

const names = Object.keys(cases);

// The Bun pinned in package.json, not whatever is on PATH, so CI and laptops run the same engine.
const BUN = createRequire(import.meta.url).resolve("bun/bin/bun.exe");

let local: { results: Record<string, CaseResult>; parity: Answers };
beforeAll(() => {
  local = JSON.parse(execFileSync(BUN, [join(import.meta.dirname, "bun.ts")], { encoding: "utf8" }));
});

describe("bun:sqlite", () => {
  it.each(names)("%s", (name) => expect(local.results[name]).toEqual({ ok: true }));
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

  async function run(name: string): Promise<unknown> {
    const runners = await mf.getDurableObjectNamespace("RUNNER");
    const response = await runners
      .get(runners.idFromName(name))
      .fetch("http://runner/", { method: "POST", body: JSON.stringify({ name, fixtures }) });
    return response.json();
  }

  it.each(names)("%s", async (name) => expect(await run(name)).toEqual({ ok: true }));

  it("parity: the fixture record answers every question exactly as the local copy does", async () => {
    const cloud = await run("parity");
    expect(cloud).toEqual(local.parity);
    // Not vacuous: the person finds every question, keyword-only and with vectors, some hits have graph
    // neighbors, and the agent sees fewer notes and never the canary.
    const { person, agent, hybrid } = local.parity;
    for (const q of QUESTIONS) {
      expect(person.search[q]?.mode, q).toBe("keyword");
      expect(person.search[q]?.hits, q).not.toEqual([]);
      expect(hybrid.person[q]?.mode, q).toBe("hybrid");
    }
    expect(QUESTIONS.some((q) => person.search[q]?.neighbors.length)).toBe(true);
    expect(agent.notes.length).toBeLessThan(person.notes.length);
    expect(agent.search["CANARY-BODY-7Q3X"]?.hits).toEqual([]);
    const answered = [
      agent.notes,
      agent.feed,
      ...Object.values(agent.search),
      ...Object.values(hybrid.agent),
    ];
    expect(JSON.stringify(answered)).not.toMatch(/CANARY/);
  });
});
