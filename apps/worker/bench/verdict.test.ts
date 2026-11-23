import { expect, it } from "vite-plus/test";

import { overBudget, type Row } from "./verdict.ts";

const row = (p95: number): Row => ({
  record: "20k chunks",
  path: "search",
  mode: "warm",
  p50: p95,
  p95,
  target: 150,
});

it("fails a row over its target, unless main was as slow on the same runner", () => {
  // Alone (a local run): the target decides.
  expect(overBudget(row(120), undefined)).toBe(false);
  expect(overBudget(row(160), undefined)).toBe(true);
  // A slow runner: main was just as slow there, so the PR isn't the cause.
  expect(overBudget(row(200), [row(190)])).toBe(false);
  // The PR made it slower, past the target.
  expect(overBudget(row(200), [row(120)])).toBe(true);
  // Slower than main but still under the target: fine.
  expect(overBudget(row(140), [row(90)])).toBe(false);
  // A row main didn't have is judged by its target alone.
  expect(overBudget(row(160), [{ ...row(90), path: "query" }])).toBe(true);
});
