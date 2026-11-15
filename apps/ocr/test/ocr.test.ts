// The real OCR Worker in workerd: Tesseract's wasm, the models and Images (sharp, locally), on fixtures made for the
// fictional fixture student (fixtures/scans). Nobody real is in them.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { ocrWorker } from "../../../scripts/ocr-worker.ts";
import type { Reading } from "../src/index.ts";

const fixture = async (name: string) =>
  new Uint8Array(await readFile(join(import.meta.dirname, "../../../fixtures/scans", name)));

// A caller in workerd, as the jobs consumer calls it: RPC from Node through Miniflare's proxy doesn't reach a
// WorkerEntrypoint's methods.
const CALLER = `export default {
  async fetch(request, env) {
    return Response.json((await env.OCR.read(new Uint8Array(await request.arrayBuffer()))) ?? null);
  },
};`;

let mf: Miniflare;
const read = async (image: Uint8Array): Promise<Reading | null> =>
  // The caller answers with `read`'s result as it is.
  (
    await mf.dispatchFetch("https://caller/", { method: "POST", body: image })
  ).json() as Promise<Reading | null>;

beforeAll(async () => {
  mf = new Miniflare({
    workers: [
      {
        name: "caller",
        modules: true,
        script: CALLER,
        compatibilityDate: "2026-07-30",
        serviceBindings: { OCR: "ocr" },
      },
      await ocrWorker(),
    ],
  });
});
afterAll(() => mf.dispose());

describe("ocr", () => {
  it("reads a photographed passport's MRZ verbatim, and its printed zone apart from it", async () => {
    const reading = await read(await fixture("passport-photo.jpg"));
    const lines = reading?.text.split("\n").map((line) => line.replaceAll(" ", ""));
    expect(lines).toContain("P<UTOKARIM<<NADIA<<<<<<<<<<<<<<<<<<<<<<<<<<<");
    expect(lines).toContain("XK12345679UTO0103141F3105043<<<<<<<<<<<<<<04");
    // The printed zone is what lies above the MRZ: the name and code as printed, nothing the MRZ says.
    expect(reading?.printed).toMatch(/KARIM[^]*NADIA/);
    expect(reading?.printed).toContain("UTO");
    expect(reading?.printed).not.toMatch(/<|XK12345679|ccc/);
  });

  it("reads text on transparent pixels as a page shows it, over white", async () => {
    // Black text on transparent black: without the alpha it is a black block, and reads as nothing.
    expect((await read(await fixture("account-transparent.png")))?.text).toContain("123456789012");
  });

  it("reads a number cropped to its edges", async () => {
    // With no white around it Tesseract found no lines at all.
    expect((await read(await fixture("iban-crop.png")))?.text).toContain("DE89370400440532013000");
  });

  it("reads nothing from bytes that aren't an image", async () => {
    expect(await read(new TextEncoder().encode("not an image"))).toBeNull();
  });
});
