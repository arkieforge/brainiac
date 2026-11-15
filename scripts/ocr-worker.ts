// The OCR Worker (apps/ocr) as Miniflare runs it, for its tests and the main Worker's: its bundle, Tesseract's wasm
// as a compiled module, the models as its assets, and Images backed by sharp locally.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import { bundleWorker } from "./bundle-worker.ts";

const WASM = "tesseract-wasm/tesseract-core.wasm";
const OCR = join(import.meta.dirname, "../apps/ocr");

export async function ocrWorker() {
  // Resolved from the OCR Worker, which depends on tesseract-wasm.
  const require = createRequire(join(OCR, "package.json"));
  return {
    name: "ocr",
    modules: [
      {
        type: "ESModule" as const,
        path: "index.js",
        contents: await bundleWorker(join(OCR, "src/index.ts")),
      },
      { type: "CompiledWasm" as const, path: WASM, contents: await readFile(require.resolve(WASM)) },
    ],
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    assets: { directory: join(OCR, "models"), binding: "ASSETS" },
    images: { binding: "IMAGES" },
  };
}
