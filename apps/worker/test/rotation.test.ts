// Rotating the stage's vault key (infra/README.md#rotating-the-vault-key) through the real site, usercontent
// route and Base DO in workerd, with a real R2 bucket and Secrets Store whose bindings change between steps the
// way a deploy changes them.
import { vaultKeyId } from "@brainiac/base";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import type { TestBase } from "./harness.ts";

const SITE = "https://brainiac.test";
const USERCONTENT = "https://usercontent.brainiac.test";
const TRANSCRIPT = new TextEncoder().encode("Northvale University\nCGPA 3.82 on a scale of 4\n");

let script: string;
let mf: Miniflare;
/** The Worker as a deploy with these vault key bindings (by Secrets Store name) would run it. */
const deployed = (keys: Record<string, string>): MiniflareOptions => ({
  modules: true,
  script,
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { BASE: { className: "TestBase", useSQLite: true } },
  r2Buckets: ["BLOBS"],
  secretsStoreSecrets: Object.fromEntries(
    Object.entries(keys).map(([binding, name]) => [binding, { store_id: "test", secret_name: name }]),
  ),
  queueProducers: { JOBS: { queueName: "jobs" } },
  bindings: { USERCONTENT_ORIGIN: USERCONTENT },
});

beforeAll(async () => {
  script = await bundleWorker(new URL("harness.ts", import.meta.url).pathname);
  mf = new Miniflare(deployed({ VAULT_KEY: "vault_key" }));
  await (await mf.getSecretsStoreSecretAPI("VAULT_KEY"))().create("generation one");
});
afterAll(() => mf.dispose());

async function upload(user: string): Promise<string> {
  const res = await mf.dispatchFetch(`${SITE}/api/files`, {
    method: "POST",
    headers: { cookie: `user=${user}`, origin: SITE, "content-type": "text/plain" },
    body: TRANSCRIPT,
  });
  const body = (await res.json()) as { file: { sha256: string } };
  if (res.status !== 200) throw new Error(JSON.stringify(body));
  return body.file.sha256;
}

/** The person opens their file's original, as the site's viewer does. */
async function open(user: string, sha256: string) {
  const res = await mf.dispatchFetch(`${SITE}/api/files/${sha256}/token`, {
    method: "POST",
    headers: { cookie: `user=${user}; passkey=1`, origin: SITE },
  });
  const { url } = (await res.json()) as { url: string };
  return mf.dispatchFetch(url);
}

async function record(name: string) {
  const namespace = await mf.getDurableObjectNamespace("BASE");
  // The stub's RPC methods are the DO's own; Miniflare's types describe only fetch.
  return namespace.get(namespace.idFromName(name)) as unknown as DurableObjectStub<TestBase>;
}

it("keeps every file sealed before a rotation readable, and a record that missed it fails without a new key", async () => {
  const sealed = await upload("ada");
  const missed = await upload("asleep");
  // Copied out: what a stub returned is gone once the options change.
  const asleep = { ...(await (await record("asleep")).wrappedDataKey()) };
  expect(asleep.vaultKeyId).toBe(vaultKeyId("generation one"));

  // Add the new key and bind the old one beside it.
  await mf.setOptions(deployed({ VAULT_KEY: "vault_key__g2", VAULT_KEY_PREVIOUS: "vault_key" }));
  await (await mf.getSecretsStoreSecretAPI("VAULT_KEY"))().create("generation two");
  const opened = await open("ada", sealed);
  expect(opened.status).toBe(200);
  expect(new Uint8Array(await opened.arrayBuffer())).toEqual(TRANSCRIPT);
  expect((await (await record("ada")).wrappedDataKey()).vaultKeyId).toBe(vaultKeyId("generation two"));
  expect(await (await record("ada")).rewrapDataKey()).toBe(vaultKeyId("generation two"));

  // Remove the old key: the record that rewrapped still reads, and new files seal under the new key.
  await mf.setOptions(deployed({ VAULT_KEY: "vault_key__g2" }));
  const after = await open("ada", sealed);
  expect(new Uint8Array(await after.arrayBuffer())).toEqual(TRANSCRIPT);
  expect((await open("ada", await upload("ada"))).status).toBe(200);

  // "asleep" never woke while both keys were bound. Its file doesn't open, and its data key is the one it had.
  // The error (which key, and to bind it again) is proved in packages/base/test/vault-cases.ts.
  expect((await open("asleep", missed)).status).toBe(500);
  expect(await (await record("asleep")).wrappedDataKey()).toEqual(asleep);
});
