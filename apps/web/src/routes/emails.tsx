import { createFileRoute } from "@tanstack/react-router";

import { Emails } from "../components/Emails.tsx";
import { Shell } from "../components/Shell.tsx";

export const Route = createFileRoute("/emails")({
  component: () => (
    <Shell>
      <Emails />
    </Shell>
  ),
});
