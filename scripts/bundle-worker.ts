import { build, defaultClientConditions } from "vite-plus";

/**
 * Bundles a Worker entry into one ES module, as a deploy would, so tests can load it into workerd with
 * Miniflare. Cloudflare's vitest pool would do this for us, but it needs vitest 4 and the repo is on 5.
 */
export async function bundleWorker(entry: string): Promise<string> {
  const output = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      ssr: entry,
      minify: false,
      // Wasm stays an import: workerd takes it as its own module, compiled (scripts/ocr-worker.ts).
      rolldownOptions: { external: [/^node:/, /^cloudflare:/, /\.wasm$/] },
    },
    // `workerd` picks a package's Workers build, as a deploy does: pg's sockets are an empty stub without it.
    ssr: {
      noExternal: true,
      target: "webworker",
      resolve: { conditions: ["workerd", ...defaultClientConditions] },
    },
  });
  const [result] = Array.isArray(output) ? output : [output];
  const chunk = result && "output" in result ? result.output[0] : undefined;
  if (!chunk) throw new Error(`${entry} did not bundle`);
  return chunk.code;
}
