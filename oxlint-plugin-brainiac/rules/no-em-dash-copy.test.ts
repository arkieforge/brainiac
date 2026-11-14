// oxlint-disable brainiac/no-em-dash-copy -- the fixtures below must contain em dashes.
import { describe } from "vite-plus/test";

import { ruleHarness } from "../test/harness.ts";

const rule = ruleHarness("no-em-dash-copy");

describe("brainiac/no-em-dash-copy", () => {
  rule.valid("comments may use em dashes", `// Parses titles like "Issue — Browser".\nexport const a = 1;`);
  rule.valid("hyphens and en dashes", `export const label = "Retry failed - try 1–2";`);
  rule.invalid("string literal", `export const label = "Refresh failed — retry";`);
  rule.invalid("template literal", "export const label = (n: string) => `${n} — done`;");
});
