import { describe } from "vite-plus/test";

import { ruleHarness } from "../test/harness.ts";

const rule = ruleHarness("no-cross-app-import");
const inWeb = "apps/web/src/page.ts";

describe("brainiac/no-cross-app-import", () => {
  rule.valid("a package", `import { merge } from "@brainiac/core";`, inWeb);
  rule.valid("its own app", `import { x } from "./x.ts";`, inWeb);
  rule.valid("outside apps and packages", `import { x } from "../apps/worker/src/x.ts";`, "scripts/x.ts");
  rule.invalid("another app by name", `import { x } from "@brainiac/worker";`, inWeb);
  rule.invalid("another app by path", `import { x } from "../../worker/src/x.ts";`, inWeb);
  rule.invalid("a re-export", `export * from "../../cli/src/x.ts";`, inWeb);
  rule.invalid("a dynamic import", `await import("@brainiac/cli/src/x.ts");`, inWeb);
  rule.invalid("a package importing an app", `import { x } from "@brainiac/web";`, "packages/core/src/x.ts");
});
