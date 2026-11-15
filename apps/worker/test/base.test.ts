// The Base DO in workerd, with a real jobs queue and the real consumer (harness.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import type { TestBase } from "./harness.ts";

const FIXTURES = join(import.meta.dirname, "../../../fixtures/nadia");
const TUM = "applications/tum-msc-informatics-2027/application.md";
const raw = readFileSync(join(FIXTURES, TUM), "utf8");
const human = { actor: "human" };
/** Reads as a connection without the sensitive scope. */
const agent = { sensitive: false };

let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: await bundleWorker(join(import.meta.dirname, "harness.ts")),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { BASE: { className: "TestBase", useSQLite: true } },
    queueProducers: { JOBS: { queueName: "jobs" } },
    queueConsumers: { jobs: { maxBatchTimeout: 0 } },
  });
});
afterAll(() => mf.dispose());

/** A fresh record per test, and a way to reach it again after a crash. */
async function record(name: string) {
  const namespace = await mf.getDurableObjectNamespace("BASE");
  const id = namespace.idFromName(name);
  // The stub's RPC methods are the DO's own; Miniflare's types describe only fetch.
  return () => namespace.get(id) as unknown as DurableObjectStub<TestBase>;
}

async function create(base: DurableObjectStub<TestBase>) {
  const result = await base.mutate({ op: "create", path: TUM, raw, class: "normal" }, human);
  if (result.status !== "applied") throw new Error(JSON.stringify(result));
  return result;
}

describe("Base DO", () => {
  it("dispatches a job committed before a crash, once it is back", async () => {
    const base = await record("crash");
    // The commit arms the alarm, which the runtime keeps across a crash.
    const armed = base().nextAlarm();
    const { noteId } = await create(base());
    await armed;
    // The process dies after the commit, before any dispatch.
    await expect(base().crash()).rejects.toThrow();

    const fresh = base();
    expect((await fresh.jobs()).map((job) => [job.rev, job.status])).toEqual([[1, "pending"]]);
    const installed = fresh.nextInstall();
    await fresh.dispatch();
    // Through the real queue and consumer, back into the record.
    expect(await installed).toBe("installed");
    expect(await fresh.find(agent, "okafor")).toEqual([noteId]);
    expect(await fresh.jobs()).toEqual([]);
  });

  // A job already in flight when the note moves on is covered in packages/base (both engines).
  it("a newer edit replaces an undispatched job, and the old result never installs", async () => {
    const base = (await record("stale"))();
    const { noteId } = await create(base);
    const [job] = await base.jobs();
    if (!job) throw new Error("no job");
    const old = await base.jobInput(job.id);
    expect(old?.kind === "index" && old.note.rev).toBe(1);

    await base.mutate(
      {
        op: "patch",
        noteId,
        baseRev: 1,
        ops: [{ op: "section", heading: "Plan", content: "Email the TUM office.\n" }],
      },
      human,
    );
    // The old result lands after the newer edit: dropped, so search never shows text from rev 1.
    const stale = { family: "normal", header: "[Application]", text: "Ask Dr Okafor" } as const;
    expect(await base.installIndex(job.id, [stale])).toBe("dropped");
    expect(await base.find(agent, "okafor")).toEqual([]);

    const installed = base.nextInstall();
    await base.dispatch();
    expect(await installed).toBe("installed");
    expect(await base.find(agent, "email")).toEqual([noteId]);
    expect(await base.find(agent, "okafor")).toEqual([]);
  });

  it("undoes a run through the DO", async () => {
    const base = (await record("undo"))();
    const { noteId } = await create(base);
    const run = { actor: "connection:agent", runId: "01M6RUN0000000000000000001" };
    await base.mutate(
      { op: "patch", noteId, baseRev: 1, ops: [{ op: "set", path: ["status"], value: "submitted" }] },
      run,
    );
    const result = await base.undoRun(run.runId, human);
    expect(result).toMatchObject({ undone: [noteId], conflicts: [] });
    expect(await base.rev(noteId)).toBe(3);
  });
});
