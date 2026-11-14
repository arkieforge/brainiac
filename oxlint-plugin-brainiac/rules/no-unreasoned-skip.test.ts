import { describe } from "vite-plus/test";

import { ruleHarness } from "../test/harness.ts";

const rule = ruleHarness("no-unreasoned-skip");

describe("brainiac/no-unreasoned-skip", () => {
  rule.valid("quarantined skip", `// quarantine: #12 clock drift on CI\nit.skip("syncs", () => {});`);
  rule.valid("plain test", `it("syncs", () => {});`);
  rule.invalid("skip without a reason", `it.skip("syncs", () => {});`);
  rule.invalid("describe.skip without a reason", `describe.skip("sync", () => {});`);
  rule.invalid("comment without an issue number", `// flaky\ntest.skip("syncs", () => {});`);
  rule.invalid("skip.each", `it.skip.each([1, 2])("syncs %i", () => {});`);
  rule.invalid("skipIf", `it.skipIf(process.env.CI)("syncs", () => {});`);
  rule.invalid("runIf", `test.runIf(false)("syncs", () => {});`);
  rule.valid(
    "quarantined skipIf",
    `// quarantine: #12 only fails on CI\nit.skipIf(process.env.CI)("syncs", () => {});`,
  );
  rule.valid("each without skip", `it.each([1, 2])("syncs %i", () => {});`);
});
