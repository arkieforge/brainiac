import { expect, it } from "vite-plus/test";

import { unproved } from "./prove-scenario.ts";

const AT = "the overview lists her record";

it("proves a fix only when the base fails at the step that shows the bug and the fix passes", () => {
  const pass = { name: "seeded-record" };
  const atStep = { name: "seeded-record", failure: `${AT}: timed out`, step: AT };
  expect(unproved(pass, atStep, AT)).toBeUndefined();
  expect(unproved(pass, pass, AT)).toMatch(/passes on the base too/);
  expect(unproved(atStep, atStep, AT)).toMatch(/fails on the fix/);
  // A base that never got past its seed or sign-in says nothing about the bug.
  const inSetup = { name: "seeded-record", failure: "seed the record: /dev/seed answered 404" };
  expect(unproved(pass, inSetup, AT)).toMatch(/before its first step/);
  // Nor does one that failed at some other step.
  const elsewhere = { ...atStep, step: "a test score opens as a sensitive note" };
  expect(unproved(pass, elsewhere, AT)).toMatch(/not at "the overview lists her record"/);
});
