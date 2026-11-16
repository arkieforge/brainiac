import { createFileRoute } from "@tanstack/react-router";

import { Proposals } from "../components/Proposals.tsx";
import { Shell } from "../components/Shell.tsx";

export const Route = createFileRoute("/proposals")({
  component: () => (
    <Shell>
      <Proposals />
    </Shell>
  ),
});
