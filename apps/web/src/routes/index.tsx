import { createFileRoute } from "@tanstack/react-router";

import { Shell } from "../components/Shell.tsx";

export const Route = createFileRoute("/")({
  component: () => (
    <Shell>
      <p className="empty">Pick a note or a file.</p>
    </Shell>
  ),
});
