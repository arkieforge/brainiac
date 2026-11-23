// When a bench row fails (bench.ts). Alone, a p95 over its target fails. With a baseline (main's table, printed by
// its own bench on the same runner moments before, so any main that has a bench can be one), it fails only when also
// clearly slower than main there: GitHub's runners differ by half again in speed from run to run, so a slow machine
// alone never fails a PR, while a change that makes search slower still does once it pushes past the target. Between
// two runs of the same code a p50 moves by about a tenth and a p95 (the 5th-slowest of 100) by up to a third, so
// "slower" is a p50 a fifth above main's, or a p95 half again above it: a slow path only a few calls hit shows there.

/** One bench row: a record, a path and warm or cold, with its p50 and p95 and the target its p95 must stay under. */
export interface Row {
  readonly record: string;
  readonly path: string;
  readonly mode: "warm" | "cold";
  readonly p50: number;
  readonly p95: number;
  readonly target: number;
}

/** A row of main's table, named by its record and path together as printed, so any name lengths read back. */
export interface BaselineRow {
  readonly name: string;
  readonly mode: "warm" | "cold";
  readonly p50: number;
  readonly p95: number;
}

/** How far above main's, on the same runner, a p50 or a noisier p95 must be to count as the change's doing. */
export const SLOWER = { p50: 1.2, p95: 1.5 } as const;

const nameOf = (row: Row) => `${row.record} ${row.path}`;

/** Main's row for the same case as `row`, if main had it. */
export const baselineOf = (row: Row, baseline: readonly BaselineRow[] | undefined) =>
  baseline?.find((was) => was.name === nameOf(row) && was.mode === row.mode);

/** Whether `row` fails: its p95 over its target, and (given main's rows) clearly slower than main's. */
export function overBudget(row: Row, baseline: readonly BaselineRow[] | undefined): boolean {
  if (row.p95 < row.target) return false;
  const was = baselineOf(row, baseline);
  return !was || row.p50 > was.p50 * SLOWER.p50 || row.p95 > was.p95 * SLOWER.p95;
}

/** The rows of a bench table as bench.ts prints it: the record and path, the mode, then p50, p95 and target. */
export function parseTable(text: string): BaselineRow[] {
  return text.split("\n").flatMap((line): BaselineRow[] => {
    const found = /^(\S.*?)\s+(warm|cold)\s+([\d.]+) ms\s+([\d.]+) ms\s+[\d.]+ ms/.exec(line);
    if (!found) return [];
    const [, name, mode, p50, p95] = found;
    if (!name || (mode !== "warm" && mode !== "cold")) return [];
    // A run of 309 digits or more reads as Infinity, which would make every comparison pass.
    if (![p50, p95].every((n) => Number.isFinite(Number(n)))) return [];
    return [{ name: name.replaceAll(/\s+/g, " "), mode, p50: Number(p50), p95: Number(p95) }];
  });
}
