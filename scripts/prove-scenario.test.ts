import { expect, it } from "vite-plus/test";

import { verdict } from "./prove-scenario.ts";

it("proves a fix only when the scenario fails on the base and passes on the fix", () => {
  const pass = { name: "seeded-record" };
  const fail = { name: "seeded-record", failure: "open the note: timed out" };
  expect(verdict(pass, fail)).toBeUndefined();
  expect(verdict(pass, pass)).toMatch(/passes on the base too/);
  expect(verdict(fail, fail)).toMatch(/fails on the fix too/);
  expect(verdict(fail, pass)).toMatch(/fails on the fix too/);
});
