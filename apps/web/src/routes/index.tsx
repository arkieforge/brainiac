import { createFileRoute } from "@tanstack/react-router";

import { Overview } from "../components/Overview.tsx";
import { Shell } from "../components/Shell.tsx";

export const Route = createFileRoute("/")({
  component: () => (
    <Shell>
      <Overview />
    </Shell>
  ),
});
