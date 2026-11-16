// The release gates in docs/operations/quality-bar.md#release-gates that an eval run checks: a run that misses a
// floor fails the way a failing case does, and its summary says which gate and by how much.

export interface Gate {
  readonly name: string;
  readonly floor: string;
  readonly measured: string;
  readonly ok: boolean;
}

/** The floors from the quality bar, so an eval quotes them rather than its own copy. */
export const FLOORS = { answerability: 0.95, toolUse: 0.9 } as const;

/** A share of samples that must reach `floor`. Nothing measured fails: a run that skipped every sample proves nothing. */
export const atLeast = (name: string, floor: number, passed: number, of: number): Gate => ({
  name,
  floor: `>= ${floor}`,
  measured: of === 0 ? "nothing measured" : `${(passed / of).toFixed(2)} (${passed}/${of})`,
  ok: of > 0 && passed / of >= floor,
});

/** Exact-value and canary cases: any failing sample fails the gate. */
export const noFailing = (name: string, failing: number, of: number): Gate => ({
  name,
  floor: "no failing sample",
  measured: of === 0 ? "nothing measured" : `${failing}/${of} failing`,
  ok: of > 0 && failing === 0,
});

/** The summary's gate table. */
export const gateTable = (gates: readonly Gate[]) => [
  "| gate | floor | measured | verdict |",
  "| --- | --- | --- | --- |",
  ...gates.map((g) => `| ${g.name} | ${g.floor} | ${g.measured} | ${g.ok ? "pass" : "FAIL"} |`),
];
