// Connections through the real Base DO in workerd: the canary (a new connection sees no sensitive note until
// the person's passkey grants the scope), grants signed by a software passkey, the hold and who decides.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { grantHash, type Connection, type GrantPlan, type MutationResult } from "@brainiac/base";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import type { Approver } from "../src/approvals.ts";
import { createAuthenticator } from "../src/auth/test-authenticator.ts";
import type { TestBase } from "./harness.ts";

const ORIGIN = "https://brainiac.test";
const FIXTURES = join(import.meta.dirname, "../../../fixtures/nadia");
const fixture = (path: string) => readFileSync(join(FIXTURES, path), "utf8");
const IELTS = "facts/tests/ielts-2025-03.md";
const TUM = "applications/tum-msc-informatics-2027/application.md";
const ROLE = "facts/roles/acme-intern-2025.md";
const human = { actor: "human" };

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
    // Both are in the index, each in its own family.
    expect(await base.search("held the score back", human)).toEqual([ielts]);

    const connection = await base.addConnection({ kind: "cli" });
    const caller = { actor: "human", connectionId: connection.id };
    const seen = async () => {
      const notes = await base.notes(caller);
      if (!Array.isArray(notes)) throw new Error(JSON.stringify(notes));
      return notes.map((note) => note.id);
    };
    expect(await seen()).toEqual([tum]);
    expect(await base.search("held the score back", caller)).toEqual([]);
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
    expect(await base.search("held the score back", caller)).toEqual([ielts]);
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
    expect(await base.actorOf(role)).toBe(`connection:${connection.id}`);
  });
});
