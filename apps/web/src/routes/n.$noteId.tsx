import { createFileRoute } from "@tanstack/react-router";

import { NotePane } from "../components/NotePane.tsx";
import { Shell } from "../components/Shell.tsx";

// A note's id may be in the URL; the record never is (the session names it).
export const Route = createFileRoute("/n/$noteId")({
  component: function Note() {
    const { noteId } = Route.useParams();
    return (
      <Shell noteId={noteId}>
        <NotePane key={noteId} noteId={noteId} />
      </Shell>
    );
  },
});
