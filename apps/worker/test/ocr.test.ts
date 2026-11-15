// Photos and scans through the whole path: an upload, the record's file job, the real OCR Worker (Tesseract and
// Images in workerd) and the install, on fixtures made for the fictional fixture student (fixtures/scans).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Uploaded } from "@brainiac/base";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import { ocrWorker } from "../../../scripts/ocr-worker.ts";
import type { TestBase } from "./harness.ts";

const FIXTURES = join(import.meta.dirname, "../../../fixtures");
const scan = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, "scans", name)));
const human = { actor: "human" };

let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    workers: [
      {
        name: "main",
        modules: true,
        script: await bundleWorker(join(import.meta.dirname, "harness.ts")),
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { BASE: { className: "TestBase", useSQLite: true } },
        r2Buckets: ["BLOBS"],
        secretsStoreSecrets: { VAULT_KEY: { store_id: "test", secret_name: "vault_key" } },
        queueProducers: { JOBS: { queueName: "jobs" } },
        queueConsumers: { jobs: { maxBatchTimeout: 0 } },
        serviceBindings: { OCR: "ocr" },
      },
      await ocrWorker(),
    ],
  });
  const vaultKey = await mf.getSecretsStoreSecretAPI("VAULT_KEY", "main");
  await vaultKey().create("a stage's vault key");
});
afterAll(() => mf.dispose());

async function record(name: string) {
  const namespace = await mf.getDurableObjectNamespace("BASE", "main");
  // The stub's RPC methods are the DO's own; Miniflare's types describe only fetch.
  const base = namespace.get(namespace.idFromName(name)) as unknown as DurableObjectStub<TestBase>;
  await base.setManifest(readFileSync(join(FIXTURES, "nadia/okf-base.yaml"), "utf8"));
  return base;
}

const sha256Of = (result: Uploaded) => {
  if (!("file" in result) || !result.file) throw new Error(JSON.stringify(result));
  return result.file.sha256;
};

/** Uploads a file as the person and runs its file job to the install. */
async function read(base: DurableObjectStub<TestBase>, bytes: Uint8Array, mime: string, kind?: string) {
  const sha256 = sha256Of(await base.upload(bytes, { mime, ...(kind && { kind }) }, human));
  const installed = base.nextFileInstall();
  await base.dispatch();
  expect(await installed).toBe("installed");
  return base.file(sha256, human);
}

describe("ocr", () => {
  it("vaults a photographed passport and parses its MRZ into an IdDocument note", async () => {
    const base = await record("passport-photo");
    const file = await read(base, scan("passport-photo.jpg"), "image/jpeg");
    expect(file).toMatchObject({ class: "vault", checks: "found", findings: ["mrz"] });
    const notes = await base.notes(human);
    if (!file || !("noteId" in file) || !Array.isArray(notes))
      throw new Error(JSON.stringify({ file, notes }));
    const note = notes.find((n) => n.id === file.noteId);
    expect(note?.type).toBe("IdDocument");
    expect(note?.raw).toContain("KARIM");
    // The number went to the vault, never the note.
    expect(note?.raw).not.toContain("XK1234567");
    expect(await base.secretValue(`passport.uto.${file.sha256.slice(0, 12)}`)).toBe("XK1234567");
  });

  it("vaults a scanned passport in a PDF by what OCR read in its JPEG", async () => {
    const base = await record("passport-scan");
    const file = await read(base, scan("passport-scan.pdf"), "application/pdf", "certificate");
    expect(file).toMatchObject({ class: "vault", checks: "found", findings: ["mrz"] });
    expect(file && "noteId" in file && file.noteId).toBeTruthy();
  });

  it("keeps a scanned transcript and a transcript with a logo unclassified, however clean OCR found them", async () => {
    // OCR can't vouch it saw all an image says, so a file with one is never cleared by the checks.
    const base = await record("transcripts");
    for (const name of ["transcript-scan.pdf", "transcript-logo.pdf"]) {
      const file = await read(base, scan(name), "application/pdf", "transcript");
      expect(file, name).toMatchObject({ class: "unclassified", checks: "unreadable", findings: [] });
    }
    const results = await base.search("Northvale", human);
    expect("hits" in results && results.hits.filter((hit) => "fileSha" in hit)).toEqual([]);
  });
});
