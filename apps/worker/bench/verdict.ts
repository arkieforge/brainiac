// When a bench row fails (bench.ts). Alone, a p95 over its target fails. With a baseline (main's table, printed by
// its own bench on the same runner moments before, so any main that has a bench can be one), it fails only when also
// clearly slower than main there: GitHub's runners differ by half again in speed from run to run, so a slow machine
// alone never fails a PR, while a change that makes search slower still does once it pushes past the target. Slower
// is read from p50: between two runs of the same code a p95 (the 5th-slowest of 100) moves by a third, a p50 by a tenth.

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

/** Whether `row` fails: its p95 over its target, and (given main's rows) its p50 more than SLOWER times main's. */
export function overBudget(row: Row, baseline: readonly Row[] | undefined): boolean {
  if (row.p95 < row.target) return false;
  const was = baseline?.find((base) => sameCase(base, row));
  return !was || row.p50 > was.p50 * SLOWER;
}

/** The rows of a bench table as bench.ts prints it: fixed-width record, path and mode, then p50, p95 and target. */
export function parseTable(text: string): Row[] {
  return text.split("\n").flatMap((line): Row[] => {
    const mode = line.slice(25, 30).trim();
    const numbers = /^\s*([\d.]+) ms\s+([\d.]+) ms\s+([\d.]+) ms/.exec(line.slice(30));
    if ((mode !== "warm" && mode !== "cold") || !numbers) return [];
    const [, p50, p95, target] = numbers.map(Number);
    if (p50 === undefined || p95 === undefined || target === undefined) return [];
    // A number too big to be one (1e400 reads as Infinity) would make every comparison pass.
    if (![p50, p95, target].every(Number.isFinite)) return [];
    return [{ record: line.slice(0, 11).trim(), path: line.slice(12, 24).trim(), mode, p50, p95, target }];
  });
}
