import { describe } from "vite-plus/test";

import { ruleHarness } from "../test/harness.ts";

const rule = ruleHarness("no-polling-loop-in-tests");
// A folder per rule: the rule test files run at once, and each case writes its file.
const TEST = "no-polling-loop-in-tests/sync.test.ts";

describe("brainiac/no-polling-loop-in-tests", () => {
  rule.invalid("awaiting until true", `it("syncs", async () => { while (!done()) await tick(); });`, TEST);
  rule.invalid("awaiting in the condition", `it("syncs", async () => { while (!(await done())) {} });`, TEST);
  rule.invalid("do ... while", `it("syncs", async () => { do { await tick(); } while (!done()); });`, TEST);
  rule.valid("over a list", `it("syncs", async () => { for (const n of notes) await put(n); });`, TEST);
  rule.valid("a loop that doesn't await", `it("counts", () => { let i = 0; while (i < 3) i++; });`, TEST);
  rule.valid(
    "a function it only defines",
    `it("syncs", () => { while (next()) handlers.push(async () => { await go(); }); });`,
    TEST,
  );
  rule.valid("outside a test file", `while (!done()) await tick();`, "no-polling-loop-in-tests/e2e.ts");
});
