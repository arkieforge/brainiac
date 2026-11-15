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
 * Whether an eval whose cases all grade one shared run needs another sample: once `samples` ran, a 3rd when a
 * case that isn't strict has disagreeing results.
 */
export const another = (
  sample: number,
  samples: number,
  cases: readonly { readonly id: string; readonly strict: boolean }[],
  rows: readonly { readonly case: string; readonly ok: boolean }[],
) =>
  sample <= samples ||
  (sample === samples + 1 &&
    cases.some((c) => !c.strict && new Set(rows.filter((r) => r.case === c.id).map((r) => r.ok)).size > 1));

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
