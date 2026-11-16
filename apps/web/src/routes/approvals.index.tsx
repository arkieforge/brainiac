import { createFileRoute } from "@tanstack/react-router";

import { Approvals } from "../components/Approvals.tsx";
import { Shell } from "../components/Shell.tsx";

export const Route = createFileRoute("/approvals/")({
  component: () => (
    <Shell>
      <Approvals />
    </Shell>
  ),
});
