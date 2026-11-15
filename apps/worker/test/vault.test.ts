// The vault through the real Base DO in workerd, with a real R2 bucket and Secrets Store: what lands in R2 is
// sealed, agents get summaries, and loosening a confirmed kind takes the person's passkey.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  grantHash,
  unseal,
  type Classified,
  type Forbidden,
  type GrantPlan,
  type Results,
  type Uploaded,
} from "@brainiac/base";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import type { Approver } from "../src/approvals.ts";
import { createAuthenticator } from "../src/auth/test-authenticator.ts";
import type { TestBase } from "./harness.ts";

const ORIGIN = "https://brainiac.test";
const FIXTURES = join(import.meta.dirname, "../../../fixtures/nadia");
const human = { actor: "human" };

/** What a search found: note ids, and `<sha256>#p<page>` for a file's page. */
const found = (results: Results | Forbidden) =>
  "hits" in results
    ? results.hits.map((hit) => ("noteId" in hit ? hit.noteId : `${hit.fileSha}#p${hit.page}`))
    : results;
// The fixture student's passport, issued by ICAO's specimen state Utopia (UTO): nobody real.
const PASSPORT = new TextEncoder().encode(
  "P<UTOKARIM<<NADIA<<<<<<<<<<<<<<<<<<<<<<<<<<<\nXK12345679UTO0103141F3105043<<<<<<<<<<<<<<04\n",
);
const TRANSCRIPT = new TextEncoder().encode("Northvale University\nCGPA 3.82 on a scale of 4\n");

let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: await bundleWorker(join(import.meta.dirname, "harness.ts")),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { BASE: { className: "TestBase", useSQLite: true } },
    r2Buckets: ["BLOBS"],
    secretsStoreSecrets: { VAULT_KEY: { store_id: "test", secret_name: "vault_key" } },
    queueProducers: { JOBS: { queueName: "jobs" } },
    queueConsumers: { jobs: { maxBatchTimeout: 0 } },
  });
  const vaultKey = await mf.getSecretsStoreSecretAPI("VAULT_KEY");
  await vaultKey().create("a stage's vault key");
});
afterAll(() => mf.dispose());

async function record(name: string) {
  const namespace = await mf.getDurableObjectNamespace("BASE");
  // The stub's RPC methods are the DO's own; Miniflare's types describe only fetch.
  const base = namespace.get(namespace.idFromName(name)) as unknown as DurableObjectStub<TestBase>;
  await base.setManifest(readFileSync(join(FIXTURES, "okf-base.yaml"), "utf8"));
  return base;
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

const fileOf = (result: Uploaded | Classified) => {
  if (!("file" in result) || !result.file) throw new Error(JSON.stringify(result));
  return result.file;
};

describe("vault", () => {
  it("seals what it puts in R2, and only the record's data key opens it", async () => {
    const base = await record("sealed");
    const { sha256 } = fileOf(await base.upload(PASSPORT, { mime: "text/plain" }, human));
    const bucket = await mf.getR2Bucket("BLOBS");
    const listed = await bucket.list();
    expect(listed.objects.map((object) => object.key)).toEqual([
      `blobs/${(await mf.getDurableObjectNamespace("BASE")).idFromName("sealed").toString()}/${sha256}`,
    ]);
    const stored = new Uint8Array(await (await bucket.get(listed.objects[0]?.key ?? ""))!.arrayBuffer());
    expect(Buffer.from(stored).toString("latin1")).not.toContain("KARIM");
    expect(Buffer.from(unseal(await base.key(), stored, `file:${sha256}`))).toEqual(Buffer.from(PASSPORT));
    // The number sits sealed in the vault, and the record's notes name it only by reference.
    expect(await base.secretValue(`passport.uto.${sha256.slice(0, 12)}`)).toBe("XK1234567");
    expect(JSON.stringify(await base.notes(human))).not.toContain("XK1234567");
  });

  it("gives an agent a summary of a vault document, never more, even with every scope", async () => {
    const base = await record("summary");
    const agent = await base.addConnection({ kind: "cli" });
    const plan: GrantPlan = { ...agent, connectionId: agent.id, level: "write", sensitive: true };
    const { authenticator, approver } = passkey();
    await base.grant(plan, authenticator.authenticate({ challenge: grantHash(plan) }), approver);
    const caller = { actor: "agent", connectionId: agent.id };
    const uploaded = await base.upload(PASSPORT, { mime: "text/plain", kind: "certificate" }, caller);
    const file = fileOf(uploaded);
    expect(file).toEqual({
      sha256: file.sha256,
      class: "vault",
      summary: "Vault document: only you can open it.",
      kind: "certificate",
      noteId: expect.any(String),
    });
    expect(await base.file(file.sha256, caller)).toEqual(file);
    // The agent's kind didn't confirm anything, and it can't confirm one either.
    expect(await base.classifyFile(file.sha256, "certificate", caller)).toMatchObject({
      status: "forbidden",
    });
  });

  it("reads a PDF through the queue, and once the checks clear it, its pages are searched", async () => {
    const base = await record("ingest");
    // A text-layer PDF as the harness's stand-in for toMarkdown reads it: pages split by form feeds.
    const pdf = new TextEncoder().encode("%PDF-Northvale University transcript\fThesis on transit apps\n");
    const { sha256 } = fileOf(await base.upload(pdf, { mime: "application/pdf", kind: "transcript" }, human));
    expect(await base.file(sha256, human)).toMatchObject({ class: "unclassified", checks: "unreadable" });
    expect(found(await base.search("transit", human))).toEqual([]);

    const installed = base.nextInstall();
    await base.dispatch();
    expect(await installed).toBe("installed");
    expect(await base.file(sha256, human)).toMatchObject({ class: "sensitive", checks: "clean" });
    expect(found(await base.search("transit", human))).toEqual([`${sha256}#p2`, `${sha256}#p1`]);
    expect(await base.vectorModels()).toEqual(["@cf/baai/bge-m3", "@cf/baai/bge-m3"]);
    // A cleared file is sensitive: a connection without the scope finds nothing.
    const agent = await base.addConnection({ kind: "cli" });
    expect(found(await base.search("transit", { actor: "agent", connectionId: agent.id }))).toEqual([]);
  });

  it("a PDF the person names after it was read is indexed by a job the confirmation dispatches", async () => {
    const base = await record("named-later");
    const pdf = new TextEncoder().encode("%PDF-Northvale University transcript\fThesis on transit apps\n");
    const { sha256 } = fileOf(await base.upload(pdf, { mime: "application/pdf" }, human));
    const read = base.nextInstall();
    await base.dispatch();
    expect(await read).toBe("installed");
    expect(await base.file(sha256, human)).toMatchObject({ class: "unclassified", checks: "clean" });
    // The confirmation arms the alarm for the job it enqueued.
    const armed = base.nextAlarm();
    expect(fileOf(await base.classifyFile(sha256, "transcript", human)).class).toBe("sensitive");
    await armed;
    const indexed = base.nextInstall();
    await base.dispatch();
    expect(await indexed).toBe("installed");
    expect(found(await base.search("transit", human))).toEqual([`${sha256}#p2`, `${sha256}#p1`]);
  });

  it("stores nothing for an upload it refuses", async () => {
    const base = await record("refused");
    const reader = await base.addConnection({ kind: "cli" });
    await base.restrict(reader.id, { level: "read" });
    const caller = { actor: "agent", connectionId: reader.id };
    expect(await base.upload(PASSPORT, { mime: "text/plain" }, caller)).toMatchObject({
      status: "forbidden",
    });
    expect(await base.upload(PASSPORT, { mime: "text/plain", kind: "Not A Kind" }, human)).toHaveProperty(
      "error",
    );
    const id = (await mf.getDurableObjectNamespace("BASE")).idFromName("refused").toString();
    const bucket = await mf.getR2Bucket("BLOBS");
    expect((await bucket.list({ prefix: `blobs/${id}/` })).objects).toEqual([]);
  });

  it("loosens a kind the person confirmed only with their passkey's signature over the change", async () => {
    const base = await record("relabel");
    const { sha256 } = fileOf(await base.upload(TRANSCRIPT, { mime: "text/plain", kind: "passport" }, human));
    const asked = await base.classifyFile(sha256, "transcript", human);
    if (!("challenge" in asked)) throw new Error(JSON.stringify(asked));
    const { authenticator, approver } = passkey();
    // A signature over something else is refused, and the file stays in the vault.
    const wrong = authenticator.authenticate({ challenge: "c29tZXRoaW5nIGVsc2U" });
    expect(
      await base.classifyFile(sha256, "transcript", human, { response: wrong, approver }),
    ).toHaveProperty("error");
    expect(await base.file(sha256, human)).toMatchObject({ class: "vault" });
    const response = authenticator.authenticate({ challenge: asked.challenge });
    expect(fileOf(await base.classifyFile(sha256, "transcript", human, { response, approver })).class).toBe(
      "sensitive",
    );
  });
});
