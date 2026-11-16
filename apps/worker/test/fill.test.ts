// Form filling through the real Base DO and site routes in workerd, with a real Secrets Store vault key and real
// WebAuthn assertions from a software passkey: an agent's fill_form answer never holds a secret's value, and the
// value leaves only to the person's own session, on the saved domain, after their passkey for an `ask` secret.
import { EXTENSION_ORIGIN } from "@brainiac/core";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import { createAuthenticator } from "../src/auth/test-authenticator.ts";
import type { TestBase } from "./harness.ts";

const SITE = "https://brainiac.test";
const PAGE = "https://campus.tum.de/apply";
// The fixture student's portal password: fictional.
const PASSWORD = "nadia-PORTAL-canary-4471";

let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: await bundleWorker(new URL("harness.ts", import.meta.url).pathname),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { BASE: { className: "TestBase", useSQLite: true } },
    r2Buckets: ["BLOBS"],
    secretsStoreSecrets: { VAULT_KEY: { store_id: "test", secret_name: "vault_key" } },
    queueProducers: { JOBS: { queueName: "jobs" } },
  });
  const vaultKey = await mf.getSecretsStoreSecretAPI("VAULT_KEY");
  await vaultKey().create("a stage's vault key");
});
afterAll(() => mf.dispose());

async function record(name: string) {
  const namespace = await mf.getDurableObjectNamespace("BASE");
  // The stub's RPC methods are the DO's own; Miniflare's types describe only fetch.
  return namespace.get(namespace.idFromName(name)) as unknown as DurableObjectStub<TestBase>;
}

/**
 * The person's passkey and a signed-in tab of theirs (or their browser extension, by `origin`); Neon's copy of the
 * passkey rides in the fake session.
 */
function person(user: string, origin = SITE, authenticator = createAuthenticator(SITE)) {
  const neon = {
    credentialId: authenticator.id,
    publicKey: authenticator.publicKey,
    counter: 0,
    approvesAt: new Date(0).toISOString(),
    origin: SITE,
  };
  const headers = {
    cookie: `user=${user}`,
    origin,
    "content-type": "application/json",
    "x-test-passkey": JSON.stringify(neon),
  };
  const post = async (path: string, body: unknown) => {
    const res = await mf.dispatchFetch(`${SITE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const get = async (path: string) =>
    (await (await mf.dispatchFetch(`${SITE}${path}`, { headers })).json()) as Record<string, unknown>;
  return { authenticator, post, get };
}

/** A write connection for the person's own Claude, as if they granted it (grants are tested elsewhere). */
async function agentOf(base: DurableObjectStub<TestBase>) {
  const agent = await base.addConnection({ kind: "cli" });
  await base.setGrants(agent.id, { level: "write", sensitive: false, holdDays: 0 });
  return async (args: unknown): Promise<unknown> =>
    // The stub's RPC answer, as a plain object.
    JSON.parse(JSON.stringify(await base.tool({ connectionId: agent.id }, "fill_form", args)));
}

/** The id of a fill the agent's call left waiting. */
function fillOf(answer: unknown): string {
  const fill = JSON.stringify(answer).match(/"fill":"([0-9A-Z]{26})"/)?.[1];
  if (fill === undefined) throw new Error(JSON.stringify(answer));
  return fill;
}

const FIELDS = [
  { field: "Username", value: "nadia.karim" },
  { field: "Password", secret: "portal.tum" },
];

describe("form filling", () => {
  it("an agent asks, and only the person's Fill with their passkey puts the secret in the page", async () => {
    const base = await record("fill");
    const you = person("fill");
    expect(
      await you.post("/api/secrets", { name: "portal.tum", value: PASSWORD, domain: "campus.tum.de" }),
    ).toEqual({
      status: 200,
      body: { secret: { name: "portal.tum", domain: "campus.tum.de", policy: "ask" } },
    });
    expect(await you.get("/api/secrets")).toEqual({
      secrets: [{ name: "portal.tum", domain: "campus.tum.de", policy: "ask" }],
    });

    const fillForm = await agentOf(base);
    const asked = await fillForm({ url: PAGE, fields: FIELDS });
    expect(asked).toMatchObject({ ok: true, value: { status: "waiting" } });
    expect(JSON.stringify(asked)).not.toContain(PASSWORD);
    const fill = fillOf(asked);

    // The extension on that page sees the fill, secrets by name only.
    const listed = await you.get(`/api/fills?url=${encodeURIComponent("https://campus.tum.de/x")}`);
    expect(listed).toMatchObject({ fills: [{ id: fill, fields: FIELDS }] });
    expect(JSON.stringify(listed)).not.toContain(PASSWORD);

    // Pressing Fill on a lookalike gets nothing; on the page, it asks for the passkey over where it goes.
    const phish = await you.post(`/api/fills/${fill}`, { url: "https://campus.tum.de.login-check.example/" });
    expect(phish.status).toBe(400);
    expect(phish.body["error"]).toMatch(/only imitates campus\.tum\.de/);
    const ask = await you.post(`/api/fills/${fill}`, { url: PAGE });
    expect(ask).toMatchObject({ status: 409, body: { needsApproval: true, host: "campus.tum.de" } });
    const challenge = String(ask.body["challenge"]);
    const filled = await you.post(`/api/fills/${fill}`, {
      url: PAGE,
      response: you.authenticator.authenticate({ challenge }),
    });
    expect(filled).toEqual({
      status: 200,
      body: {
        fields: [
          { field: "Username", value: "nadia.karim" },
          { field: "Password", value: PASSWORD },
        ],
      },
    });
    // Once.
    const again = await you.post(`/api/fills/${fill}`, {
      url: PAGE,
      response: you.authenticator.authenticate({ challenge }),
    });
    expect(again.status).toBe(400);
  });

  it("a signature from someone else's passkey, or a page on another origin, releases nothing", async () => {
    const base = await record("strangers");
    const you = person("strangers");
    await you.post("/api/secrets", { name: "portal.tum", value: PASSWORD, domain: "campus.tum.de" });
    const fillForm = await agentOf(base);
    const fill = fillOf(await fillForm({ url: PAGE, fields: FIELDS }));
    const { body } = await you.post(`/api/fills/${fill}`, { url: PAGE });
    const challenge = String(body["challenge"]);

    const stranger = createAuthenticator(SITE);
    const forged = await you.post(`/api/fills/${fill}`, {
      url: PAGE,
      response: stranger.authenticate({ challenge }),
    });
    expect(forged.status).toBe(403);

    // The portal's own page can't ask the site for the values, even with the person's cookie.
    const cross = await mf.dispatchFetch(`${SITE}/api/fills/${fill}`, {
      method: "POST",
      headers: { cookie: "user=strangers", origin: "https://campus.tum.de" },
      body: JSON.stringify({ url: PAGE }),
    });
    expect(cross.status).toBe(403);
    // Still waiting for the person.
    expect(await you.get(`/api/fills?url=${encodeURIComponent(PAGE)}`)).toMatchObject({
      fills: [{ id: fill }],
    });
  });

  it("the browser extension presses Fill and Dismiss with the person's cookie, and reaches no other route", async () => {
    const base = await record("extension");
    const you = person("extension");
    const extension = person("extension", EXTENSION_ORIGIN, you.authenticator);
    await you.post("/api/secrets", { name: "portal.tum", value: PASSWORD, domain: "campus.tum.de" });
    const fillForm = await agentOf(base);
    const fill = fillOf(await fillForm({ url: PAGE, fields: FIELDS }));
    const other = fillOf(await fillForm({ url: PAGE, fields: FIELDS }));

    // The ask comes back to the extension; the site's page signs it (extensions can't assert for its rpId).
    const ask = await extension.post(`/api/fills/${fill}`, { url: PAGE });
    expect(ask).toMatchObject({ status: 409, body: { needsApproval: true, host: "campus.tum.de" } });
    const filled = await extension.post(`/api/fills/${fill}`, {
      url: PAGE,
      response: you.authenticator.authenticate({ challenge: String(ask.body["challenge"]) }),
    });
    expect(filled.body).toMatchObject({ fields: [{}, { field: "Password", value: PASSWORD }] });
    expect((await extension.post(`/api/fills/${other}/dismiss`, {})).body).toEqual({ dismissed: true });

    // Saving or forgetting a secret, or anything else that changes the record, stays on the site.
    for (const [path, body] of [
      ["/api/secrets", { name: "portal.tum", policy: "allow" }],
      ["/api/secrets", { name: "portal.tum", forget: true }],
      ["/api/emails", { email: "questions", on: false }],
      ["/api/approve", { approvalId: "x" }],
    ] as const)
      expect((await extension.post(path, body)).status, path).toBe(403);
    expect(await you.get("/api/secrets")).toEqual({
      secrets: [{ name: "portal.tum", domain: "campus.tum.de", policy: "ask" }],
    });
    // Another extension's origin is any other page's.
    const stranger = person("extension", "chrome-extension://abcdefghijklmnopabcdefghijklmnop");
    const third = fillOf(await fillForm({ url: PAGE, fields: FIELDS }));
    expect((await stranger.post(`/api/fills/${third}`, { url: PAGE })).status).toBe(403);
    expect((await stranger.post(`/api/fills/${third}/dismiss`, {})).status).toBe(403);
  });

  it("making a secret fill without asking takes the passkey; then Fill needs none, and dismiss turns one down", async () => {
    const base = await record("allow");
    const you = person("allow");
    await you.post("/api/secrets", { name: "portal.tum", value: PASSWORD, domain: "campus.tum.de" });
    const loosen = await you.post("/api/secrets", { name: "portal.tum", policy: "allow" });
    expect(loosen).toMatchObject({ status: 409, body: { needsApproval: true } });
    const allowed = await you.post("/api/secrets", {
      name: "portal.tum",
      policy: "allow",
      response: you.authenticator.authenticate({ challenge: String(loosen.body["challenge"]) }),
    });
    expect(allowed.body).toEqual({
      secret: { name: "portal.tum", domain: "campus.tum.de", policy: "allow" },
    });

    const fillForm = await agentOf(base);
    const fill = fillOf(await fillForm({ url: PAGE, fields: FIELDS }));
    expect((await you.post(`/api/fills/${fill}`, { url: PAGE })).body).toMatchObject({
      fields: [{}, { field: "Password", value: PASSWORD }],
    });

    const other = fillOf(await fillForm({ url: PAGE, fields: FIELDS }));
    expect((await you.post(`/api/fills/${other}/dismiss`, {})).body).toEqual({ dismissed: true });
    expect(await you.get(`/api/fills?url=${encodeURIComponent(PAGE)}`)).toEqual({ fills: [] });
    expect((await you.post("/api/secrets", { name: "portal.tum", forget: true })).body).toEqual({
      forgot: true,
    });
    expect(await you.get("/api/secrets")).toEqual({ secrets: [] });
  });
});
