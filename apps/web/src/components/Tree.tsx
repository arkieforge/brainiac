import { FileTree, useFileTree } from "@pierre/trees/react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import type { NoteView } from "../record.ts";

/** The record's folders and notes, with search; picking a note opens it. */
export function Tree({
  notes,
  selected,
  onOpen,
}: {
  readonly notes: readonly NoteView[];
  readonly selected: string | undefined;
  readonly onOpen: () => void;
}) {
  const navigate = useNavigate();
  const byPath = useRef(new Map<string, string>());
  byPath.current = new Map(notes.map((note) => [note.path, note.id]));
  const { model } = useFileTree({
    paths: notes.map((note) => note.path),
    search: true,
    density: "compact",
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    onSelectionChange: (paths) => {
      const id = byPath.current.get(paths.at(-1) ?? "");
      if (!id) return;
      onOpen();
      void navigate({ to: "/n/$noteId", params: { noteId: id } });
    },
  });
  const paths = notes.map((note) => note.path).join("\n");
  useEffect(() => {
    model.resetPaths(paths ? paths.split("\n") : []);
  }, [model, paths]);
  const selectedPath = notes.find((note) => note.id === selected)?.path;
  useEffect(() => {
    if (selectedPath) model.scrollToPath(selectedPath, { focus: false });
  }, [model, selectedPath]);
  return <FileTree model={model} className="tree" aria-label="Your record" />;
}
