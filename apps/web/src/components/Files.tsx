import { useAutoAnimate } from "@formkit/auto-animate/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { fileIcon } from "../icons.ts";
import { LIST } from "../motion.ts";
import { api, refresh, type FileItem } from "../record.ts";
import { DropZone } from "./DropZone.tsx";
import { FileBox } from "./FileBox.tsx";

/** A file's name: the person's own, or what they said it is, or that nobody has yet. */
export const fileLabel = (file: FileItem) =>
  file.name ??
  `${file.confirmed && file.kind ? file.kind : "Unclassified"} ${file.mime.split("/")[1]?.toUpperCase() ?? "file"} ${file.sha256.slice(0, 6)}`;

/**
 * A way to add a file, which opens its sidecar note, and the uploads from before files had one. Uploading one of
 * those again gives it its note.
 */
export function Files({
  files,
  selected,
  onOpen,
}: {
  readonly files: readonly FileItem[];
  readonly selected: string | undefined;
  readonly onOpen: () => void;
}) {
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [list] = useAutoAnimate<HTMLUListElement>(LIST);
  const upload = async (file: File) => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api("/api/files", {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
        },
        body: file,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "The upload failed.");
      await refresh();
      onOpen();
      await (body.sidecar
        ? navigate({ to: "/n/$noteId", params: { noteId: body.sidecar } })
        : navigate({ to: "/files/$fileId", params: { fileId: body.file.sha256 } }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The upload failed.");
    } finally {
      setBusy(false);
    }
  };
  const loose = files.filter((file) => file.path === null);
  return (
    <section className="files">
      {loose.length > 0 && <h2>Files without a note</h2>}
      <ul ref={list}>
        {loose.map((file) => {
          const FileGlyph = fileIcon(file.mime);
          return (
            <li key={file.sha256} data-class={file.class}>
              <Link
                to="/files/$fileId"
                params={{ fileId: file.sha256 }}
                aria-current={file.sha256 === selected ? "page" : undefined}
                onClick={onOpen}
              >
                <FileGlyph size={15} weight="duotone" />
                <span>{fileLabel(file)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      {files.length === 0 && <FileBox />}
      <DropZone busy={busy} onFile={(file) => void upload(file)} />
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
