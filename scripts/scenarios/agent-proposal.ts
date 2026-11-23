import type { Scenario } from "./scenario.ts";

const ROLE = "01M6AGSCW0VCVQ4638KZVD05RK"; // fixtures/nadia/facts/roles/acme-intern-2025.md

// An agent changes a held fact (a role), which waits as a proposal; the person sees it on the site, accepts it, and
// the note carries the new value, for her and for the agent. The agent's side is scripted (agent.ts), so no model runs.
export default {
  next: "/proposals",
  steps: [
    {
      name: "an agent's change to her role waits for her",
      run: async (page, { agent }) => {
        const got = await agent.call("get", { ids: [ROLE] });
        const rev = got.ok ? revOf(got.value) : undefined;
        if (rev === undefined) throw new Error(`get answered ${JSON.stringify(got)}`);
        const updated = await agent.call("update", {
          id: ROLE,
          rev,
          set: { title_short: "Robotics intern" },
        });
        if (!updated.ok || !isProposed(updated.value))
          throw new Error(`update answered ${JSON.stringify(updated)}`);
        await page.getByText("Robotics intern", { exact: true }).waitFor();
      },
    },
    {
      name: "she accepts it, and the role has the new value",
      run: async (page, { agent }) => {
        await page.getByRole("button", { name: "Accept" }).click();
        await page.getByText("Robotics intern", { exact: true }).waitFor({ state: "detached" });
        await page.getByRole("treeitem", { name: "acme-intern-2025.md" }).click();
        await page.waitForURL(new RegExp(`/n/${ROLE}$`));
        await page
          .getByRole("textbox", { name: /^title_short/ })
          .and(page.locator('[value="Robotics intern"]'))
          .waitFor();
        const got = await agent.call("get", { ids: [ROLE] });
        if (!got.ok || !JSON.stringify(got.value).includes('"title_short":"Robotics intern"'))
          throw new Error(`the agent still reads ${JSON.stringify(got)}`);
      },
    },
  ],
} satisfies Scenario;

/** The rev `get` gives for its one note. */
function revOf(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("notes" in value) || !Array.isArray(value.notes))
    return undefined;
  const [note]: unknown[] = value.notes;
  return note && typeof note === "object" && "rev" in note && typeof note.rev === "number"
    ? note.rev
    : undefined;
}

const isProposed = (value: unknown) =>
  !!value && typeof value === "object" && "status" in value && value.status === "proposed";
