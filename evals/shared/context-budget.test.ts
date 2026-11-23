// The context budget: what every agent session loads from Brainiac before it does anything (each tool's
// description and schema, and the agent skill), in characters, kept in evals/context-budget.json. This test keeps
// that file equal to what the code measures, so the file can't drift; the context-budget workflow fails a PR that
// raises the total above main's, unless a maintainer adds the `context-increase` label. After a change, refresh
// the file with `vp test run evals/shared/context-budget.test.ts -u` and say in the PR why it grew.
import { expect, it } from "vite-plus/test";

import { toolTexts } from "./cli.ts";
import { SKILL } from "./world.ts";

it("matches the measured context", async () => {
  const parts: Record<string, number> = Object.fromEntries(
    Object.entries({ ...toolTexts(), "SKILL.md": SKILL })
      .map(([part, text]) => [part, text.length] as const)
      .toSorted(([a], [b]) => a.localeCompare(b)),
  );
  const total = Object.values(parts).reduce((sum, chars) => sum + chars, 0);
  await expect(`${JSON.stringify({ total, parts }, null, 2)}\n`).toMatchFileSnapshot(
    "../context-budget.json",
  );
});
