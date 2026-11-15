// Review mode through the real site routes (site.ts) and the real Base DO in workerd, with real WebAuthn
// assertions from a software passkey. One signature opens a session; each "Correct" is an approval inside it,
// only for the notes it was opened over, and only with a passkey of the person's own.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseNote, patch, verifyOps } from "@brainiac/core";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import { createAuthenticator } from "../src/auth/test-authenticator.ts";
import type { TestBase } from "./harness.ts";

const SITE = "https://brainiac.test";
const FIXTURE = join(import.meta.dirname, "../../../fixtures/nadia");
const ROLE = readFileSync(join(FIXTURE, "facts/roles/acme-intern-2025.md"), "utf8");
const BSC = readFileSync(join(FIXTURE, "facts/education/bsc-northvale.md"), "utf8");
const NOW = Date.UTC(2026, 10, 15);

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

/** The person's passkey, and the headers a tab of theirs sends: Neon's copy of the passkey rides in the fake. */
function person(user: string) {
  const authenticator = createAuthenticator(SITE);
  const neon = {
    credentialId: authenticator.id,
    publicKey: authenticator.publicKey,
    counter: 0,
    approvesAt: new Date(0).toISOString(),
    origin: SITE,
  };
  const headers = {
    cookie: `user=${user}`,
    origin: SITE,
    "content-type": "application/json",
    "x-test-passkey": JSON.stringify(neon),
  };
  const post = (path: string, body: unknown) =>
    mf.dispatchFetch(`${SITE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  /** Starts a session over `noteIds` and signs it, as the review page does. */
  const open = async (noteIds: readonly string[]) => {
    const { nonce } = (await (await post("/api/review", { noteIds })).json()) as { nonce: string };
    const res = await post("/api/review/open", {
      nonce,
      response: authenticator.authenticate({ challenge: nonce }),
    });
    expect(await res.json()).toEqual({ review: nonce });
    return nonce;
  };
  return { authenticator, post, open };
}

const verified = (raw: string, rev: number) => patch(raw, verifyOps(parseNote(raw).data, null, rev, NOW));

describe("review mode", () => {
  it("one signature lets Correct verify, and undo, each note it was opened over", async () => {
    const base = await record("correct");
    const [role = ""] = await base.seed([
      { path: "facts/roles/acme-intern-2025.md", raw: ROLE, class: "normal" },
    ]);
    const { post, open } = person("correct");
    // Without a session, setting verification needs its own approval.
    const plain = await post(`/api/notes/${role}`, { raw: verified(ROLE, 1), baseRev: 1 });
    expect(plain.status).toBe(409);
    expect(await plain.json()).toMatchObject({ needsApproval: true });

    const review = await open([role]);
    const correct = await post(`/api/notes/${role}`, { raw: verified(ROLE, 1), baseRev: 1, review });
    expect(await correct.json()).toEqual({ rev: 2 });
    expect(await base.actorOf(role)).toBe("human");
    // Undo puts the text back, clearing verification, on the same signature.
    const undo = await post(`/api/notes/${role}`, { raw: ROLE, baseRev: 2, review });
    expect(await undo.json()).toEqual({ rev: 3 });
  });

  it("a session never reaches past its items, and is only the person's own", async () => {
    const base = await record("scoped");
    const [role = "", bsc = ""] = await base.seed([
      { path: "facts/roles/acme-intern-2025.md", raw: ROLE, class: "normal" },
      { path: "facts/education/bsc-northvale.md", raw: BSC, class: "normal" },
    ]);
    const { post, open } = person("scoped");
    const review = await open([role]);
    const beyond = await post(`/api/notes/${bsc}`, { raw: verified(BSC, 1), baseRev: 1, review });
    expect(beyond.status).toBe(409);
    expect(await beyond.json()).toMatchObject({
      needsApproval: true,
      error: expect.stringContaining("review session"),
    });
    expect(await base.rev(bsc)).toBe(1);

    // Another record's session can't use this one's nonce.
    const other = person("other");
    expect(
      (await other.post(`/api/notes/${role}`, { raw: verified(ROLE, 1), baseRev: 1, review })).status,
    ).not.toBe(200);
    expect(await base.rev(role)).toBe(1);
  });

  it("opens only with a signature from one of the person's own passkeys, over that nonce", async () => {
    await record("signer");
    const { post } = person("signer");
    const { nonce } = (await (
      await post("/api/review", { noteIds: ["01M6AGSCW0VCVQ4638KZVD05RK"] })
    ).json()) as {
      nonce: string;
    };
    // A passkey Neon doesn't hold for this person.
    const stranger = createAuthenticator(SITE);
    const res = await post("/api/review/open", {
      nonce,
      response: stranger.authenticate({ challenge: nonce }),
    });
    expect(res.status).toBe(403);
    // Their own passkey, signing something else.
    const own = person("signer");
    const wrong = await own.post("/api/review/open", {
      nonce,
      response: own.authenticator.authenticate({ challenge: "not-the-nonce" }),
    });
    expect(wrong.status).toBe(403);
    expect((await post("/api/review", { noteIds: ["not an id"] })).status).toBe(400);
  });
});
