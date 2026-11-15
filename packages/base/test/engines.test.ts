import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import { cases, type CaseResult } from "./cases.ts";
import { fixtures } from "./fixtures.ts";
import { QUESTIONS, type Answers } from "./parity.ts";

const names = Object.keys(cases);

// The Bun pinned in package.json, not whatever is on PATH, so CI and laptops run the same engine.
const BUN = createRequire(import.meta.url).resolve("bun/bin/bun.exe");

// One Bun process runs every case, and each test waits only for its own case's line, not the whole run:
// a single hook waiting for all of them went past its timeout on loaded CI runners (#127).
const settled = <T>() => {
  const deferred = Promise.withResolvers<T>();
  // A test filtered out with -t never awaits its case; if Bun dies, that rejection isn't an error.
  deferred.promise.catch(() => {});
  return deferred;
};
const results = new Map(names.map((name) => [name, settled<CaseResult>()]));
const parity = settled<Answers>();

const bun = spawn(BUN, [join(import.meta.dirname, "bun.ts")], { stdio: ["ignore", "pipe", "inherit"] });
createInterface({ input: bun.stdout }).on("line", (text) => {
  const line: { name: string; result: CaseResult } | { parity: Answers } = JSON.parse(text);
  if ("parity" in line) parity.resolve(line.parity);
  else results.get(line.name)?.resolve(line.result);
});
bun.on("close", (code, signal) => {
  // Settled cases ignore this; the rest fail now instead of at their timeout.
  const error = new Error(`bun.ts exited (${signal ?? code}) before this case printed its result`);
  for (const deferred of [...results.values(), parity]) deferred.reject(error);
});
afterAll(() => bun.kill());

describe("bun:sqlite", () => {
  it.each(names)("%s", async (name) => expect(await results.get(name)?.promise).toEqual({ ok: true }));
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
    const local = await parity.promise;
    expect(cloud).toEqual(local);
    // Not vacuous: the person finds every question, keyword-only and with vectors, some hits have graph
    // neighbors, and the agent sees fewer notes and never the canary.
    const { person, agent, hybrid } = local;
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
