// Sync clients talking to the real Base DO over WebSockets in workerd, through the real /sync, /cli/login and
// /cli/logout routes (harness.ts fakes only the session and the registry).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { tokenBase } from "@brainiac/base";
import type { ServerMessage } from "@brainiac/core";
import { emptyState, SyncClient } from "@brainiac/sync";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import { createAuthenticator } from "../src/auth/test-authenticator.ts";
import type { TestBase } from "./harness.ts";

const FIXTURES = join(import.meta.dirname, "../../../fixtures/nadia");
const ROLE = "facts/roles/acme-intern-2025.md";
const TUM = "applications/tum-msc-informatics-2027/application.md";
const raw = readFileSync(join(import.meta.dirname, "../../../fixtures/nadia", TUM), "utf8");
const ID = "01M6AM78G0STS7TB29G7A10DCY";
const IELTS = "facts/tests/ielts-2026-11.md";
const ielts = readFileSync(join(FIXTURES, IELTS), "utf8");

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

const ORIGIN = "http://brainiac.test";
/** A tab signed in as the person whose record is `user` (harness.ts fakes the session and registry, nothing else). */
const session = (user = "sync") => ({ cookie: `user=${user}`, origin: ORIGIN });
/** A laptop with a CLI token. */
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Asks `/sync` for a socket, as the real route sees it. */
const upgrade = (headers: Record<string, string>) =>
  mf.dispatchFetch(`${ORIGIN}/sync`, { headers: { upgrade: "websocket", ...headers } });

/**
 * A sync client on its own socket, with a way to wait for a message it has handled. `auth` is a session (`session`)
 * or a CLI token (`bearer`). `state` is what an app restarting loads from its store.
 */
async function device(name: string, auth: Record<string, string> = session(), state = emptyState(name)) {
  const response = await upgrade(auth);
  const ws = response.webSocket;
  if (!ws) throw new Error(`no socket: ${response.status}`);
  ws.accept();
  const waiting: [(m: ServerMessage) => boolean, (m: ServerMessage) => void][] = [];
  const client = new SyncClient(state, {
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

/** The record of the person `user`; most sockets here reach the one of "sync". */
async function record(user = "sync") {
  const namespace = await mf.getDurableObjectNamespace("BASE");
  // The stub's RPC methods are the DO's own; Miniflare's types describe only fetch.
  return namespace.get(namespace.idFromName(user)) as unknown as DurableObjectStub<TestBase>;
}

/** A new CLI connection on `base` at `level` (only tightening, which needs no passkey) and its token. */
async function cliToken(base: DurableObjectStub<TestBase>, level: "read" | "propose" = "propose") {
  const { id } = await base.addConnection({ kind: "cli" });
  if (level === "read") await base.restrict(id, { level });
  return { id, token: await base.mintToken(id) };
}

const socketClosed = ({ ws }: Awaited<ReturnType<typeof device>>) =>
  new Promise((resolve) => ws.addEventListener("close", resolve));
const closeCode = ({ ws }: Awaited<ReturnType<typeof device>>) =>
  new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)));
const set = (text: string, field: string, value: string) =>
  text.replace(/^---\n/, `---\n${field}: ${value}\n`);

async function online(name: string, auth: Record<string, string> = session()) {
  const laptop = await device(name, auth);
  const synced = laptop.next((m) => m.type === "snapshot");
  laptop.client.connect();
  await synced;
  return laptop;
}

/** The app starts again from the state it stored, on a new socket, and resends what has no answer. */
async function restart(name: string, state: ReturnType<typeof emptyState>) {
  const again = await device(name, session(), structuredClone(state));
  const last = state.pending.at(-1)?.clientSeq;
  const settled = again.next((m) => m.type === "result" && m.clientSeq === last);
  again.client.connect();
  await settled;
  return again;
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
    const { id, token } = await cliToken(base);
    const as = bearer(token);
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
    expect((await upgrade(as)).status).toBe(401);
  });

  describe("a record killed mid-write", () => {
    it("loses nothing and applies nothing twice when it dies in the middle of a burst", async () => {
      const laptop = await online("killed-laptop");
      const before = (await (await record()).rev(ID)) ?? 0;
      // Two edits are answered, the process dies handling the third, and the last two never arrive.
      await (await record()).dieHandling(3);
      const gone = socketClosed(laptop);
      const fields = ["a1", "a2", "a3", "a4", "a5"];
      for (const field of fields) laptop.client.edit(ID, set(laptop.client.working(ID) ?? "", field, "x"));
      await gone;
      // Whether the third's write outlived the process is the runtime's call (an output gate holds a reply
      // until its write is durable); the device never heard, so it resends it either way.
      expect(laptop.client.state.pending.map((p) => p.clientSeq)).toEqual([3, 4, 5]);

      const again = await restart("killed-laptop", laptop.client.state);
      expect(again.client.state.pending).toEqual([]);
      expect(await (await record()).rev(ID)).toBe(before + fields.length);
      for (const field of fields) expect(again.client.working(ID)).toContain(`${field}: x`);
    });
  });
});

const idOf = async (user: string) => (await mf.getDurableObjectNamespace("BASE")).idFromName(user).toString();
const opens = async (headers: Record<string, string>) => {
  const response = await upgrade(headers);
  response.webSocket?.accept();
  response.webSocket?.close();
  return response.status;
};

describe("reaching a record: /sync, brainiac login and logout", () => {
  it("a token opens a socket only on its own record, and nothing else opens one", async () => {
    const { token } = await cliToken(await record("tenant-a"));
    await cliToken(await record("tenant-b"));
    expect(await opens(bearer(token))).toBe(101);
    // Cross-tenant: A's secret under B's id is routed to B, which has no such token.
    // The secret is base64url, so it may hold `_` itself: cut after the id, not at the last underscore.
    const secret = token.slice(`brn_${await idOf("tenant-a")}_`.length);
    expect(await opens(bearer(`brn_${await idOf("tenant-b")}_${secret}`))).toBe(401);
    // Ids that name no record of this namespace, and things that aren't tokens at all.
    for (const other of [`brn_${"0".repeat(64)}_${secret}`, `brn_ab_${secret}`, "brainiac"])
      expect(await opens(bearer(other)), other).toBe(401);
    // Nobody signed in; a signed-in browser on another origin of the site; a client naming its own actor.
    expect(await opens({})).toBe(401);
    expect(await opens({ ...session(), origin: "http://usercontent.brainiac.test" })).toBe(403);
    expect(await opens({ "x-brainiac-actor": "human" })).toBe(401);
  });

  it("a read connection's edits are refused once each, even when its client claims to be the person", async () => {
    const base = await record("levels-read");
    await base.mutate({ op: "create", path: TUM, raw, class: "normal" }, { actor: "human" });
    const { token } = await cliToken(base, "read");
    const laptop = await online("read-laptop", { ...bearer(token), "x-brainiac-actor": "human" });
    expect(laptop.client.state.remote.has(ID)).toBe(true);

    const answered = laptop.next((m) => m.type === "result");
    laptop.client.edit(ID, set(laptop.client.working(ID) ?? "", "r1", "x"));
    expect(await answered).toMatchObject({ ok: false, error: "This connection can only read." });
    // Answered, so never resent: the edit waits as blocked with the reason, and the record is unchanged.
    expect(laptop.client.state.pending).toEqual([]);
    expect(laptop.client.state.blocked.get(ID)?.map((b) => b.reason)).toEqual([
      "This connection can only read.",
    ]);
    expect(await base.rev(ID)).toBe(1);
  });

  it("a propose connection's file edit lands at once, even on a held type, as an unattributed edit", async () => {
    const base = await record("levels-propose");
    await base.setManifest(readFileSync(join(FIXTURES, "okf-base.yaml"), "utf8"));
    const role = await base.mutate(
      { op: "create", path: ROLE, raw: readFileSync(join(FIXTURES, ROLE), "utf8"), class: "normal" },
      { actor: "human" },
    );
    if (role.status !== "applied") throw new Error(JSON.stringify(role));
    const { token } = await cliToken(base);
    const laptop = await online("propose-laptop", bearer(token));

    const answered = laptop.next((m) => m.type === "result");
    laptop.client.edit(
      role.noteId,
      (laptop.client.working(role.noteId) ?? "").replace(/^end: .*$/m, "end: 2025-10-31"),
    );
    // Through Brainiac's tools a propose connection's every change waits for the person (connections.test.ts).
    expect(await answered).toMatchObject({ ok: true, rev: 2 });
    expect(await base.rev(role.noteId)).toBe(2);
  });

  it("brainiac login: the signed-in person confirms, and the token reaches only the CLI on this machine", async () => {
    const state = "s".repeat(32);
    const query = `?port=49152&state=${state}&device=Ada%27s%20laptop`;
    const login = (
      search: string,
      init: { method?: string; body?: string; headers?: Record<string, string> } = {},
    ) => mf.dispatchFetch(`${ORIGIN}/cli/login${search}`, { redirect: "manual", ...init });

    // Nobody signed in: off to sign in, and back here after.
    const away = await login(query);
    expect(away.status).toBe(303);
    expect(new URL(away.headers.get("location") ?? "").searchParams.get("next")).toBe(`/cli/login${query}`);
    // Not a link brainiac login made: a privileged or impossible port, a missing or short state.
    const bad = [`?port=80&state=${state}`, `?port=70000&state=${state}`, `?port=4915.2&state=${state}`];
    for (const search of [...bad, "?port=49152&state=short", "?port=49152"])
      expect((await login(search, { headers: session("login") })).status, search).toBe(400);

    const page = await login(query, { headers: session("login") });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Ada&#39;s laptop");

    // The confirm is a POST from the site's own page; from anywhere else, it makes nothing.
    const form = new URLSearchParams({ port: "49152", state, device: "Ada's laptop" });
    const confirm = (headers: Record<string, string>) =>
      login(query, {
        method: "POST",
        body: form.toString(),
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      });
    expect((await confirm({ cookie: "user=login", origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await confirm({ cookie: "user=login" })).status).toBe(403);
    expect((await confirm({ origin: ORIGIN })).status).toBe(401);

    const done = await confirm(session("login"));
    expect(done.status).toBe(200);
    const html = await done.text();
    expect(html).toContain('action="http://127.0.0.1:49152/callback"');
    expect(html).toContain(`name="state" value="${state}"`);
    const token = /name="token" value="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(tokenBase(token)).toBe(await idOf("login"));
    expect(await (await record("login")).authenticate(token)).toMatchObject({
      kind: "cli",
      level: "propose",
      sensitive: false,
    });
    await online("logged-in", bearer(token));
  });

  it("brainiac logout ends its connection: its open socket closes, and the token works nowhere", async () => {
    const base = await record("logout");
    const { token } = await cliToken(base);
    const laptop = await online("leaving", bearer(token));
    const closed = closeCode(laptop);
    const logout = () => mf.dispatchFetch(`${ORIGIN}/cli/logout`, { method: "POST", headers: bearer(token) });

    expect((await logout()).status).toBe(204);
    expect(await closed).toBe(4001);
    expect(await base.authenticate(token)).toBeNull();
    expect(await opens(bearer(token))).toBe(401);
    expect((await logout()).status).toBe(401);
  });
});

/**
 * The site's approval route as a tab of `user` posts to it, with the passkey Neon holds for them riding in the
 * fake session (harness.ts): `sign` is that passkey answering a challenge.
 */
function approver(user: string) {
  const authenticator = createAuthenticator(ORIGIN);
  const neon = {
    credentialId: authenticator.id,
    publicKey: authenticator.publicKey,
    counter: 0,
    approvesAt: new Date(0).toISOString(),
    origin: ORIGIN,
  };
  const approve = (items: unknown, response: unknown, extra = {}) =>
    mf.dispatchFetch(`${ORIGIN}/api/approve`, {
      method: "POST",
      headers: {
        ...session(user),
        "content-type": "application/json",
        "x-test-passkey": JSON.stringify(neon),
      },
      body: JSON.stringify({ items, response, ...extra }),
    });
  return { approve, sign: (challenge: string) => authenticator.authenticate({ challenge }) };
}

describe("approving a blocked edit on the site", () => {
  it("lands the edit the plan shows, once, resent under a new clientSeq and changeId", async () => {
    const base = await record("approve");
    const [id = ""] = await base.seed([{ path: IELTS, raw: ielts, class: "normal" }]);
    const tab = await online("approve-tab", session("approve"));
    const refused = tab.next((m) => m.type === "result");
    tab.client.edit(id, ielts.replace("overall: 8.0", "overall: 8.5"));
    const first = await refused;
    // Blocked with the plan to sign: the verified score, before and after.
    const plan = tab.client.state.blocked.get(id)?.at(-1)?.needsApproval;
    if (!plan || first.type !== "result") throw new Error("not blocked for approval");
    expect(plan.items.map((item) => item.patch.fields["overall"])).toEqual([{ before: 8, after: 8.5 }]);
    expect(await base.rev(id)).toBe(1);

    const { approve, sign } = approver("approve");
    const response = sign(plan.planHash);
    // The items sent are the ones the record hashes: a signature over the plan shown approves no other plan.
    const tampered = structuredClone(plan.items).map((item) => ({
      ...item,
      patch: { ...item.patch, fields: { overall: { before: 8, after: 9 } } },
    }));
    expect((await approve(tampered, response)).status).toBe(403);
    const approved = await approve(plan.items, sign(plan.planHash));
    const { approvalId } = (await approved.json()) as { approvalId: string };
    expect(approved.status).toBe(200);

    const landed = tab.next((m) => m.type === "result" && m.ok);
    expect(tab.client.approved(id, plan.planHash, approvalId)).toBe(true);
    const resent = tab.client.state.pending.at(-1);
    expect(resent?.clientSeq).toBeGreaterThan(first.clientSeq);
    expect(resent?.changeId).not.toBe(first.changeId);
    expect(resent?.approvalId).toBe(approvalId);
    const result = await landed;
    expect(result).toMatchObject({ ok: true, rev: 2 });
    expect(tab.client.state.blocked.get(id)).toBeUndefined();
    expect(await base.rev(id)).toBe(2);

    // Used up: the same signature can't approve the plan again, or anything else.
    expect((await approve(plan.items, response)).status).toBe(403);
    expect((await approve(plan.items, sign(plan.planHash))).status).toBe(403);
  });

  it("takes only a signature from one of the person's own passkeys, over this plan", async () => {
    const base = await record("approve-own");
    const [id = ""] = await base.seed([{ path: IELTS, raw: ielts, class: "normal" }]);
    const tab = await online("approve-own-tab", session("approve-own"));
    const refused = tab.next((m) => m.type === "result");
    tab.client.edit(id, ielts.replace("overall: 8.0", "overall: 6.0"));
    await refused;
    const plan = tab.client.state.blocked.get(id)?.at(-1)?.needsApproval;
    if (!plan) throw new Error("not blocked for approval");
    const own = approver("approve-own");
    // A passkey Neon doesn't hold for this person, even with a body naming its key: the approver is Neon's.
    const stranger = createAuthenticator(ORIGIN);
    const named = {
      approver: { credentialId: stranger.id, publicKey: stranger.publicKey, counter: 0, origin: ORIGIN },
    };
    expect(
      (await own.approve(plan.items, stranger.authenticate({ challenge: plan.planHash }), named)).status,
    ).toBe(403);
    // Their own passkey signing something else.
    expect((await own.approve(plan.items, own.sign("c29tZXRoaW5nIGVsc2U"))).status).toBe(403);
    // Another person approving the same plan in their own record approves nothing here.
    const other = approver("approve-other");
    const elsewhere = await other.approve(plan.items, other.sign(plan.planHash));
    const { approvalId } = (await elsewhere.json()) as { approvalId: string };
    const again = tab.next((m) => m.type === "result");
    tab.client.approved(id, plan.planHash, approvalId);
    expect(await again).toMatchObject({ ok: false, needsApproval: { planHash: plan.planHash } });
    expect(await base.rev(id)).toBe(1);
    expect((await own.approve([], own.sign(plan.planHash))).status).toBe(400);
  });
});
