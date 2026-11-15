import { useState } from "react";

import { approvePlan } from "../approve.ts";
import { api } from "../record.ts";
import { ApproveButton, Plan } from "./Approval.tsx";
import type { PlanItem } from "@brainiac/core";

const folderOf = (path: string) => path.split("/").slice(0, -1).join("/");

/**
 * Moves a note into another folder, keeping its file name: online, straight to the record, which takes a sidecar's
 * file along and rewrites every link to it. A move the record needs a passkey for shows the plan to sign.
 */
export function MoveForm({
  noteId,
  path,
  rev,
  paths,
  online,
}: {
  readonly noteId: string;
  readonly path: string;
  readonly rev: number;
  /** Every note's path the tab knows, for the folders to pick from. */
  readonly paths: readonly string[];
  readonly online: boolean;
}) {
  const [folder, setFolder] = useState(folderOf(path));
  const [message, setMessage] = useState<string>();
  const [plan, setPlan] = useState<{ readonly planHash: string; readonly items: readonly PlanItem[] }>();
  const name = path.split("/").at(-1) ?? path;
  const target = [...folder.split("/").filter(Boolean), name].join("/");
  const folders = [...new Set(paths.map(folderOf).filter(Boolean))].toSorted();
  const send = async (approvalId?: string) => {
    const res = await api(`/api/notes/${noteId}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: target, baseRev: rev, ...(approvalId !== undefined && { approvalId }) }),
    }).catch(() => undefined);
    const answer = await res?.json().catch(() => ({}));
    return { res, answer };
  };
  const move = async () => {
    setPlan(undefined);
    const { res, answer } = await send();
    if (res?.status === 409 && answer?.needsApproval)
      return setPlan({ planHash: answer.planHash, items: answer.items });
    setMessage(res?.ok ? undefined : (answer?.error ?? "You're offline, so it didn't move."));
  };
  const approve = async () => {
    if (!plan) return undefined;
    const approved = await approvePlan(plan.planHash, plan.items);
    if ("error" in approved) return approved;
    const { res, answer } = await send(approved.approvalId);
    if (!res?.ok) return { error: answer?.error ?? "It didn't move." };
    setPlan(undefined);
    setMessage(undefined);
    return undefined;
  };
  return (
    <form
      className="fields"
      onSubmit={(event) => {
        event.preventDefault();
        void move();
      }}
    >
      {folderOf(path) === "unorganized" && (
        <p className="small muted">Uploads wait here until you or your Claude file them.</p>
      )}
      <label>
        Folder
        <input list={`folders-${noteId}`} value={folder} onChange={(e) => setFolder(e.currentTarget.value)} />
        <datalist id={`folders-${noteId}`}>
          {folders.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </label>
      <button type="submit" disabled={!online || target === path}>
        Move
      </button>
      {!online && <p className="small muted">Moving a note needs the record online.</p>}
      {message && <p role="alert">{message}</p>}
      {plan && (
        <div className="approval" role="status">
          <p>
            This move changes notes you verified, so it needs your passkey. Approving lets exactly this
            through:
          </p>
          <Plan items={plan.items} />
          <ApproveButton approve={approve} />
        </div>
      )}
    </form>
  );
}
