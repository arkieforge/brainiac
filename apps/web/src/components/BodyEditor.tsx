import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { Annotation, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { Markdown } from "@brainiac/render";
import type { SyncClient } from "@brainiac/sync";
import { useEffect, useRef, useState } from "react";

import { bodyOf, withBody } from "../fields.ts";

/** How long typing pauses before the body is sent: short, well inside the 300 ms an edit has to reach a tab. */
const TYPING_MS = 150;

/** Marks a change that came from the record, so it isn't sent back as the person's edit. */
const fromRecord = Annotation.define<boolean>();

/** The smallest one-range change from `before` to `after`, so the cursor maps through a remote edit. */
function change(before: string, after: string) {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let end = 0;
  while (
    end < before.length - from &&
    end < after.length - from &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  return { from, to: before.length - end, insert: after.slice(from, after.length - end) };
}

/**
 * The note's body as markdown source (CodeMirror 6), with its preview beside it. The editor holds only the body:
 * each send is the front-matter's bytes as they were plus the edited text, never a re-serialization. An edit is
 * sent with the text it was made on as its base, so the record (and the sync client's view, which merges the same
 * way) keeps both sides when another tab or device changed the note meanwhile; a change from elsewhere arrives as
 * a minimal edit to the document, so the cursor and unsent typing stay.
 */
export function BodyEditor({ client, noteId }: { readonly client: SyncClient; readonly noteId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState(() => bodyOf(client.working(noteId) ?? ""));
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    // The raw text the editor's document was last in step with: the base of the next edit.
    let shown = client.working(noteId) ?? "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      const base = shown;
      const raw = withBody(base, view.state.doc.toString());
      if (raw === base) return;
      shown = raw;
      client.edit(noteId, raw, base);
    };
    const view = new EditorView({
      parent: node,
      state: EditorState.create({
        doc: bodyOf(shown),
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": "Note body (markdown)" }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            setPreview(update.state.doc.toString());
            if (update.transactions.some((tr) => tr.annotation(fromRecord))) return;
            clearTimeout(timer);
            timer = setTimeout(flush, TYPING_MS);
          }),
        ],
      }),
    });
    const unsubscribe = client.subscribe((ids) => {
      if (!ids.has(noteId)) return;
      // Unsent typing goes first, on the text it was typed over, so the merge keeps it.
      if (timer !== undefined) flush();
      const working = client.working(noteId);
      if (working === undefined) return;
      shown = working;
      const before = view.state.doc.toString();
      const after = bodyOf(working);
      if (before !== after)
        view.dispatch({ changes: change(before, after), annotations: fromRecord.of(true) });
    });
    return () => {
      if (timer !== undefined) flush();
      unsubscribe();
      view.destroy();
    };
  }, [client, noteId]);
  return (
    <div className="body">
      <div className="editor" ref={host} />
      <div className="preview" aria-label="Preview">
        <Markdown text={preview} />
      </div>
    </div>
  );
}
