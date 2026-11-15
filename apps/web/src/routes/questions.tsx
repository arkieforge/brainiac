import { createFileRoute } from "@tanstack/react-router";

import { Questions } from "../components/Questions.tsx";
import { Shell } from "../components/Shell.tsx";

export const Route = createFileRoute("/questions")({
  component: () => (
    <Shell>
      <Questions />
    </Shell>
  ),
});
