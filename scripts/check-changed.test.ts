import { expect, it } from "vite-plus/test";

import { testsFor } from "./check-changed.ts";

const SUITES = ["apps/worker/test/sync.test.ts", "apps/ocr/test/ocr.test.ts"];

it("adds the tests an import graph can't see, by what changed", () => {
  const plan = (path: string) => testsFor(["AGENTS.md", path], SUITES);
  expect(plan("docs/README.md")).toEqual({ all: false, bundled: [], browser: false });
  expect(plan("scripts/logs.ts")).toEqual({ all: false, bundled: [], browser: false });
  // Bundled into workerd by path.
  for (const path of ["apps/worker/src/base.ts", "apps/ocr/src/index.ts", "scripts/bundle-worker.ts"])
    expect(plan(path).bundled).toEqual(SUITES);
  // The site, and the packages it bundles.
  expect(plan("apps/web/src/components/Tree.tsx")).toEqual({ all: false, bundled: [], browser: true });
  expect(plan("packages/sync/src/client.ts")).toEqual({ all: false, bundled: SUITES, browser: true });
  // Read from disk by tests and evals.
  expect(plan("fixtures/nadia/people/dr-okafor.md").all).toBe(true);
  expect(plan("apps/cli/plugin/skills/brainiac/SKILL.md").all).toBe(true);
});
