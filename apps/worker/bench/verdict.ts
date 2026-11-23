// When a bench row fails (bench.ts). Alone, a p95 over its target fails. With a baseline (main, run by CI on the same
// runner moments before), it fails only when also clearly slower than main there: GitHub's runners differ by half
// again in speed from run to run, so a slow machine alone never fails a PR, while a change that makes search slower
// still does once it pushes past the target.

/** One bench row: a record, a path and warm or cold, with its p50 and p95 and the target its p95 must stay under. */
export interface Row {
  readonly record: string;
  readonly path: string;
  readonly mode: "warm" | "cold";
  readonly p50: number;
  readonly p95: number;
  readonly target: number;
}

/** How much slower than main's p95, on the same runner, counts as the change's doing rather than noise. */
export const SLOWER = 1.2;

export const sameCase = (a: Row, b: Row) => a.record === b.record && a.path === b.path && a.mode === b.mode;

/** Whether `row` fails: over its target, and (given main's rows) more than SLOWER times main's p95 too. */
export function overBudget(row: Row, baseline: readonly Row[] | undefined): boolean {
  if (row.p95 < row.target) return false;
  const was = baseline?.find((base) => sameCase(base, row));
  return !was || row.p95 > was.p95 * SLOWER;
}
