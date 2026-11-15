import { createFileRoute } from "@tanstack/react-router";

import { Review } from "../components/Review.tsx";
import { Shell } from "../components/Shell.tsx";

export const Route = createFileRoute("/review")({
  component: () => (
    <Shell>
      <Review />
    </Shell>
  ),
});
