import { describe } from "vite-plus/test";

import { ruleHarness } from "../test/harness.ts";

const rule = ruleHarness("no-test-timeout-or-retry");
// A folder per rule: the rule test files run at once, and each case writes its file.
const TEST = "no-test-timeout-or-retry/sync.test.ts";

describe("brainiac/no-test-timeout-or-retry", () => {
  rule.valid("plain test", `it("syncs", async () => {});`, TEST);
  rule.invalid("timeout as the last argument", `it("syncs", async () => {}, 30_000);`, TEST);
  rule.invalid("timeout in options", `test("syncs", { timeout: 30_000 }, async () => {});`, TEST);
  rule.invalid("retry in options", `describe("sync", { retry: 2 }, () => {});`, TEST);
  rule.invalid("on it.each", `it.each([1])("syncs %i", async () => {}, 5000);`, TEST);
  rule.valid("another call's timeout option", `execFileSync("bun", [], { timeout: 120_000 });`, TEST);
  rule.valid("a mock's retry method", `it("acks", () => { queue({ retry: () => {} }); });`, TEST);
  rule.valid(
    "outside a test file",
    `it("syncs", async () => {}, 30_000);`,
    "no-test-timeout-or-retry/e2e.ts",
  );
});
