import { expect, it } from "vite-plus/test";

import { suitesFor } from "./check-changed.ts";

const SUITES = ["apps/worker/test/sync.test.ts", "apps/ocr/test/ocr.test.ts"];

it("runs the bundled Worker suites only when something a Worker bundles changed", () => {
  for (const path of [
    "apps/worker/src/base.ts",
    "packages/base/src/mutate.ts",
    "apps/ocr/src/index.ts",
    "scripts/bundle-worker.ts",
  ]) {
    expect(suitesFor([path], SUITES)).toEqual(SUITES);
  }
  for (const path of ["apps/web/src/components/Tree.tsx", "docs/README.md", "scripts/logs.ts"]) {
    expect(suitesFor(["AGENTS.md", path], SUITES)).toEqual([]);
  }
});
