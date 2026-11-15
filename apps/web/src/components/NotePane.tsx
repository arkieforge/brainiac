import { parseNote } from "@brainiac/core";
import type { SyncClient } from "@brainiac/sync";

import { approvePlan } from "../approve.ts";
import { fieldsOf } from "../fields.ts";
import { OFFLINE_SENSITIVE, useRecord } from "../record.ts";
import { ApproveButton, Plan } from "./Approval.tsx";
import { BodyEditor } from "./BodyEditor.tsx";
import { CheckProfiles, NoteDrift } from "./Drift.tsx";
import { FieldForm } from "./FieldForm.tsx";

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
      {pending ? "Saving" : "Saved"}
    </p>
  );
}

/** One note: its type and title, its fields beside its body, editable. */
export function NotePane({ noteId }: { readonly noteId: string }) {
  const { client, manifest, status } = useRecord();
  const raw = client?.working(noteId);
  const remote = client?.state.remote.get(noteId);
  if (!client || raw === undefined || !remote)
    return (
      <p className="empty">{status === "loading" || status === "connecting" ? "Loading" : "No such note."}</p>
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
  return (
    <article className="note">
      <header className="pane-head">
        <div className="path">{remote.path}</div>
        <h1>{title}</h1>
        <span className="badge">{typeof data["type"] === "string" ? data["type"] : "No type"}</span>
        {remote.class === "sensitive" && <span className="badge sensitive">sensitive</span>}
        <SyncState client={client} noteId={noteId} />
        {readOnly && <p className="sync-state warn">{OFFLINE_SENSITIVE}</p>}
        {data["type"] === "Profile" && <CheckProfiles />}
        <NoteDrift client={client} manifest={manifest} noteId={noteId} />
      </header>
      <div className="note-grid">
        <BodyEditor key={noteId} client={client} noteId={noteId} readOnly={readOnly} />
        <FieldForm
          fields={fieldsOf(data, manifest)}
          client={client}
          noteId={noteId}
          manifest={manifest}
          disabled={readOnly}
        />
      </div>
    </article>
  );
}
