// Sampling and verdicts (docs/operations/quality-bar.md#evals-model-behavior-t3-codes-shape): 2 samples a case, a
// 3rd when they disagree, and a case fails when half or more fail, except a strict one (exact-value, canary,
// guard), which fails on any failing sample.

/**
 * A case's verdict from its samples: a strict case passes only if no sample failed; any other while fewer than
 * half did.
 */
export const passes = (strict: boolean, failing: number, samples: number) =>
  strict ? failing === 0 : failing * 2 < samples;

/**
 * Runs `one` `samples` times, then once more when the results disagree, unless the case is strict, whose verdict a
 * failing sample has settled already.
 */
export async function sampled<R extends { readonly ok: boolean }>(
  samples: number,
  strict: boolean,
  one: (sample: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let sample = 1; sample <= samples; sample++) results.push(await one(sample));
  if (!strict && results.some((r) => r.ok !== results[0]?.ok)) results.push(await one(samples + 1));
  return results;
}
