// `brainiac photos`: the photos waiting in unorganized/ for this device's connection to file (the `photos` tool's
// list), and which ones the person let their Claude see. Online only, like `brainiac questions`: photos stay in
// the cloud, and a laptop copy never holds an unclassified one.
import { type } from "arktype";

const Photo = type({ id: "string", path: "string", "uploaded?": "string | null", shared: "boolean" });
const Listed = type({ photos: Photo.array(), "message?": "string" });

/** The lines `brainiac photos` prints: each waiting photo's note, and what to do next. */
export function photosReport(answer: unknown, server: string): string[] {
  const { photos, message } = Listed.assert(answer);
  if (message !== undefined) return [message];
  if (photos.length === 0) return ["No photos wait in unorganized/."];
  const hidden = photos.filter((photo) => !photo.shared).length;
  return [
    ...photos.map(
      (photo) => `${photo.shared ? "shared " : "private"}  ${photo.uploaded ?? "          "}  ${photo.path}`,
    ),
    "Ask your Claude to file the shared ones (the photos tool).",
    ...(hidden > 0
      ? [
          `${hidden} aren't shared: open them at ${new URL("/", server).toString()} to let your Claude see them.`,
        ]
      : []),
  ];
}
