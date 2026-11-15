import { Dialog } from "@base-ui/react/dialog";
import { parseNote } from "@brainiac/core";
import { House, Question, SealCheck, type Icon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { motion } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";

import { typeIcon } from "../icons.ts";
import { SPRING } from "../motion.ts";
import { notesOf, useRecord } from "../record.ts";

const PAGES = [
  { to: "/", label: "Overview", icon: House },
  { to: "/review", label: "Review", icon: SealCheck },
  { to: "/questions", label: "Questions", icon: Question },
] as const satisfies readonly { to: string; label: string; icon: Icon }[];

/** A note's title and type, from its front-matter; the path stands in when it can't be read. */
const summaryOf = (raw: string, path: string) => {
  try {
    const { title, type } = parseNote(raw).data;
    return { title: typeof title === "string" ? title : path, type: typeof type === "string" ? type : "" };
  } catch {
    return { title: path, type: "" };
  }
};

/** One row; the highlight is a single shared shape that glides to whichever row is selected. */
function Row({
  value,
  selected,
  index,
  onSelect,
  children,
}: {
  readonly value: string;
  readonly selected: boolean;
  readonly index: number;
  readonly onSelect: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Command.Item value={value} onSelect={onSelect} style={{ "--i": Math.min(index, 10) }}>
      {selected && <motion.span layoutId="palette-hl" className="palette-hl" transition={SPRING} />}
      {children}
    </Command.Item>
  );
}

/** What ⌘K lists: the pages, then every note this tab holds, by title. Mounted only while the palette is open. */
function Results({ close }: { readonly close: () => void }) {
  const { client } = useRecord();
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  // Read once per opening: the palette is short-lived, and parsing every note on each key press is wasted work.
  const notes = useMemo(
    () => notesOf(client).map((note) => ({ ...note, ...summaryOf(note.raw, note.path) })),
    [client],
  );
  return (
    <Command label="Go to" loop value={value} onValueChange={setValue}>
      <Command.Input placeholder="Go to a note or page" autoFocus />
      <Command.List>
        <Command.Empty>No note or page by that name.</Command.Empty>
        <Command.Group heading="Pages">
          {PAGES.map((page, index) => (
            <Row
              key={page.to}
              value={page.label}
              index={index}
              selected={value === page.label}
              onSelect={() => {
                close();
                void navigate({ to: page.to });
              }}
            >
              <page.icon size={15} />
              <span>{page.label}</span>
            </Row>
          ))}
        </Command.Group>
        <Command.Group heading="Notes">
          {notes.map((note, index) => {
            const NoteIcon = typeIcon(note.type);
            const rowValue = `${note.title} ${note.path}`;
            return (
              <Row
                key={note.id}
                value={rowValue}
                index={index + PAGES.length}
                selected={value === rowValue}
                onSelect={() => {
                  close();
                  void navigate({ to: "/n/$noteId", params: { noteId: note.id } });
                }}
              >
                <NoteIcon size={15} weight="duotone" />
                <span>{note.title}</span>
                <span className="path">{note.path}</span>
              </Row>
            );
          })}
        </Command.Group>
      </Command.List>
      <footer className="palette-keys">
        <span>
          <kbd>↑↓</kbd> move
        </span>
        <span>
          <kbd>↵</kbd> open
        </span>
        <span>
          <kbd>esc</kbd> close
        </span>
      </footer>
    </Command>
  );
}

/** ⌘K: jump to any note by title, or to a page. Titles come from this tab's copy, so it works offline. */
export function Palette({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="palette-backdrop" />
        <Dialog.Popup className="palette" aria-label="Go to">
          <Results close={() => onOpenChange(false)} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
