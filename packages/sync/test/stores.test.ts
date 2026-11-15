// @vitest-environment happy-dom
// The same client cases in a browser (IndexedDB) and in Bun (state.db): see cases.ts.
import "fake-indexeddb/auto";

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { locks } from "node:worker_threads";

import { beforeAll, describe, expect, it } from "vite-plus/test";

import { indexedDbStore, openTabStore } from "../src/browser.ts";
import { cases, runCase, type CaseResult } from "./cases.ts";
import { addLine, World } from "./sim.ts";

const names = Object.keys(cases);

describe("browser: IndexedDB", () => {
  it.each(names)("%s", async (name) => {
    expect(await runCase(name, (device) => indexedDbStore(`${name}/${device}`))).toEqual({ ok: true });
  });

  // happy-dom has no Web Locks; Node's is the same API.
  it("a closed tab's slot, pending edits and all, goes to the next tab that opens", async () => {
    const world = new World();
    world.seed("01M6AAAAAAAAAAAAAAAAAAAAA1", "notes/a.md");
    const first = await openTabStore("tabs", locks);
    const second = await openTabStore("tabs", locks);
    const tab = world.device("tab", undefined, first.store);
    world.settle();
    world.disconnect(tab);
    addLine(tab, "01M6AAAAAAAAAAAAAAAAAAAAA1", "unsent");
    await tab.client.saved();
    expect(await second.store.load()).toBeUndefined(); // another tab never shares the slot
    await first.release(); // the tab closes

    const third = await openTabStore("tabs", locks);
    const reopened = await world.restart(tab, third.store);
    expect(reopened.client.state.clientId).toBe(tab.client.state.clientId);
    world.settle();
    expect(world.note("01M6AAAAAAAAAAAAAAAAAAAAA1")?.raw).toContain("unsent\n");
    await Promise.all([second.release(), third.release()]);
  });

  it("a released slot leaves its database free to delete, as sign-out does", async () => {
    const tab = await openTabStore("signout", locks);
    await tab.store.write({
      saved: {
        clientId: "t",
        lastAssigned: 0,
        ackedUpTo: 0,
        cursor: 1,
        answered: [],
        pending: [],
        blocked: [],
      },
      clear: false,
      remote: [],
    });
    await tab.release();
    const deleted = indexedDB.deleteDatabase("signout:0");
    const outcome = await new Promise<string>((resolve) => {
      deleted.addEventListener("success", () => resolve("deleted"));
      deleted.addEventListener("blocked", () => resolve("blocked by an open connection"));
    });
    expect(outcome).toBe("deleted");
  });
});

// The Bun pinned in package.json, not whatever is on PATH, so CI and laptops run the same engine.
const BUN = createRequire(import.meta.url).resolve("bun/bin/bun.exe");

describe("Bun: state.db", () => {
  let results: Record<string, CaseResult>;
  beforeAll(() => {
    results = JSON.parse(execFileSync(BUN, [join(import.meta.dirname, "bun.ts")], { encoding: "utf8" }));
  });

  it.each(names)("%s", (name) => expect(results[name]).toEqual({ ok: true }));
});
