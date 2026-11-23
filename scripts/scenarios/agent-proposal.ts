import type { Agent } from "./agent.ts";
import type { Scenario } from "./scenario.ts";

const ROLE = "01M6AGSCW0VCVQ4638KZVD05RK"; // fixtures/nadia/facts/roles/acme-intern-2025.md

// An agent at propose level changes her role; the change waits as a proposal, with no time set to apply on its own,
// and the role stays as it was until she accepts it on the site. Then the role carries the new value, for her and
// for the agent. The agent's side is scripted (agent.ts), so no model runs.
export default {
  next: "/proposals",
  steps: [
    {
      name: "an agent's change to her role waits for her",
      run: async (page, { agent }) => {
        const before = await roleOf(agent);
        const updated = await agent.call("update", {
          id: ROLE,
          rev: before.rev,
          set: { title_short: "Robotics intern" },
        });
        if (!updated.ok || !isWaiting(updated.value))
          throw new Error(`update didn't wait for her: ${JSON.stringify(updated)}`);
        await page.getByText("Robotics intern", { exact: true }).waitFor();
        const meanwhile = await roleOf(agent);
        if (meanwhile.rev !== before.rev || meanwhile.titleShort !== before.titleShort)
          throw new Error(`the role changed before she decided: ${JSON.stringify(meanwhile)}`);
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
        const after = await roleOf(agent);
        if (after.titleShort !== "Robotics intern")
          throw new Error(`the agent still reads ${after.titleShort}`);
      },
    },
  ],
} satisfies Scenario;

/** The role as the agent reads it: its rev and `title_short`. */
async function roleOf(agent: Agent) {
  const got = await agent.call("get", { ids: [ROLE] });
  const notes: unknown =
    got.ok && got.value && typeof got.value === "object" && "notes" in got.value
      ? got.value.notes
      : undefined;
  const note: unknown = Array.isArray(notes)
    ? notes.find((n: unknown) => !!n && typeof n === "object" && "id" in n && n.id === ROLE)
    : undefined;
  if (!note || typeof note !== "object" || !("rev" in note) || typeof note.rev !== "number")
    throw new Error(`get answered ${JSON.stringify(got)}`);
  const fields: unknown = "fields" in note ? note.fields : undefined;
  const titleShort: unknown =
    fields && typeof fields === "object" && "title_short" in fields ? fields.title_short : undefined;
  return { rev: note.rev, titleShort };
}

/** A proposal that waits for the person: nothing will apply it on its own (`autoApplyAt` null). */
const isWaiting = (value: unknown) =>
  !!value &&
  typeof value === "object" &&
  "status" in value &&
  value.status === "proposed" &&
  "autoApplyAt" in value &&
  value.autoApplyAt === null;
