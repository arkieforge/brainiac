// The test harness (test/harness.ts) as bench.ts loads it into workerd, with embeddings as wide as bge-m3's. The
// harness's stand-in makes 4 numbers, and search reads and compares every stored vector, so a narrow one would leave
// most of a real search's cost out.
import { quantize, type ChunkInput } from "@brainiac/base";

import { TestBase } from "../test/harness.ts";

export { default } from "../test/harness.ts";

/** bge-m3's width (`EMBED_MODEL`). */
const DIMS = 1024;

/** A vector `DIMS` wide, the same for the same text. Its values are noise: only its width changes what search costs. */
function embedding(text: string): number[] {
  let x = 2166136261;
  for (let i = 0; i < text.length; i++) x = Math.imul(x ^ text.charCodeAt(i), 16777619);
  x ||= 1;
  return Array.from({ length: DIMS }, () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 31 - 1;
  });
}

export class BenchBase extends TestBase {
  /** Questions, embedded at the real width. */
  protected override models() {
    return {
      run: async (_model: string, inputs: { text: string[] }) => ({ data: inputs.text.map(embedding) }),
    };
  }

  /** The consumer's chunks, re-embedded at the real width as they install, through the record's own install. */
  override installIndex(jobId: string, chunks: readonly ChunkInput[]): "installed" | "dropped" {
    return super.installIndex(
      jobId,
      chunks.map((chunk) => (chunk.vector ? { ...chunk, vector: quantize(embedding(chunk.text)) } : chunk)),
    );
  }
}
