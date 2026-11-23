import { expect, it } from "vite-plus/test";

import { overBudget, parseTable, type Row } from "./verdict.ts";

const row = (p50: number, p95 = p50): Row => ({
  record: "20k chunks",
  path: "search",
  mode: "warm",
  p50,
  p95,
  target: 150,
});

it("fails a row over its target, unless main was as slow on the same runner", () => {
  // Alone (a local run): the target decides.
  expect(overBudget(row(100, 120), undefined)).toBe(false);
  expect(overBudget(row(140, 160), undefined)).toBe(true);
  // A slow runner: main was just as slow there, so the PR isn't the cause, even with a noisy tail.
  expect(overBudget(row(185, 260), [row(180, 190)])).toBe(false);
  // The PR made it slower, past the target.
  expect(overBudget(row(170, 180), [row(110, 120)])).toBe(true);
  // Slower than main but still under the target: fine.
  expect(overBudget(row(120, 140), [row(80, 90)])).toBe(false);
  // A row main didn't have is judged by its target alone.
  expect(overBudget(row(140, 160), [{ ...row(80), path: "query" }])).toBe(true);
});

it("reads main's table back as bench.ts prints it, with or without the baseline column", () => {
  const table = [
    "record      path         mode        p50       p95    target",
    "fixture     query        warm     4.9 ms    6.3 ms   80.0 ms  PASS",
    "20k chunks  ask context  cold   201.6 ms  206.3 ms  600.0 ms  131.0 ms  PASS",
    "workerd/io/actor-sqlite.c++:1045: warning: NOSENTRY",
  ].join("\n");
  expect(parseTable(table)).toEqual([
    { record: "fixture", path: "query", mode: "warm", p50: 4.9, p95: 6.3, target: 80 },
    { record: "20k chunks", path: "ask context", mode: "cold", p50: 201.6, p95: 206.3, target: 600 },
  ]);
});
