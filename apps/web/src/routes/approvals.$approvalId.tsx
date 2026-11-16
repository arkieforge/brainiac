import { createFileRoute } from "@tanstack/react-router";

import { Approvals } from "../components/Approvals.tsx";
import { Shell } from "../components/Shell.tsx";

// The id names a plan the record keeps; the page loads that plan from the record, never from the URL.
export const Route = createFileRoute("/approvals/$approvalId")({
  component: function Approval() {
    const { approvalId } = Route.useParams();
    return (
      <Shell>
        <Approvals key={approvalId} approvalId={approvalId} />
      </Shell>
    );
  },
});
