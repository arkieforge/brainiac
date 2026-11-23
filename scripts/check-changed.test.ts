import { expect, it } from "vite-plus/test";

import { testsFor } from "./check-changed.ts";

const SUITES = ["apps/worker/test/sync.test.ts", "apps/ocr/test/ocr.test.ts"];

it("adds the tests an import graph can't see, by what changed", () => {
  const plan = (path: string) => testsFor(["AGENTS.md", path], SUITES);
  const none = { all: false, lintAll: false, bundled: [], browser: false };
  expect(plan("docs/README.md")).toEqual(none);
  expect(plan("scripts/logs.ts")).toEqual(none);
  // Bundled into workerd by path.
  for (const path of ["apps/worker/src/base.ts", "apps/ocr/src/index.ts", "scripts/bundle-worker.ts"])
    expect(plan(path).bundled).toEqual(SUITES);
  // The site, and the packages it bundles.
  expect(plan("apps/web/src/components/Tree.tsx")).toEqual({ ...none, browser: true });
  expect(plan("packages/sync/src/client.ts")).toEqual({ ...none, bundled: SUITES, browser: true });
  // Read from disk by tests and evals, and imported by the browser tests.
  expect(plan("fixtures/nadia/people/dr-okafor.md")).toEqual({ ...none, all: true, browser: true });
  expect(plan("apps/cli/plugin/skills/brainiac/SKILL.md").all).toBe(true);
  // New or changed lint rules judge every file.
  expect(plan("oxlint-plugin-brainiac/rules/no-em-dash-copy.ts").lintAll).toBe(true);
  expect(plan("vite.config.ts").lintAll).toBe(true);
});
