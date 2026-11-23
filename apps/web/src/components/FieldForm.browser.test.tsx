import { parseNote } from "@brainiac/core";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render.tsx";
import { IELTS_2026, manifest, tab } from "../../test/tab.ts";
import { fieldsOf } from "../fields.ts";
import { FieldForm } from "./FieldForm.tsx";

/** Holds the save that fires once typing pauses, so the person stays mid-edit until the test moves on. */
function holdTypingTimer(): Disposable {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return { [Symbol.dispose]: () => void vi.useRealTimers() };
}

it("keeps what the person is typing when another tab's change lands, and saves it when they leave the field", async () => {
  const { client, push } = tab(IELTS_2026);
  const overallOf = () => parseNote(client.working(IELTS_2026.id) ?? "").data["overall"];
  // As NotePane does: the fields come from the tab's working copy on every render.
  const form = () => (
    <FieldForm
      fields={fieldsOf(parseNote(client.working(IELTS_2026.id) ?? "").data, manifest)}
      client={client}
      noteId={IELTS_2026.id}
      manifest={manifest}
      disabled={false}
    />
  );
  await using screen = await render(form());
  using _ = holdTypingTimer();
  const overall = screen.getByRole("textbox", { name: /^overall/ });
  await userEvent.fill(overall, "8.5");

  push(IELTS_2026, IELTS_2026.raw.replace("overall: 8.0", "overall: 7.5"));
  await screen.rerender(form());
  await expect.element(overall).toHaveValue("8.5");
  expect(overallOf()).toBe(7.5);

  // Leaving the field saves at once (vi.waitFor would advance the held timer and save it the other way).
  await userEvent.tab();
  expect(overallOf()).toBe(8.5);
});
