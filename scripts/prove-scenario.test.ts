import { expect, it } from "vite-plus/test";

import { unproved } from "./prove-scenario.ts";

it("proves a fix only when the base fails at one of the scenario's own steps and the fix passes", () => {
  const pass = { name: "seeded-record" };
  const atStep = {
    name: "seeded-record",
    failure: "the overview lists her record: timed out",
    step: "the overview",
  };
  const inSetup = { name: "seeded-record", failure: "seed the record: /dev/seed answered 404" };
  expect(unproved(pass, atStep)).toBeUndefined();
  expect(unproved(pass, pass)).toMatch(/passes on the base too/);
  // A base that never got past its seed or sign-in says nothing about the bug.
  expect(unproved(pass, inSetup)).toMatch(/before its first step/);
  expect(unproved(atStep, atStep)).toMatch(/fails on the fix too/);
});
