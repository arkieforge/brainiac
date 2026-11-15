import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { Markdown } from "@brainiac/render";
import type { SyncClient } from "@brainiac/sync";
import { useEffect, useRef, useState } from "react";

import { recordChange, fromRecord } from "../editing.ts";
import { bodyOf, savesOnline, withBody } from "../fields.ts";
import { saveOnline, savingOnline } from "../record.ts";

/** How long typing pauses before the body is sent: short, well inside the 300 ms an edit has to reach a tab. */
const TYPING_MS = 150;

/**
 * The note's body as markdown source (CodeMirror 6), with its preview beside it. The editor holds only the body:
 * each send is the front-matter's bytes as they were plus the edited text, never a re-serialization. An edit is
 * sent with the text it was made on as its base, so the record (and the sync client's view, which merges the same
 * way) keeps both sides when another tab or device changed the note meanwhile; a change from elsewhere arrives as
 * a minimal edit to the document, so the cursor and unsent typing stay.
 */
export function BodyEditor({
  client,
  noteId,
  readOnly,
}: {
  readonly client: SyncClient;
  readonly noteId: string;
  /** A sensitive note while offline: it saves only online (fields.ts, `savesOnline`). */
  readonly readOnly: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
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
      if (!savesOnline(client, noteId)) return client.edit(noteId, raw, base);
      // A sensitive note's body goes straight to the record; the editor keeps its text until the push lands.
      const body = view.state.doc.toString();
      void saveOnline(noteId, (latest) => withBody(latest, body)).then((failed) => {
        setError(failed);
        sync();
      });
    };
    /** Brings the editor to the record's text, keeping anything typed and not yet sent. */
    const sync = () => {
      // Unsent typing goes first, on the text it was typed over, so the merge keeps it.
      if (timer !== undefined) flush();
      // A sensitive note's own save is on its way or not pushed back yet: the editor already shows it.
      if (savesOnline(client, noteId) && savingOnline(noteId)) return;
      const working = client.working(noteId);
      if (working === undefined) return;
      shown = working;
      const spec = recordChange(view.state, bodyOf(working));
      if (spec) view.dispatch(spec);
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
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
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
      if (ids.has(noteId)) sync();
    });
    return () => {
      if (timer !== undefined) flush();
      unsubscribe();
      view.destroy();
    };
  }, [client, noteId, readOnly]);
  return (
    <div className="body">
      <div className="editor">
        <div ref={host} />
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="preview" aria-label="Preview">
        <Markdown text={preview} />
      </div>
    </div>
  );
}
