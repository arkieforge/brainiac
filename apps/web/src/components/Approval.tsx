import { show, type PlanItem } from "@brainiac/core";
import { useState } from "react";

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
            {/* A new note's "(new)" already says it comes to be. */}
            {item.patch.live && item.baseRev > 0 && (
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
