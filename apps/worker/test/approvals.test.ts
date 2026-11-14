// Approvals through the real Base DO in workerd: real WebAuthn assertions from a software passkey, checked
// with SimpleWebAuthn. Forged, replayed, misdirected and early signatures are refused; a good one lets exactly
// its change through, once.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { MutationResult, NeedsApproval } from "@brainiac/base";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import type { Approver } from "../src/approvals.ts";
import { createAuthenticator } from "../src/auth/test-authenticator.ts";
import type { TestBase } from "./harness.ts";

const ORIGIN = "https://brainiac.test";
const IELTS = "facts/tests/ielts-2026-11.md";
const raw = readFileSync(join(import.meta.dirname, "../../../fixtures/nadia", IELTS), "utf8");
const human = { actor: "human" };
const agent = { actor: "connection:agent" };

let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: await bundleWorker(join(import.meta.dirname, "harness.ts")),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { BASE: { className: "TestBase", useSQLite: true } },
    queueProducers: { JOBS: { queueName: "jobs" } },
  });
});
afterAll(() => mf.dispose());

async function record(name: string) {
  const namespace = await mf.getDurableObjectNamespace("BASE");
  // The stub's RPC methods are the DO's own; Miniflare's types describe only fetch.
  return namespace.get(namespace.idFromName(name)) as unknown as DurableObjectStub<TestBase>;
}

const passkey = (overrides: Partial<Approver> = {}) => {
  const authenticator = createAuthenticator(ORIGIN);
  const approver: Approver = {
    credentialId: authenticator.id,
    publicKey: authenticator.publicKey,
    counter: 0,
    approvesAt: new Date(0),
    origin: ORIGIN,
    ...overrides,
  };
  return { authenticator, approver };
};

const create = { op: "create", path: IELTS, raw, class: "sensitive" } as const;

/** The verified IELTS note's creation, held for approval. */
async function held(base: DurableObjectStub<TestBase>): Promise<NeedsApproval> {
  // As the DO types it: the stub's RPC types drop a result whose fields hold `unknown` values.
  const result = (await base.mutate(create, human)) as MutationResult;
  if (result.status !== "needsApproval") throw new Error(JSON.stringify(result));
  return result;
}

describe("approvals", () => {
  it("a passkey signature over the plan hash lets exactly that change through, once", async () => {
    const base = await record("good");
    const { authenticator, approver } = passkey();
    const plan = await held(base);
    const approved = await base.approve(
      plan.items,
      authenticator.authenticate({ challenge: plan.planHash }),
      approver,
    );
    if (!("approvalId" in approved)) throw new Error(approved.error);

    const created = await base.mutate(create, { ...human, approvalId: approved.approvalId });
    expect(created.status).toBe("applied");
    if (created.status !== "applied") return;
    // Spent: the next change to a verified value needs a new signature.
    const edit = {
      op: "patch",
      noteId: created.noteId,
      baseRev: 1,
      ops: [{ op: "set", path: ["overall"], value: 9 }],
    } as const;
    expect(await base.mutate(edit, { ...agent, approvalId: approved.approvalId })).toMatchObject({
      status: "needsApproval",
    });
    expect(await base.rev(created.noteId)).toBe(1);
  });

  it("refuses a replayed signature", async () => {
    const base = await record("replay");
    const { authenticator, approver } = passkey();
    const plan = await held(base);
    const assertion = authenticator.authenticate({ challenge: plan.planHash });
    expect(await base.approve(plan.items, assertion, approver)).toHaveProperty("approvalId");
    expect(await base.approve(plan.items, assertion, approver)).toHaveProperty("error");
    // Even once the passkey's counter in Neon is behind the record's.
    expect(await base.approve(plan.items, assertion, { ...approver, counter: 0 })).toHaveProperty("error");
  });

  it("refuses forged signatures", async () => {
    const base = await record("forged");
    const { authenticator, approver } = passkey();
    const intruder = createAuthenticator(ORIGIN);
    const plan = await held(base);
    const sign = (challenge = plan.planHash) => authenticator.authenticate({ challenge });

    const refused = [
      // Another key, presented as the person's passkey.
      {
        ...intruder.authenticate({ challenge: plan.planHash }),
        id: approver.credentialId,
        rawId: approver.credentialId,
      },
      // The person's passkey, over another plan.
      sign("c2lnbmVkLXNvbWV0aGluZy1lbHNl"),
      // A signature with a byte flipped.
      (() => {
        const good = sign();
        const bytes = Buffer.from(good.response.signature, "base64url");
        bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;
        return { ...good, response: { ...good.response, signature: bytes.toString("base64url") } };
      })(),
    ];
    for (const assertion of refused) {
      expect(await base.approve(plan.items, assertion, approver)).toHaveProperty("error");
    }
    // A good signature presented with different items than it signed.
    const other = plan.items.map((item) => ({ ...item, path: "facts/tests/other.md" }));
    expect(await base.approve(other, sign(), approver)).toHaveProperty("error");
    // A good signature made on another site.
    const phishing = createAuthenticator("https://brainiac.test.evil");
    expect(
      await base.approve(plan.items, phishing.authenticate({ challenge: plan.planHash }), {
        ...approver,
        credentialId: phishing.id,
        publicKey: phishing.publicKey,
      }),
    ).toHaveProperty("error");
    expect(await base.mutate(create, human)).toMatchObject({ status: "needsApproval" });
  });

  it("refuses a passkey that can't approve yet", async () => {
    const base = await record("waiting");
    const plan = await held(base);
    for (const approvesAt of [null, new Date(Date.now() + 72 * 60 * 60 * 1000)]) {
      const { authenticator, approver } = passkey({ approvesAt });
      const assertion = authenticator.authenticate({ challenge: plan.planHash });
      expect(await base.approve(plan.items, assertion, approver)).toEqual({
        error: "This passkey can't approve yet.",
      });
    }
  });

  it("opens a review session only with a fresh signature over its nonce", async () => {
    const base = await record("review");
    const { authenticator, approver } = passkey();
    const nonce = await base.startReview(["01M6ADBH80DEGPEVAAVR2625V1"]);
    const intruder = createAuthenticator(ORIGIN);
    const forged = { ...intruder.authenticate({ challenge: nonce }), id: approver.credentialId };
    expect(await base.openReview(nonce, forged, approver)).toHaveProperty("error");
    const assertion = authenticator.authenticate({ challenge: nonce });
    expect(await base.openReview(nonce, assertion, approver)).toEqual({ review: nonce });
    expect(await base.openReview(nonce, assertion, approver)).toHaveProperty("error");
    // A session over a note doesn't cover creating it: a review covers notes that already exist.
    expect(await base.mutate(create, { ...human, review: nonce })).toMatchObject({ status: "needsApproval" });
  });
});
