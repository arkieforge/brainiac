// Connections through the real Base DO in workerd: the canary (a new connection sees no sensitive note until
// the person's passkey grants the scope), grants signed by a software passkey, the hold and who decides.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  grantHash,
  type Answer,
  type Connection,
  type Forbidden,
  type GrantPlan,
  type MutationResult,
  type Results,
} from "@brainiac/base";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import type { Approver } from "../src/approvals.ts";
import { accountPage } from "../src/auth/pages.ts";
import { createAuthenticator } from "../src/auth/test-authenticator.ts";
import type { TestBase } from "./harness.ts";

const ORIGIN = "https://brainiac.test";
const FIXTURES = join(import.meta.dirname, "../../../fixtures/nadia");
const fixture = (path: string) => readFileSync(join(FIXTURES, path), "utf8");
const IELTS = "facts/tests/ielts-2025-03.md";
const TUM = "applications/tum-msc-informatics-2027/application.md";
const ROLE = "facts/roles/acme-intern-2025.md";
const human = { actor: "human" };

/** What a search found: note ids, and `<sha256>#p<page>` for a file's page. */
const found = (results: Results | Forbidden) =>
  "hits" in results
    ? results.hits.map((hit) => ("noteId" in hit ? hit.noteId : `${hit.fileSha}#p${hit.page}`))
    : results;

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

async function record(name: string) {
  const namespace = await mf.getDurableObjectNamespace("BASE");
  // The stub's RPC methods are the DO's own; Miniflare's types describe only fetch.
  return namespace.get(namespace.idFromName(name)) as unknown as DurableObjectStub<TestBase>;
}

async function created(base: DurableObjectStub<TestBase>, path: string, cls: "normal" | "sensitive") {
  const result = (await base.mutate(
    { op: "create", path, raw: fixture(path), class: cls },
    human,
  )) as MutationResult;
  if (result.status !== "applied") throw new Error(JSON.stringify(result));
  return result.noteId;
}

function passkey() {
  const authenticator = createAuthenticator(ORIGIN);
  const approver: Approver = {
    credentialId: authenticator.id,
    publicKey: authenticator.publicKey,
    counter: 0,
    approvesAt: new Date(0),
    origin: ORIGIN,
  };
  return { authenticator, approver };
}

/** The person raises a connection on the site, signing its exact grants with their passkey. */
async function raise(base: DurableObjectStub<TestBase>, connection: Connection, change: Partial<GrantPlan>) {
  const { authenticator, approver } = passkey();
  const plan: GrantPlan = { ...connection, connectionId: connection.id, ...change };
  const result = await base.grant(plan, authenticator.authenticate({ challenge: grantHash(plan) }), approver);
  if (!("connection" in result)) throw new Error(result.error);
  return result.connection;
}

describe("connections", () => {
  it("canary: a new connection sees no sensitive note until the person's passkey grants the scope", async () => {
    const base = await record("canary");
    const ielts = await created(base, IELTS, "sensitive");
    const tum = await created(base, TUM, "normal");
    const installed = base.nextInstall();
    await base.dispatch();
    await installed;
    // Both are in the index, each in its own family; the vectors rank the one without the words after it.
    expect(found(await base.search("held the score back", human))).toEqual([ielts, tum]);

    const connection = await base.addConnection({ kind: "cli" });
    const caller = { actor: "human", connectionId: connection.id };
    const seen = async () => {
      const notes = await base.notes(caller);
      if (!Array.isArray(notes)) throw new Error(JSON.stringify(notes));
      return notes.map((note) => note.id);
    };
    expect(await seen()).toEqual([tum]);
    expect(found(await base.search("held the score back", caller))).toEqual([tum]);
    expect(await base.mutate({ op: "delete", noteId: ielts, baseRev: 1 }, caller)).toEqual({
      status: "invalid",
      issues: [{ field: "noteId", message: `No note with id ${ielts}.` }],
    });

    // A signature over anything but these exact grants is refused, and changes nothing.
    const { authenticator, approver } = passkey();
    const plan: GrantPlan = { ...connection, connectionId: connection.id, sensitive: true };
    const wrong = authenticator.authenticate({ challenge: grantHash({ ...plan, level: "write" }) });
    expect(await base.grant(plan, wrong, approver)).toHaveProperty("error");
    expect(await seen()).toEqual([tum]);

    expect(
      await base.grant(plan, authenticator.authenticate({ challenge: grantHash(plan) }), approver),
    ).toHaveProperty("connection.sensitive", true);
    expect((await seen()).toSorted()).toEqual([ielts, tum].toSorted());
    expect(found(await base.search("held the score back", caller))).toEqual([ielts, tum]);
  });

  it("search embeds the question in the cloud, answers with the grants left when the model replies, and says when it is keyword-only", async () => {
    const base = await record("search-modes");
    const ielts = await created(base, IELTS, "sensitive");
    const tum = await created(base, TUM, "normal");
    const installed = base.nextInstall();
    await base.dispatch();
    await installed;
    const connection = await base.addConnection({ kind: "cli" });
    const caller = { actor: "human", connectionId: connection.id };
    const grants = { level: connection.level, holdDays: connection.holdDays };
    await base.setGrants(connection.id, { ...grants, sensitive: true });
    const hybrid = await base.search("held the score back", caller);
    expect(hybrid).toMatchObject({ mode: "hybrid", hits: [{ noteId: ielts }, { noteId: tum }] });
    expect(JSON.stringify(hybrid)).toContain("Writing held the score back.");

    // The scope is taken away while the question is with the model: the answer is the narrower one.
    await base.holdEmbedding();
    const asked = base.search("held the score back", caller);
    await base.setGrants(connection.id, { ...grants, sensitive: false });
    await base.releaseEmbedding();
    expect(found(await asked)).toEqual([tum]);

    // The MCP tools ask the same way: the question is embedded before the call, the grants read after it.
    await base.setGrants(connection.id, { ...grants, sensitive: true });
    const tool = async (name: string, args: unknown) => {
      const answer = (await base.tool({ connectionId: connection.id }, name, args)) as Answer;
      if (!answer.ok) throw new Error(answer.error);
      return answer.value as { mode: string; hits?: { id: string }[]; notes?: { id: string }[] };
    };
    const searched = await tool("search", { text: "held the score back" });
    expect([searched.mode, searched.hits?.map((hit) => hit.id)]).toEqual(["hybrid", [ielts, tum]]);
    const context = await tool("ask", { mode: "context", question: "held the score back" });
    // Each family ranks on its own, so only who is in the context matters here, not the order.
    expect([context.mode, context.notes?.map((note) => note.id).toSorted()]).toEqual([
      "hybrid",
      [ielts, tum].toSorted(),
    ]);
    await base.holdEmbedding();
    const pending = tool("ask", { mode: "context", question: "held the score back" });
    await base.setGrants(connection.id, { ...grants, sensitive: false });
    await base.releaseEmbedding();
    expect((await pending).notes?.map((note) => note.id)).toEqual([tum]);

    // An app disconnected while its question is with the model gets no answer, and no new connection.
    const app = { oauthClientId: "https://client.example/oauth/metadata.json" };
    expect(await base.tool(app, "describe", {})).toHaveProperty("ok", true);
    await base.holdEmbedding();
    const late = base.tool(app, "search", { text: "held the score back" });
    await base.disconnectApp(app.oauthClientId);
    await base.releaseEmbedding();
    expect(await late).toEqual({ ok: false, error: "This connection was disconnected." });
    expect(await base.connectionFor(app.oauthClientId)).toBeNull();

    // Workers AI fails: keyword-only, and the answer says so.
    await base.failEmbedding();
    const keyword = await base.search("held the score back", human);
    expect(keyword).toMatchObject({ mode: "keyword" });
    expect(found(keyword)).toEqual([ielts]);
  });

  it("a connection's actor and grants come from the record, and a disconnected one gets nothing", async () => {
    const base = await record("actor");
    const tum = await created(base, TUM, "normal");
    const connection = await raise(base, await base.addConnection({ kind: "cli" }), { level: "write" });
    const token = await base.mintToken(connection.id);
    expect(await base.authenticate(token)).toEqual(connection);

    const caller = { actor: "human", connectionId: connection.id };
    const edit = {
      op: "patch",
      noteId: tum,
      baseRev: 1,
      ops: [{ op: "set", path: ["status"], value: "submitted" }],
    } as const;
    expect(await base.mutate(edit, caller)).toMatchObject({ status: "applied" });
    expect(await base.actorOf(tum)).toBe(`connection:${connection.id}`);

    await base.disconnect(connection.id);
    expect(await base.authenticate(token)).toBeNull();
    expect(await base.mutate({ ...edit, baseRev: 2 }, caller)).toMatchObject({ status: "forbidden" });
    expect(await base.notes(caller)).toMatchObject({ status: "forbidden" });
  });

  it("every tool call lands in the record's audit log, which the account page shows per connection", async () => {
    const base = await record("audit");
    const tum = await created(base, TUM, "normal");
    const ielts = await created(base, IELTS, "sensitive");
    const app = await base.addConnection({
      kind: "oauth",
      oauthClientId: "https://claude.ai/oauth/brainiac",
    });
    const cli = await base.addConnection({ kind: "cli" });
    await base.tool({ connectionId: cli.id }, "get", { ids: [tum, ielts] });
    await base.tool({ oauthClientId: "https://claude.ai/oauth/brainiac" }, "describe", {});
    await base.tool({ connectionId: cli.id, background: true }, "describe", {});

    const activity = await base.activity();
    expect(activity.map((a) => [a.connection.id, a.calls.map((c) => c.tool)]).toSorted()).toEqual(
      [
        [app.id, ["describe"]],
        [cli.id, ["describe", "get"]],
      ].toSorted(),
    );
    // The sensitive note was hidden from the CLI connection, so its read names only the one it saw.
    const cliCalls = activity.find((a) => a.connection.id === cli.id)?.calls;
    expect(cliCalls?.map((c) => c.background)).toEqual([true, false]);
    expect(cliCalls?.[1]?.notes).toEqual([{ id: tum, path: TUM }]);

    const html = await accountPage("nadia@example.com", [], 0, [], activity).text();
    expect(html).toContain("What your connections did");
    expect(html).toContain(`get: ${TUM}</span>`);
    // describe's summary of the person shows the open application, so its row names it too.
    expect(html).toContain(`describe: ${TUM} <span class="note">by background filing</span>`);
    expect(html).toContain("claude.ai");
    expect(html).toContain("Brainiac CLI");
  });

  it("holds a write connection's change to a held value until the person accepts it", async () => {
    const base = await record("hold");
    await base.setManifest(fixture("okf-base.yaml"));
    const role = await created(base, ROLE, "normal");
    const connection = await raise(base, await base.addConnection({ kind: "cli" }), { level: "write" });
    const caller = { actor: "human", connectionId: connection.id };
    const edit = {
      op: "patch",
      noteId: role,
      baseRev: 1,
      ops: [{ op: "set", path: ["end"], value: "2025-10-31" }],
    } as const;
    const held = (await base.mutate(edit, caller)) as MutationResult;
    if (held.status !== "proposed") throw new Error(JSON.stringify(held));
    expect(held.autoApplyAt).toBeGreaterThan(Date.now() + 2 * 24 * 60 * 60_000);
    expect(await base.rev(role)).toBe(1);

    expect(await base.decide(held.proposalId, "accept", caller)).toMatchObject({ status: "forbidden" });
    expect(await base.rev(role)).toBe(1);
    expect(await base.decide(held.proposalId, "accept", human)).toMatchObject({ status: "applied" });
    expect(await base.rev(role)).toBe(2);
    // Accepted, it's the person's change.
    expect(await base.actorOf(role)).toBe("human");
  });
});
