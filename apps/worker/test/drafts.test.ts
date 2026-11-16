// Drafts and packets through the real site routes (site.ts, drafts.ts), the real Base DO and the real Typst Worker
// in workerd. harness.ts fakes only the session. A download is the person's alone, and only of a draft whose
// every claim matches the record.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import { typstWorker } from "../../../scripts/typst-worker.ts";
import type { TestBase } from "./harness.ts";

const SITE = "https://brainiac.test";
const FIXTURES = join(import.meta.dirname, "../../../fixtures/nadia");
const TUM = "applications/tum-msc-informatics-2027/application.md";
const BSC = "facts/education/bsc-northvale.md";
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
        serviceBindings: { TYPST: "typst" },
      },
      await typstWorker(),
    ],
  });
  const vaultKey = await mf.getSecretsStoreSecretAPI("VAULT_KEY", "main");
  await vaultKey().create("a stage's vault key");
});
afterAll(() => mf.dispose());

/** The record named `user`, with the fixture's manifest, the TUM application, the BSc and a CV for TUM. */
async function record(user: string, cv: string) {
  const namespace = await mf.getDurableObjectNamespace("BASE", "main");
  // The stub's RPC methods are the DO's own; Miniflare's types describe only fetch.
  const base = namespace.get(namespace.idFromName(user)) as unknown as DurableObjectStub<TestBase>;
  await base.setManifest(readFileSync(join(FIXTURES, "okf-base.yaml"), "utf8"));
  const created: { noteId: string; rev: number }[] = [];
  for (const path of [TUM, BSC]) {
    const made = await base.mutate(
      { op: "create", path, raw: readFileSync(join(FIXTURES, path), "utf8"), class: "normal" },
      human,
    );
    if (made.status !== "applied") throw new Error(JSON.stringify(made));
    created.push({ noteId: made.noteId, rev: made.rev });
  }
  const bsc = readFileSync(join(FIXTURES, BSC), "utf8").match(/^id: (\S+)/m)?.[1];
  const raw = [
    "---",
    "id: 01M6AM78G0STS7TB29G7A10CV2",
    "type: Draft",
    "title: Karim Nadia CV",
    "kind: cv",
    "for: application.md",
    `claims: [{note: ${bsc}, field: cgpa, value: ${cv}}]`,
    "---",
    "# Nadia Karim",
    "",
    "- **BSc Computer Science**, Northvale University, CGPA 3.82",
    "",
  ].join("\n");
  const draft = await base.mutate(
    { op: "create", path: "applications/tum-msc-informatics-2027/cv-v2.md", raw, class: "normal" },
    human,
  );
  if (draft.status !== "applied") throw new Error(JSON.stringify(draft));
  const [tum] = created;
  if (!tum) throw new Error("no TUM");
  return { base, draft: draft.noteId, tum };
}

const get = (path: string, user?: string) =>
  mf.dispatchFetch(`${SITE}${path}`, user ? { headers: { cookie: `user=${user}` } } : {});

describe("drafts", () => {
  it("downloads a draft that passes verify as a PDF, for the person only", async () => {
    const { draft } = await record("pdf", "3.82");
    expect((await get(`/api/drafts/${draft}/pdf`)).status).toBe(401);
    const res = await get(`/api/drafts/${draft}/pdf`, "pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''Karim_Nadia_CV.pdf");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    // Another person's session finds no such draft in their own record.
    expect((await get(`/api/drafts/${draft}/pdf`, "someone-else")).status).toBe(409);
  });

  it("refuses a draft whose claim the record no longer holds", async () => {
    const { draft } = await record("stale", "3.9");
    const res = await get(`/api/drafts/${draft}/pdf`, "stale");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        "applications/tum-msc-informatics-2027/cv-v2.md doesn't pass verify: ask your Claude to check it with draft {verify}.",
    });
  });

  it("zips the packet in its order under the portal's names, and lists what the person adds by hand", async () => {
    const { base, tum } = await record("packet", "3.82");
    const patched = await base.mutate(
      {
        op: "patch",
        noteId: tum.noteId,
        baseRev: tum.rev,
        ops: [
          {
            op: "set",
            path: ["packet"],
            value: [
              { item: "cv-v2.md", name: "Karim_Nadia_CV.pdf" },
              { item: "../../documents/transcript-bsc.md", name: "Karim_Nadia_Transcript.pdf" },
            ],
          },
        ],
      },
      human,
    );
    expect(patched.status).toBe("applied");
    const res = await get(`/api/applications/${tum.noteId}/packet`, "packet");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const dir = mkdtempSync(join(tmpdir(), "brainiac-packet-"));
    writeFileSync(join(dir, "packet.zip"), new Uint8Array(await res.arrayBuffer()));
    const read = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n: z.read(n)[:5].decode('latin-1') if n.endswith('.pdf') else z.read(n).decode() for n in z.namelist()}))",
          join(dir, "packet.zip"),
        ],
        { encoding: "utf8" },
      ),
    );
    expect(read).toEqual({
      "Karim_Nadia_CV.pdf": "%PDF-",
      "MISSING.txt":
        "Add these yourself before you upload:\n- Karim_Nadia_Transcript.pdf: names no note in the record\n",
    });
  });
});
