// Typst for drafts (docs/product/features/applications.md, "CV and resume"): turns a draft's Typst source
// (packages/core/src/typst.ts) into a PDF. The main Worker calls `pdf` over RPC when the person downloads a draft or
// a packet; nothing else reaches it.
//
// Its own Worker, because the compiler is 28 MB of wasm: inside the main one it would slow every cold start.
//
// Fonts (apps/typst/fonts, served as this Worker's assets): Libertinus Serif from typst/typst-assets@v0.13.1
// (SIL Open Font License 1.1).
import { WorkerEntrypoint } from "cloudflare:workers";
// The compiler's own module, not the package's entry, whose Node shim would load the wasm with `new Function`.
import {
  initSync,
  TypstCompilerBuilder,
  type TypstCompiler,
} from "@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs";
import wasm from "@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm";

export interface Env {
  /** This Worker's assets: the fonts. */
  ASSETS: Fetcher;
}

const FONTS = ["Regular", "Bold", "Italic", "BoldItalic"].map((style) => `LibertinusSerif-${style}.otf`);

/** One compiler per isolate, built on the first call; a failed build is tried again on the next. */
let compiler: Promise<TypstCompiler> | undefined;

async function build(assets: Fetcher): Promise<TypstCompiler> {
  initSync({ module: wasm });
  const builder = new TypstCompilerBuilder();
  // No file system and no packages: a draft is one source file, and an import or a read finds nothing. The
  // compiler builds this model's functions from strings, which a Worker refuses, so a patch writes them out
  // (patches/@myriaddreamin__typst-ts-web-compiler@0.7.0.patch).
  builder.set_dummy_access_model();
  for (const font of FONTS) {
    const response = await assets.fetch(`https://assets.local/${font}`);
    if (!response.ok) throw new Error(`font ${font} is missing from this Worker's assets`);
    await builder.add_raw_font(new Uint8Array(await response.arrayBuffer()));
  }
  return builder.build();
}

/** A PDF, or why Typst refused the source. */
export type Rendered = { readonly pdf: Uint8Array } | { readonly error: string };

export default class Typst extends WorkerEntrypoint<Env> {
  /** Nothing over HTTP: Cloudflare won't take a Worker without a handler, and RPC methods don't count as one. */
  override fetch(): Response {
    return new Response("Not found", { status: 404 });
  }

  /** `source` (one Typst file) as a PDF. Calls in one isolate share the compiler, so they run one at a time. */
  async pdf(source: string): Promise<Rendered> {
    const typst = await (compiler ??= build(this.env.ASSETS).catch((error: unknown) => {
      compiler = undefined;
      throw error;
    }));
    typst.reset();
    typst.add_source("/main.typ", source);
    try {
      const out: unknown = typst.compile("/main.typ", null, "pdf", 1);
      const pdf = typeof out === "object" && out !== null && "result" in out ? out.result : undefined;
      return pdf instanceof Uint8Array ? { pdf } : { error: "Typst made no PDF" };
    } catch (error) {
      // Typst's diagnostics, as text: a draft's source is escaped, so this means a bug in typstOf, not in the draft.
      return { error: String(error).slice(0, 2000) };
    }
  }
}
