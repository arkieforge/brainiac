import { parseNote, pathKey, PathError, resolveFile } from "@brainiac/core";
import type { SyncClient } from "@brainiac/sync";
import { TextMorph } from "torph/react";

import { approvePlan } from "../approve.ts";
import { fieldsOf } from "../fields.ts";
import { OFFLINE_SENSITIVE, useRecord, type FileItem } from "../record.ts";
import { ApproveButton, Plan } from "./Approval.tsx";
import { BodyEditor } from "./BodyEditor.tsx";
import { CheckProfiles, NoteDrift } from "./Drift.tsx";
import { FieldForm } from "./FieldForm.tsx";
import { FileFacts, FileView, KindForm, ShareForm, showable } from "./FilePane.tsx";
import { fileLabel } from "./Files.tsx";
import { MoveForm } from "./MoveForm.tsx";
import { titleTransition } from "./Overview.tsx";
import { Pip } from "./Pip.tsx";

/** The stored file a note's `file:` names, resolved from the note's own folder, as the record resolves it. */
function fileOf(files: readonly FileItem[], path: string, file: unknown): FileItem | undefined {
  if (typeof file !== "string") return undefined;
  let key: string;
  try {
    key = pathKey(resolveFile(path, file));
  } catch (error) {
    if (error instanceof PathError) return undefined;
    throw error;
  }
  return files.find((f) => f.path !== null && pathKey(f.path) === key);
}

/** Whether this note's edits have reached the record, and what to do about one that won't. */
function SyncState({ client, noteId }: { readonly client: SyncClient; readonly noteId: string }) {
  const blocked = client.state.blocked.get(noteId);
  const plan = blocked?.at(-1)?.needsApproval;
  if (plan)
    return (
      <div className="sync-state warn approval" role="status">
        <p>Not synced: this edit needs your passkey. Approving lets exactly this through:</p>
        <Plan items={plan.items} />
        <ApproveButton
          approve={async () => {
            const approved = await approvePlan(plan.planHash, plan.items);
            if ("error" in approved) return approved;
            client.approved(noteId, plan.planHash, approved.approvalId);
            return undefined;
          }}
        />{" "}
        <button type="button" onClick={() => client.dismiss(noteId)}>
          Keep the record's version
        </button>
      </div>
    );
  if (blocked?.length)
    return (
      <p className="sync-state warn" role="status">
        Not synced: {blocked.at(-1)?.reason}.{" "}
        <button type="button" onClick={() => client.dismiss(noteId)}>
          Keep the record's version
        </button>
      </p>
    );
  const pending = client.state.pending.some((p) => p.noteId === noteId);
  return (
    <p className="sync-state muted" role="status">
      <TextMorph duration={260} ease="cubic-bezier(0.23, 1, 0.32, 1)">
        {pending ? "Saving…" : "Saved"}
      </TextMorph>
    </p>
  );
}

/** One note: its type and title, its fields beside its body (and its file, for a sidecar), editable. */
export function NotePane({ noteId }: { readonly noteId: string }) {
  const { client, manifest, status, files } = useRecord();
  const raw = client?.working(noteId);
  const remote = client?.state.remote.get(noteId);
  if (!client || raw === undefined || !remote)
    return (
      <div className="empty">
        {status === "loading" || status === "connecting" ? (
          <Pip sticker="thinking" say="Loading…" />
        ) : (
          <Pip sticker="detective" say="No such note. It may have moved or been deleted." />
        )}
      </div>
    );
  let data: Readonly<Record<string, unknown>>;
  try {
    data = parseNote(raw).data;
  } catch (error) {
    return <p className="empty error">This note's front-matter can't be read: {String(error)}</p>;
  }
  const title = typeof data["title"] === "string" ? data["title"] : remote.path;
  // A sensitive note's edits save online only (fields.ts, `savesOnline`), so offline it can only be read.
  const readOnly = remote.class === "sensitive" && status !== "live";
  const file = fileOf(files, remote.path, data["file"]);
  return (
    <article className="note">
      <header className="pane-head">
        <div className="path">{remote.path}</div>
        <h1 style={titleTransition(noteId)}>{title}</h1>
        <span className="badge">{typeof data["type"] === "string" ? data["type"] : "No type"}</span>
        {remote.class === "sensitive" && <span className="badge sensitive">sensitive</span>}
        <SyncState client={client} noteId={noteId} />
        {readOnly && <p className="sync-state warn">{OFFLINE_SENSITIVE}</p>}
        {data["type"] === "Profile" && <CheckProfiles />}
        <NoteDrift client={client} manifest={manifest} noteId={noteId} />
        {file && (
          <div className="file-facts">
            <span className="small">{fileLabel(file)}</span> <FileFacts file={file} />
          </div>
        )}
      </header>
      <div className="note-grid">
        <div className="note-main">
          {file && <FileView file={file} />}
          <BodyEditor key={noteId} client={client} noteId={noteId} readOnly={readOnly} />
        </div>
        <div className="note-side">
          <MoveForm
            key={`${noteId} ${remote.path}`}
            noteId={noteId}
            path={remote.path}
            rev={remote.rev}
            paths={[...client.state.remote.values()].map((note) => note.path)}
            online={status === "live"}
          />
          {file && <KindForm key={file.sha256} file={file} />}
          {file && showable(file) && <ShareForm file={file} />}
          <FieldForm
            fields={fieldsOf(data, manifest)}
            client={client}
            noteId={noteId}
            manifest={manifest}
            disabled={readOnly}
          />
        </div>
      </div>
    </article>
  );
}
