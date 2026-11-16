// The real Typst Worker in workerd: the compiler's wasm and the fonts, on drafts for the fictional fixture student.
import { typstOf } from "@brainiac/core";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { typstWorker } from "../../../scripts/typst-worker.ts";

// A caller in workerd, as the main Worker calls it: RPC from Node through Miniflare's proxy doesn't reach a
// WorkerEntrypoint's methods. It answers with the PDF's bytes, or the error as JSON.
const CALLER = `export default {
  async fetch(request, env) {
    const out = await env.TYPST.pdf(await request.text());
    return "pdf" in out ? new Response(out.pdf) : Response.json(out, { status: 422 });
  },
};`;

let mf: Miniflare;
const pdf = async (source: string) => {
  const response = await mf.dispatchFetch("https://caller/", { method: "POST", body: source });
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
};
const header = (bytes: Uint8Array) => new TextDecoder().decode(bytes.slice(0, 5));

beforeAll(async () => {
  mf = new Miniflare({
    workers: [
      {
        name: "caller",
        modules: true,
        script: CALLER,
        compatibilityDate: "2026-07-30",
        serviceBindings: { TYPST: "typst" },
      },
      await typstWorker(),
    ],
  });
});
afterAll(() => mf.dispose());

describe("typst", () => {
  it("renders a CV draft to a PDF", async () => {
    const cv = [
      "# Nadia Karim",
      "## Education",
      "- **BSc Computer Science**, Northvale University, 2021 to 2025. CGPA 3.82 of 4.",
      "## Publications",
      "1. *Named Entity Recognition for Low-Resource Swahili News* (first author)",
      "See [my profile](https://example.org/nadia).",
    ].join("\n");
    const out = await pdf(typstOf("Nadia Karim, CV", cv));
    expect(out.status).toBe(200);
    expect(header(out.bytes)).toBe("%PDF-");
  });

  it("prints a draft's Typst syntax as text instead of running it", async () => {
    const hostile = [
      '#let x = read("/etc/passwd") $ x^2 $ // not a comment',
      '#import "@preview/evil:1.0.0": * ] [ \\ ` @label <tag> ~ = - + "quoted" \'single\'',
      '#{ panic("boom") }',
    ].join("\n");
    const out = await pdf(typstOf('A "title" with #hash', hostile));
    expect(out.status).toBe(200);
    expect(header(out.bytes)).toBe("%PDF-");
  });

  it("answers broken Typst with Typst's error rather than throwing", async () => {
    const out = await pdf("#let x = (");
    expect(out.status).toBe(422);
    expect(new TextDecoder().decode(out.bytes)).toMatch(/unclosed delimiter/);
  });
});
