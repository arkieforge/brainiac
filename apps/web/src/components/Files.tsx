import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { api, refresh, type FileItem } from "../record.ts";

/** A file's name in lists: what the person said it is, or that nobody has yet. */
export const fileLabel = (file: FileItem) =>
  `${file.confirmed && file.kind ? file.kind : "Unclassified"} ${file.mime.split("/")[1]?.toUpperCase() ?? "file"} ${file.sha256.slice(0, 6)}`;

/** The record's uploads, and a way to add one. */
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
  const upload = async (file: File) => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api("/api/files", {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "The upload failed.");
      await refresh();
      onOpen();
      await navigate({ to: "/files/$fileId", params: { fileId: body.file.sha256 } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The upload failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="files">
      <h2>Files</h2>
      <ul>
        {files.map((file) => (
          <li key={file.sha256}>
            <Link
              to="/files/$fileId"
              params={{ fileId: file.sha256 }}
              aria-current={file.sha256 === selected ? "page" : undefined}
              onClick={onOpen}
            >
              {fileLabel(file)}
            </Link>
          </li>
        ))}
      </ul>
      <label className="small">
        {busy ? "Uploading…" : "Upload a file"}
        <input
          type="file"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void upload(file);
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
