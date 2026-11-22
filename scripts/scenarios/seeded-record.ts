import type { Scenario } from "./scenario.ts";

// A new dev account opens on the fixture student's record (scripts/dev-auth.ts seeds it), not an empty one: the
// overview lists her notes, the newer IELTS score supersedes the older, and a note opens with its fields.
export default {
  next: "/",
  steps: [
    {
      name: "the overview lists her record",
      run: async (page) => {
        await page.getByText("IELTS Academic, November 2026").waitFor();
        await page.getByText("TUM MSc Informatics, Winter 2027").waitFor();
        await page.getByText("superseded", { exact: true }).waitFor();
      },
    },
    {
      name: "a test score opens as a sensitive note",
      run: async (page) => {
        await page.getByText("IELTS Academic, November 2026").click();
        await page.waitForURL(/\/n\//);
        await page.getByText("facts/tests/ielts-2026-11.md", { exact: true }).waitFor();
        await page.getByText("sensitive", { exact: true }).waitFor();
      },
    },
  ],
} satisfies Scenario;
