import { createFileRoute } from "@tanstack/react-router";

// A placeholder until the viewer and editor (#16) bring the real screens.
export const Route = createFileRoute("/")({
  component: () => <main>Brainiac</main>,
});
