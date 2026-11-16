// The Typst Worker (apps/typst) as Miniflare runs it, for its tests and the main Worker's: its bundle, the compiler's
// wasm as a compiled module, and the fonts as its assets.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import { bundleWorker } from "./bundle-worker.ts";

const WASM = "@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm";
const TYPST = join(import.meta.dirname, "../apps/typst");

export async function typstWorker() {
  // Resolved from the Typst Worker, which depends on the compiler.
  const require = createRequire(join(TYPST, "package.json"));
  return {
    name: "typst",
    modules: [
      {
        type: "ESModule" as const,
        path: "index.js",
        contents: await bundleWorker(join(TYPST, "src/index.ts")),
      },
      { type: "CompiledWasm" as const, path: WASM, contents: await readFile(require.resolve(WASM)) },
    ],
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    assets: { directory: join(TYPST, "fonts"), binding: "ASSETS" },
  };
}
