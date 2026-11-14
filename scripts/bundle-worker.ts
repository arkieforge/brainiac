import { build } from "vite-plus";

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
      rolldownOptions: { external: [/^node:/, /^cloudflare:/] },
    },
    ssr: { noExternal: true, target: "webworker" },
  });
  const [result] = Array.isArray(output) ? output : [output];
  const chunk = result && "output" in result ? result.output[0] : undefined;
  if (!chunk) throw new Error(`${entry} did not bundle`);
  return chunk.code;
}
