import { createFileRoute } from "@tanstack/react-router";

import { FilePane } from "../components/FilePane.tsx";
import { Shell } from "../components/Shell.tsx";

export const Route = createFileRoute("/files/$fileId")({
  component: function File() {
    const { fileId } = Route.useParams();
    return (
      <Shell fileId={fileId}>
        <FilePane key={fileId} fileId={fileId} />
      </Shell>
    );
  },
});
