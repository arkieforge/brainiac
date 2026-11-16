// Sensitive note edits and files through the real site and usercontent routes (site.ts, usercontent.ts) and the real Base DO in workerd, with
// a real R2 bucket. harness.ts fakes only the session. An upload can be HTML or SVG someone else wrote, so its bytes
// must never come from the site's origin, and the usercontent origin must never let them run.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import { createAuthenticator } from "../src/auth/test-authenticator.ts";
import type { TestBase } from "./harness.ts";

const SITE = "https://brainiac.test";
const USERCONTENT = "https://usercontent.brainiac.test";
const HTML = new TextEncoder().encode("<script>document.title='pwned'</script><p>hello</p>");
const TRANSCRIPT = new TextEncoder().encode("Northvale University\nCGPA 3.82 on a scale of 4\n");

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
    bindings: { USERCONTENT_ORIGIN: USERCONTENT },
  });
  const vaultKey = await mf.getSecretsStoreSecretAPI("VAULT_KEY");
  await vaultKey().create("a stage's vault key");
});
afterAll(() => mf.dispose());

/** A tab of the site signed in as `user` (whose record is the one named `user`); `passkey`: it proved one lately. */
const tab = (user: string, passkey = false) => ({
  cookie: `user=${user}${passkey ? "; passkey=1" : ""}`,
  origin: SITE,
});

async function upload(user: string, bytes: Uint8Array, mime: string): Promise<string> {
  const res = await mf.dispatchFetch(`${SITE}/api/files`, {
    method: "POST",
    headers: { ...tab(user), "content-type": mime },
    body: bytes,
  });
  const body = (await res.json()) as { file: { sha256: string } };
  if (res.status !== 200) throw new Error(JSON.stringify(body));
  return body.file.sha256;
}

const askToken = (user: string, sha256: string, passkey = false) =>
  mf.dispatchFetch(`${SITE}/api/files/${sha256}/token`, { method: "POST", headers: tab(user, passkey) });

async function tokenUrl(user: string, sha256: string, passkey = true): Promise<string> {
  const res = await askToken(user, sha256, passkey);
  const body = (await res.json()) as { url?: string };
  if (!body.url) throw new Error(JSON.stringify(body));
  return body.url;
}

async function record(name: string) {
  const namespace = await mf.getDurableObjectNamespace("BASE");
  // The stub's RPC methods are the DO's own; Miniflare's types describe only fetch.
  return namespace.get(namespace.idFromName(name)) as unknown as DurableObjectStub<TestBase>;
}

describe("files", () => {
  it("never serves a file's bytes from the site's origin", async () => {
    const sha256 = await upload("main", HTML, "text/html");
    const url = new URL(await tokenUrl("main", sha256));
    expect(url.origin).toBe(USERCONTENT);
    for (const accept of ["*/*", "text/html"]) {
      const res = await mf.dispatchFetch(`${SITE}${url.pathname}`, { headers: { ...tab("main"), accept } });
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("pwned");
    }
    // The site's 404 didn't use the token up: only the usercontent origin does.
    expect((await mf.dispatchFetch(url.href)).status).toBe(200);
  });

  it("serves from usercontent with no scripts, no caching, no sniffing and no cookies", async () => {
    const sha256 = await upload("headers", HTML, "text/html");
    const res = await mf.dispatchFetch(await tokenUrl("headers", sha256), {
      headers: { cookie: "user=headers" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(new TextDecoder().decode(HTML));
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "content-type": "text/html",
      "cache-control": "private, no-store",
      "content-security-policy":
        "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": SITE,
    });
    expect(res.headers.has("set-cookie")).toBe(false);
    // Nothing else is there, and a session cookie sent along opens nothing either.
    for (const path of ["/", "/api/files", "/sync", `/api/files/${sha256}/token`]) {
      const other = await mf.dispatchFetch(`${USERCONTENT}${path}`, { headers: tab("headers") });
      expect(other.status).toBe(404);
      expect(other.headers.get("content-security-policy")).toContain("sandbox");
      expect(other.headers.has("set-cookie")).toBe(false);
    }
  });

  it("opens a file once with a token, and not after it expires", async () => {
    const sha256 = await upload("once", TRANSCRIPT, "text/plain");
    const url = await tokenUrl("once", sha256);
    expect((await mf.dispatchFetch(url)).status).toBe(200);
    expect((await mf.dispatchFetch(url)).status).toBe(404);
    const late = await tokenUrl("once", sha256);
    await (await record("once")).expireFileTokens();
    expect((await mf.dispatchFetch(late)).status).toBe(404);
  });

  it("gives another record's session nothing, and a token moved to another record opens nothing", async () => {
    const sha256 = await upload("owner", TRANSCRIPT, "text/plain");
    await upload("other", HTML, "text/html");
    const asked = await askToken("other", sha256, true);
    expect(asked.status).toBe(400);
    expect(await asked.json()).toEqual({ error: "No such file." });
    const otherId = (await mf.getDurableObjectNamespace("BASE")).idFromName("other").toString();
    const url = new URL(await tokenUrl("owner", sha256));
    const moved = url.pathname.replace(/brf_[0-9a-f]+_/, `brf_${otherId}_`);
    expect((await mf.dispatchFetch(`${USERCONTENT}${moved}`)).status).toBe(404);
    expect((await mf.dispatchFetch(`${USERCONTENT}/f/brf_zz_${"a".repeat(43)}`)).status).toBe(404);
    // The owner's own token was never touched.
    expect((await mf.dispatchFetch(url.href)).status).toBe(200);
  });

  it("opens an unclassified original only after a passkey check, and a cleared one without", async () => {
    const unclassified = await upload("passkey", HTML, "text/html");
    const without = await askToken("passkey", unclassified);
    expect(without.status).toBe(403);
    expect(await without.json()).toEqual({ needsPasskey: true });
    expect((await mf.dispatchFetch(await tokenUrl("passkey", unclassified, true))).status).toBe(200);

    const transcript = await upload("passkey", TRANSCRIPT, "text/plain");
    const kind = await mf.dispatchFetch(`${SITE}/api/files/${transcript}/kind`, {
      method: "POST",
      headers: tab("passkey"),
      body: JSON.stringify({ kind: "transcript" }),
    });
    expect(await kind.json()).toMatchObject({ file: { class: "sensitive", kind: "transcript" } });
    expect((await mf.dispatchFetch(await tokenUrl("passkey", transcript, false))).status).toBe(200);
  });

  it("keeps the uploader's filename for the person, and opens the file from its sidecar note", async () => {
    // A fictional student id in the name, as a real one might print a passport number.
    const name = "Ada Okafor transcript 2019331001.pdf";
    const res = await mf.dispatchFetch(`${SITE}/api/files`, {
      method: "POST",
      headers: {
        ...tab("named"),
        "content-type": "application/pdf",
        "x-file-name": encodeURIComponent(name),
      },
      body: new TextEncoder().encode("%PDF-Northvale University transcript\n"),
    });
    const body = (await res.json()) as {
      file: { sha256: string; name: string; path: string };
      sidecar: string;
    };
    expect(res.status).toBe(200);
    expect(body.file).toMatchObject({ name, class: "unclassified" });
    expect(body.file.path).toMatch(
      new RegExp(`^unorganized/files/upload-[0-9-]{10}-${body.file.sha256.slice(0, 12)}\\.pdf$`),
    );
    const note = await (await record("named")).noteRaw(body.sidecar);
    expect(note).toContain(`file: files/${body.file.path.split("/").at(-1)}`);
    expect(note).not.toContain("2019331001");
  });

  it("never gives a connection a file token", async () => {
    const sha256 = await upload("agent", TRANSCRIPT, "text/plain");
    const base = await record("agent");
    const agent = await base.addConnection({ kind: "cli" });
    const minted = await base.fileToken(
      sha256,
      { actor: "agent", connectionId: agent.id },
      { origin: SITE, passkey: true },
    );
    expect(minted).toMatchObject({ status: "forbidden" });
  });

  it("loosens a kind the person confirmed only with their passkey over that change", async () => {
    const sha256 = await upload("relabel", TRANSCRIPT, "text/plain");
    const passkey = createAuthenticator(SITE);
    const neon = {
      credentialId: passkey.id,
      publicKey: passkey.publicKey,
      counter: 0,
      approvesAt: new Date(0).toISOString(),
      origin: SITE,
    };
    const kind = (body: object) =>
      mf.dispatchFetch(`${SITE}/api/files/${sha256}/kind`, {
        method: "POST",
        headers: {
          ...tab("relabel"),
          "content-type": "application/json",
          "x-test-passkey": JSON.stringify(neon),
        },
        body: JSON.stringify(body),
      });
    const classOf = async () => {
      const { files } = (await (
        await mf.dispatchFetch(`${SITE}/api/files`, { headers: tab("relabel") })
      ).json()) as { files: { class: string }[] };
      return files[0]?.class;
    };
    expect((await kind({ kind: "passport" })).status).toBe(200);
    expect(await classOf()).toBe("vault");
    const asked = await kind({ kind: "transcript" });
    expect(asked.status).toBe(409);
    const { challenge } = (await asked.json()) as { challenge: string };
    // Signed over another change, or by a passkey Neon doesn't hold for this person: the file stays in the vault.
    expect(
      (await kind({ kind: "transcript", response: passkey.authenticate({ challenge: "b3RoZXI" }) })).status,
    ).toBe(400);
    const stranger = createAuthenticator(SITE);
    expect((await kind({ kind: "transcript", response: stranger.authenticate({ challenge }) })).status).toBe(
      403,
    );
    // A signature over loosening to transcript doesn't loosen it to anything else.
    expect((await kind({ kind: "cv", response: passkey.authenticate({ challenge }) })).status).not.toBe(200);
    expect(await classOf()).toBe("vault");
    const signed = await kind({ kind: "transcript", response: passkey.authenticate({ challenge }) });
    expect(signed.status).toBe(200);
    expect(await classOf()).toBe("sensitive");
  });

  it("hands a photo to the person's agent as an image only while they share it, and moves it where they say", async () => {
    const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode("a certificate")]);
    const res = await mf.dispatchFetch(`${SITE}/api/files`, {
      method: "POST",
      headers: { ...tab("photos"), "content-type": "image/jpeg" },
      body: photo,
    });
    const { file, sidecar } = (await res.json()) as { file: { sha256: string }; sidecar: string };
    const base = await record("photos");
    const agent = await base.addConnection({ kind: "cli" });
    await base.setGrants(agent.id, { level: "write", sensitive: true, holdDays: 0 });
    const ask = () => base.tool({ connectionId: agent.id }, "photos", { id: sidecar });
    expect(await ask()).toMatchObject({ ok: false });

    const passkey = createAuthenticator(SITE);
    const neon = {
      credentialId: passkey.id,
      publicKey: passkey.publicKey,
      counter: 0,
      approvesAt: new Date(0).toISOString(),
      origin: SITE,
    };
    const share = (body: object) =>
      mf.dispatchFetch(`${SITE}/api/files/${file.sha256}/share`, {
        method: "POST",
        headers: {
          ...tab("photos"),
          "content-type": "application/json",
          "x-test-passkey": JSON.stringify(neon),
        },
        body: JSON.stringify(body),
      });
    const asked = await share({ on: true });
    expect(asked.status).toBe(409);
    const { challenge } = (await asked.json()) as { challenge: string };
    const shared = await share({ on: true, response: passkey.authenticate({ challenge }) });
    expect(shared.status).toBe(200);
    expect(await shared.json()).toMatchObject({ file: { shared: true, class: "unclassified" } });

    // The photo itself, opened from R2, beside what the record knows about it.
    // The RPC stub's mapped type drops the success arm (its value is `unknown`), so it's read as a plain object.
    const answer: object = await ask();
    expect(answer).toMatchObject({ ok: true, images: [{ mimeType: "image/jpeg" }] });
    const images = "images" in answer && Array.isArray(answer.images) ? answer.images : [];
    expect(images.map((image) => Uint8Array.from(Buffer.from(image.data, "base64")))).toEqual([photo]);
    expect(answer).not.toHaveProperty("attach");

    // Turned off, it is gone from the agent again; no passkey is needed to turn it off.
    expect((await share({ on: false })).status).toBe(200);
    expect(await ask()).toMatchObject({ ok: false });

    // The person moves it out of unorganized/, and the file goes along.
    const [note] = (await base.notes({ actor: "human" })) as { id: string; rev: number }[];
    const moved = await mf.dispatchFetch(`${SITE}/api/notes/${sidecar}/move`, {
      method: "POST",
      headers: { ...tab("photos"), "content-type": "application/json" },
      body: JSON.stringify({ path: "documents/merit-certificate.md", baseRev: note?.rev }),
    });
    expect(moved.status).toBe(200);
    const { files } = (await (
      await mf.dispatchFetch(`${SITE}/api/files`, { headers: tab("photos") })
    ).json()) as {
      files: { path: string }[];
    };
    expect(files[0]?.path).toMatch(/^documents\/files\/upload-/);
  });

  it("hands a shared scanned transcript to the person's agent as its page images, read from R2", async () => {
    const scan = readFileSync(join(import.meta.dirname, "../../../fixtures/scans/transcript-scan.pdf"));
    const res = await mf.dispatchFetch(`${SITE}/api/files`, {
      method: "POST",
      headers: { ...tab("scans"), "content-type": "application/pdf" },
      body: scan,
    });
    const { file, sidecar } = (await res.json()) as { file: { sha256: string }; sidecar: string };
    const base = await record("scans");
    const agent = await base.addConnection({ kind: "cli" });
    await base.setGrants(agent.id, { level: "write", sensitive: true, holdDays: 0 });
    const ask = () => base.tool({ connectionId: agent.id }, "photos", { id: sidecar });
    expect(await ask()).toMatchObject({ ok: false });

    const passkey = createAuthenticator(SITE);
    const neon = {
      credentialId: passkey.id,
      publicKey: passkey.publicKey,
      counter: 0,
      approvesAt: new Date(0).toISOString(),
      origin: SITE,
    };
    const share = (body: object) =>
      mf.dispatchFetch(`${SITE}/api/files/${file.sha256}/share`, {
        method: "POST",
        headers: {
          ...tab("scans"),
          "content-type": "application/json",
          "x-test-passkey": JSON.stringify(neon),
        },
        body: JSON.stringify(body),
      });
    const { challenge } = (await (await share({ on: true })).json()) as { challenge: string };
    expect((await share({ on: true, response: passkey.authenticate({ challenge }) })).status).toBe(200);

    // The scan's page, the JPEG the PDF holds, opened from R2: never the PDF itself.
    const answer: object = await ask();
    expect(answer).toMatchObject({ ok: true, value: { photo: { mime: "application/pdf", shared: true } } });
    const images = "images" in answer && Array.isArray(answer.images) ? answer.images : [];
    expect(images.map((image) => Buffer.from(image.data, "base64").subarray(0, 3))).toEqual([
      Buffer.from([0xff, 0xd8, 0xff]),
    ]);
    expect(images.map((image) => image.mimeType)).toEqual(["image/jpeg"]);
    expect(answer).not.toHaveProperty("left");
  });

  it("refuses changes from another origin's pages", async () => {
    const res = await mf.dispatchFetch(`${SITE}/api/files`, {
      method: "POST",
      headers: { cookie: "user=csrf", origin: USERCONTENT, "content-type": "text/plain" },
      body: TRANSCRIPT,
    });
    expect(res.status).toBe(403);
    expect(await (await mf.dispatchFetch(`${SITE}/api/files`, { headers: tab("csrf") })).json()).toEqual({
      files: [],
    });
  });
});

describe("sensitive note edits", () => {
  const ID = "01M6ADBH80DEGPEVAAVR2625V1";
  const raw = (title: string) =>
    `---\nid: ${ID}\ntype: TestScore\ntitle: ${title}\ntrf_number: "26GB001234KARN001A"\n---\nTook the test.\n`;
  const save = (user: string, body: unknown, origin = SITE) =>
    mf.dispatchFetch(`${SITE}/api/notes/${ID}`, {
      method: "POST",
      headers: { cookie: `user=${user}`, origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("go straight to the record as the person, and a stale base is a conflict, not an overwrite", async () => {
    const base = await record("sensitive");
    await base.seed([{ path: "facts/tests/ielts.md", raw: raw("IELTS"), class: "sensitive" }]);
    const saved = await save("sensitive", { raw: raw("IELTS Academic"), baseRev: 1 });
    expect(await saved.json()).toEqual({ rev: 2 });
    expect(await base.rev(ID)).toBe(2);
    expect(await base.actorOf(ID)).toBe("human");

    const stale = await save("sensitive", { raw: raw("Typed over an old copy"), baseRev: 1 });
    expect(stale.status).toBe(409);
    expect(await base.rev(ID)).toBe(2);
  });

  it("refuse another origin's pages, another record's session and a malformed body", async () => {
    const base = await record("guarded");
    await base.seed([{ path: "facts/tests/ielts.md", raw: raw("IELTS"), class: "sensitive" }]);
    expect((await save("guarded", { raw: raw("x"), baseRev: 1 }, USERCONTENT)).status).toBe(403);
    expect((await save("intruder", { raw: raw("x"), baseRev: 1 })).status).not.toBe(200);
    expect((await save("guarded", { raw: raw("x") })).status).toBe(400);
    expect(await base.rev(ID)).toBe(1);
  });
});
