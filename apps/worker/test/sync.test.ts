// Sync clients talking to the real Base DO over WebSockets in workerd (harness.ts forwards /sync).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ServerMessage } from "@brainiac/core";
import { emptyState, SyncClient } from "@brainiac/sync";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import type { TestBase } from "./harness.ts";

const TUM = "applications/tum-msc-informatics-2027/application.md";
const raw = readFileSync(join(import.meta.dirname, "../../../fixtures/nadia", TUM), "utf8");
const ID = "01M6AM78G0STS7TB29G7A10DCY";

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

/** A sync client on its own socket, with a way to wait for a message it has handled. */
async function device(name: string) {
  const response = await mf.dispatchFetch("http://brainiac.test/sync", { headers: { upgrade: "websocket" } });
  const ws = response.webSocket;
  if (!ws) throw new Error(`no socket: ${response.status}`);
  ws.accept();
  const waiting: [(m: ServerMessage) => boolean, (m: ServerMessage) => void][] = [];
  const client = new SyncClient(emptyState(name), {
    send: (message) => ws.send(JSON.stringify(message)),
    newClientId: () => `${name}-repaired`,
    schemaVersion: 3,
    appVersion: "test",
  });
  ws.addEventListener("message", (event) => {
    const message: ServerMessage = JSON.parse(String(event.data));
    client.receive(message);
    for (const [i, [matches, resolve]] of waiting.entries()) {
      if (matches(message)) {
        waiting.splice(i, 1);
        resolve(message);
      }
    }
  });
  /** Resolves with the next message matching `matches`. Call it before the action that causes it. */
  const next = (matches: (m: ServerMessage) => boolean) =>
    new Promise<ServerMessage>((resolve) => waiting.push([matches, resolve]));
  return { client, ws, next };
}

describe("sync over the Base DO's sockets", () => {
  it("pushes one device's changes to the other, live", async () => {
    const laptop = await device("laptop");
    const phone = await device("phone");
    for (const d of [laptop, phone]) {
      const synced = d.next((m) => m.type === "snapshot");
      d.client.connect();
      await synced;
    }

    const seen = phone.next((m) => m.type === "changes");
    const done = laptop.next((m) => m.type === "result");
    laptop.client.create(ID, TUM, raw, "normal");
    expect(await done).toMatchObject({ ok: true, rev: 1 });
    await seen;
    expect(phone.client.state.remote.get(ID)?.raw).toBe(raw);

    // The phone edits; the laptop sees it.
    const back = laptop.next((m) => m.type === "changes" && JSON.stringify(m.items).includes("submitted"));
    phone.client.edit(ID, raw.replace("status: preparing", "status: submitted"));
    await back;
    expect(laptop.client.working(ID)).toContain("status: submitted");
  });

  it("pushes a change made through the DO's own mutate to open sockets", async () => {
    const tab = await device("tab");
    const synced = tab.next((m) => m.type === "snapshot");
    tab.client.connect();
    await synced;
    const seen = tab.next((m) => m.type === "changes" && JSON.stringify(m.items).includes("kind: job"));
    const namespace = await mf.getDurableObjectNamespace("BASE");
    const base = namespace.get(namespace.idFromName("sync")) as unknown as DurableObjectStub<TestBase>;
    await base.mutate(
      { op: "patch", noteId: ID, baseRev: 2, ops: [{ op: "set", path: ["kind"], value: "job" }] },
      {
        actor: "connection:agent",
      },
    );
    await seen;
    expect(tab.client.working(ID)).toContain("kind: job");
  });

  it("refuses a mutate before hello, and a message that isn't one", async () => {
    const stranger = await device("stranger");
    const refused = stranger.next((m) => m.type === "error");
    stranger.ws.send(
      JSON.stringify({
        type: "mutate",
        clientId: "x",
        clientSeq: 1,
        changeId: "c1",
        ackedUpTo: 0,
        noteId: ID,
        baseRev: 0,
        change: { kind: "delete", base: "" },
      }),
    );
    expect(await refused).toEqual({ type: "error", message: "Say hello first." });
    const garbled = stranger.next((m) => m.type === "error");
    stranger.ws.send("{");
    expect(await garbled).toEqual({ type: "error", message: "Not JSON." });
  });
});
