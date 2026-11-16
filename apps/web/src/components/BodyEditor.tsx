import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { Markdown } from "@brainiac/render";
import type { SyncClient } from "@brainiac/sync";
import { useEffect, useRef, useState } from "react";

import { BodyDraft, fromRecord, recordChange } from "../editing.ts";
import { bodyOf, type Approval } from "../fields.ts";
import { saveOnline } from "../record.ts";
import { HeldEdit } from "./Approval.tsx";

/** How long typing pauses before the body is sent: short, well inside the 300 ms an edit has to reach a tab. */
const TYPING_MS = 150;

/**
 * The note's body as markdown source (CodeMirror 6), with its preview beside it. The editor holds only the body:
 * each send is the front-matter's bytes as they were plus the edited text, never a re-serialization, made on the
 * text it was typed over (`BodyDraft`). A change from elsewhere arrives as a minimal edit to the document, so the
 * cursor and unsent typing stay.
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
  const actions = useRef<{
    retry: () => void;
    takeRecord: () => void;
    approved: (approvalId: string) => Promise<void>;
  }>(undefined);
  const [conflict, setConflict] = useState<string>();
  const [approval, setApproval] = useState<Approval>();
  const [preview, setPreview] = useState(() => bodyOf(client.working(noteId) ?? ""));
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const draft = new BodyDraft(
      client,
      noteId,
      (id, base, raw) => saveOnline(id, () => raw, base),
      (body) => show(body),
    );
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      draft.flush();
    };
    const show = (body: string | undefined) => {
      const spec = body === undefined ? undefined : recordChange(view.state, body);
      if (spec) view.dispatch(spec);
      setConflict(draft.conflict);
      setApproval(draft.approval);
    };
    const view = new EditorView({
      parent: node,
      state: EditorState.create({
        doc: draft.body,
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
            draft.type(update.state.doc.toString());
            clearTimeout(timer);
            timer = setTimeout(flush, TYPING_MS);
          }),
        ],
      }),
    });
    actions.current = {
      retry: () => draft.retry(),
      takeRecord: () => show(draft.takeRecord()),
      approved: (approvalId) => draft.approved(approvalId),
    };
    const unsubscribe = client.subscribe((ids) => {
      if (!ids.has(noteId)) return;
      // Unsent typing goes first (the draft sends it on the text it was typed over), then the record's text.
      clearTimeout(timer);
      timer = undefined;
      show(draft.fromRecord());
    });
    return () => {
      flush();
      unsubscribe();
      view.destroy();
    };
  }, [client, noteId, readOnly]);
  return (
    <div className="body">
      <div className="editor">
        <div ref={host} />
        {approval && (
          <HeldEdit
            approval={approval}
            send={async (approvalId) => {
              await actions.current?.approved(approvalId);
              return undefined;
            }}
            keep={() => actions.current?.takeRecord()}
          />
        )}
        {conflict && !approval && (
          <p role="alert">
            {conflict} Your text is still here.{" "}
            <button type="button" onClick={() => actions.current?.retry()}>
              Try again
            </button>{" "}
            <button type="button" onClick={() => actions.current?.takeRecord()}>
              Use the record's version
            </button>
          </p>
        )}
      </div>
      <div className="preview" aria-label="Preview">
        <Markdown text={preview} />
      </div>
    </div>
  );
}
