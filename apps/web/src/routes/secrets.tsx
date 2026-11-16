import { createFileRoute } from "@tanstack/react-router";

import { Secrets } from "../components/Secrets.tsx";
import { Shell } from "../components/Shell.tsx";

export const Route = createFileRoute("/secrets")({
  component: () => (
    <Shell>
      <Secrets />
    </Shell>
  ),
});
