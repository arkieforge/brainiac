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

/**
 * A sync client on its own socket, with a way to wait for a message it has handled. `?as=<actor>` speaks for
 * that actor, like `connection:<id>` (harness.ts).
 */
async function device(name: string, query = "") {
  const response = await mf.dispatchFetch(`http://brainiac.test/sync${query}`, {
    headers: { upgrade: "websocket" },
  });
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
  /** Every message the socket was sent, as sent. */
  const received: string[] = [];
  ws.addEventListener("message", (event) => {
    received.push(String(event.data));
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
  return { client, ws, next, received };
}

/** The record every socket here reaches. */
async function record() {
  const namespace = await mf.getDurableObjectNamespace("BASE");
  // The stub's RPC methods are the DO's own; Miniflare's types describe only fetch.
  return namespace.get(namespace.idFromName("sync")) as unknown as DurableObjectStub<TestBase>;
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
    const base = await record();
    await base.mutate(
      { op: "patch", noteId: ID, baseRev: 2, ops: [{ op: "set", path: ["kind"], value: "job" }] },
      {
        actor: "connection:agent",
      },
    );
    await seen;
    expect(tab.client.working(ID)).toContain("kind: job");
  });

  it("refuses a socket for a connection the record doesn't have", async () => {
    const response = await mf.dispatchFetch("http://brainiac.test/sync?as=connection:nobody", {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(401);
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

  it("never sends a sensitive note to a socket without the scope, and takes back one that turns sensitive", async () => {
    const base = await record();
    // A new connection starts at the floor: no sensitive scope.
    const { id } = await base.addConnection({ kind: "cli" });
    const as = `?as=connection:${id}`;
    const agent = await device("agent", as);
    const tab = await device("person");
    for (const d of [agent, tab]) {
      const synced = d.next((m) => m.type === "snapshot");
      d.client.connect();
      await synced;
    }
    expect(agent.client.state.remote.has(ID)).toBe(true);

    // A new sensitive note reaches the person's tab; the agent's socket hears only that it isn't there.
    const SCORE = "01M6ADBH80DEGPEVAAVR2625V1";
    const IELTS = "facts/tests/ielts-2026-11.md";
    // Unverified, so it lands without a passkey signature (approvals.test.ts covers those).
    const score = readFileSync(join(import.meta.dirname, "../../../fixtures/nadia", IELTS), "utf8")
      .replace("26GB001234KARN001A", "CANARY-TRF-7Q3X")
      .replace(/^verified:.*\n/m, "");
    const toAgent = agent.next((m) => m.type === "changes");
    const toTab = tab.next((m) => m.type === "changes");
    await base.mutate({ op: "create", path: IELTS, raw: score, class: "sensitive" }, { actor: "human" });
    expect(await toAgent).toMatchObject({ items: [{ noteId: SCORE, deleted: true }] });
    await toTab;
    expect(tab.client.state.remote.get(SCORE)?.raw).toContain("CANARY-TRF-7Q3X");

    // The application turns sensitive: the agent's copy is dropped, the person's keeps it with its new class.
    const dropped = agent.next((m) => m.type === "changes");
    const reclassed = tab.next((m) => m.type === "changes");
    const baseRev = (await base.rev(ID)) ?? 0;
    const made = await base.mutate(
      { op: "classify", noteId: ID, baseRev, class: "sensitive" },
      { actor: "human" },
    );
    expect(made).toMatchObject({ status: "applied" });
    await Promise.all([dropped, reclassed]);
    expect(agent.client.state.remote.has(ID)).toBe(false);
    expect(tab.client.state.remote.get(ID)?.class).toBe("sensitive");

    // Nor does a snapshot bring either back.
    const later = await device("agent-later", as);
    const synced = later.next((m) => m.type === "snapshot");
    later.client.connect();
    await synced;
    expect([...later.client.state.remote.keys()]).toEqual([]);
    for (const text of [...agent.received, ...later.received]) {
      expect(text).not.toContain("CANARY");
      expect(text).not.toContain(IELTS);
    }

    // Its grants change: its open sockets close, so their clients say hello again under what it may read now.
    const closedBy = (d: Awaited<ReturnType<typeof device>>) =>
      new Promise<number>((resolve) => d.ws.addEventListener("close", (e) => resolve(e.code)));
    const resynced = [agent, later].map(closedBy);
    expect(await base.restrict(id, { holdDays: 10 })).toHaveProperty("connection");
    expect(await Promise.all(resynced)).toEqual([4002, 4002]);
    // Disconnected: its open socket closes at once, and it can't open another.
    const back = await device("agent-back", as);
    const welcomed = back.next((m) => m.type === "snapshot");
    back.client.connect();
    await welcomed;
    const closed = closedBy(back);
    await base.disconnect(id);
    expect(await closed).toBe(4001);
    const again = await mf.dispatchFetch(`http://brainiac.test/sync${as}`, {
      headers: { upgrade: "websocket" },
    });
    expect(again.status).toBe(401);
  });
});
