import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render.tsx";
import { IELTS_2026 } from "../../test/tab.ts";
import { Palette } from "./Palette.tsx";

// The palette lists what this tab holds: here the fixture student's two IELTS scores.
vi.mock(import("../record.ts"), async (importOriginal) => {
  const fixture = await import("../../test/tab.ts");
  const { client } = fixture.tab(fixture.IELTS_2025, fixture.IELTS_2026);
  return {
    ...(await importOriginal()),
    useRecord: () => ({
      status: "live",
      client,
      manifest: null,
      files: [],
      schemaLoaded: true,
      proposals: [],
    }),
  };
});

it("opens on the search, and the keyboard alone picks a note by title and opens it", async () => {
  const onOpenChange = vi.fn();
  await using screen = await render(<Palette open onOpenChange={onOpenChange} />);
  await expect.element(page.getByRole("combobox", { name: "Go to" })).toHaveFocus();
  // Typed into whatever has focus, as the person would right after ⌘K.
  await userEvent.keyboard("ielts");
  await expect
    .element(page.getByRole("option", { name: /March 2025/ }))
    .toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{ArrowDown}");
  await expect
    .element(page.getByRole("option", { name: /November 2026/ }))
    .toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(screen.router.state.location.pathname).toBe(`/n/${IELTS_2026.id}`));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
