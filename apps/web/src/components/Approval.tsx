import { show, type PlanItem } from "@brainiac/core";
import { useState } from "react";

import { approvePlan } from "../approve.ts";
import type { Approval } from "../fields.ts";

const value = (side: object, key: "before" | "after") =>
  key in side ? show(Object.entries(side).find(([k]) => k === key)?.[1]) : "not set";

/**
 * Exactly what a passkey signature over a plan lets through: each note, and each field before and after. These
 * are the items sent with the signature, and the record checks it against its own hash of them.
 */
export function Plan({ items }: { readonly items: readonly PlanItem[] }) {
  return (
    <ul className="plan">
      {items.map((item) => (
        <li key={item.noteId}>
          <div className="path">
            {item.path}
            {item.baseRev === 0 && " (new)"}
          </div>
          <dl>
            {Object.entries(item.patch.fields).map(([key, side]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>
                  <del>{value(side, "before")}</del> <ins>{value(side, "after")}</ins>
                </dd>
              </div>
            ))}
            {item.patch.body && (
              <div>
                <dt>body</dt>
                <dd>
                  <pre>
                    <del>{item.patch.body.before}</del>
                  </pre>
                  <pre>
                    <ins>{item.patch.body.after}</ins>
                  </pre>
                </dd>
              </div>
            )}
            {item.patch.live && (
              <div>
                <dt>note</dt>
                <dd>{item.patch.live.after ? "comes back" : "is deleted"}</dd>
              </div>
            )}
            {item.patch.path && (
              <div>
                <dt>moves</dt>
                <dd>
                  <del>{item.patch.path.before}</del> <ins>{item.patch.path.after}</ins>
                </dd>
              </div>
            )}
            {item.patch.class && (
              <div>
                <dt>privacy</dt>
                <dd>
                  <del>{item.patch.class.before}</del> <ins>{item.patch.class.after}</ins>
                </dd>
              </div>
            )}
          </dl>
        </li>
      ))}
    </ul>
  );
}

/** A button that runs `approve` (a passkey ceremony and the record's check), and says why one failed. */
export function ApproveButton({
  approve,
}: {
  readonly approve: () => Promise<{ readonly error: string } | undefined>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(undefined);
          void approve()
            .then((failed) => setError(failed?.error))
            .finally(() => setBusy(false));
        }}
      >
        Approve with your passkey
      </button>
      {error && <span role="alert"> {error}</span>}
    </>
  );
}

/**
 * A sensitive note's edit the record held for the person's passkey: the plan it returned, signed as shown, then
 * the same edit sent again citing the approval (`send`). `keep` drops the edit for the record's version.
 */
export function HeldEdit({
  approval,
  send,
  keep,
}: {
  readonly approval: Approval;
  readonly send: (approvalId: string) => Promise<{ readonly error: string } | undefined>;
  readonly keep: () => void;
}) {
  // Once approving starts, the edit may land: keeping the record's version then would hide it, not drop it.
  const [approving, setApproving] = useState(false);
  return (
    <div className="approval" role="status">
      <p>This change needs your passkey. Approving lets exactly this through:</p>
      <Plan items={approval.items} />
      <ApproveButton
        approve={async () => {
          setApproving(true);
          try {
            const approved = await approvePlan(approval.planHash, approval.items);
            return "error" in approved ? approved : await send(approved.approvalId);
          } finally {
            setApproving(false);
          }
        }}
      />{" "}
      <button type="button" disabled={approving} onClick={keep}>
        Keep the record's version
      </button>
    </div>
  );
}
