import { describe } from "vite-plus/test";

import { ruleHarness } from "../test/harness.ts";

const rule = ruleHarness("no-real-time-in-tests");
// A folder per rule: the rule test files run at once, and each case writes its file.
const TEST = "no-real-time-in-tests/sync.test.ts";

describe("brainiac/no-real-time-in-tests", () => {
  rule.valid("awaiting the event", `it("syncs", async () => { await synced; });`, TEST);
  rule.valid("fake timers", `it("ticks", () => { vi.advanceTimersByTime(1000); });`, TEST);
  rule.invalid("a sleep", `it("syncs", async () => { await new Promise((r) => setTimeout(r, 50)); });`, TEST);
  rule.invalid("a sleep helper", `it("syncs", async () => { await sleep(50); });`, TEST);
  rule.invalid(
    "Playwright's fixed wait",
    `it("loads", async () => { await page.waitForTimeout(500); });`,
    TEST,
  );
  rule.invalid(
    "a frame wait",
    `it("opens", async () => { await new Promise(requestAnimationFrame); });`,
    TEST,
  );
  rule.invalid(
    "timing itself",
    `it("is fast", () => { const t = performance.now(); expect(t).toBe(t); });`,
    TEST,
  );
  rule.invalid(
    "an animation's end",
    `it("closes", () => { el.addEventListener("transitionend", done); });`,
    "no-real-time-in-tests/Palette.browser.test.tsx",
  );
  rule.valid(
    "outside a test file",
    `await new Promise((r) => setTimeout(r, 50));`,
    "no-real-time-in-tests/e2e.ts",
  );
});
