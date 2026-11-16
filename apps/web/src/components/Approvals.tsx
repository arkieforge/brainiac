import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { approveWaiting, declineWaiting, waitingPlans, type Waiting } from "../approve.ts";
import { ApproveButton, Plan } from "./Approval.tsx";

const when = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** What happens once a plan is signed, by what asked: a device resends on its own, an agent waits to be told. */
const next = ({ from, by }: Waiting) =>
  by === "site"
    ? "Approved. Your tab sends the edit again on its own."
    : by === "laptop"
      ? "Approved. If your laptop's sync asked, it sends the edit again on its own; if an agent there did, tell it to try again."
      : `Approved. Tell your agent (${from}) to send its call again.`;

function Card({ plan, onDone }: { readonly plan: Waiting; readonly onDone: (said: string) => void }) {
  const [error, setError] = useState<string>();
  const sensitive = plan.items.some((item) => item.class === "sensitive");
  return (
    <li className="approval" data-sensitive={sensitive || undefined}>
      <p className="muted small">
        {plan.from} asked on {when(plan.at)}
        {sensitive && <span className="badge sensitive">sensitive</span>}
      </p>
      <Plan items={plan.items} />
      {plan.stale ? (
        <p className="warn small">
          A note here changed since this was asked, so it can't land as shown. Turn it down, and ask again if
          it's still wanted.
        </p>
      ) : (
        <ApproveButton
          approve={async () => {
            const approved = await approveWaiting(plan);
            if ("error" in approved) return approved;
            onDone(next(plan));
            return undefined;
          }}
        />
      )}{" "}
      <button
        type="button"
        className="ghost"
        onClick={() =>
          void declineWaiting(plan.approvalId).then((failed) =>
            failed ? setError(failed.error) : onDone("Turned down. Nothing changed."),
          )
        }
      >
        Turn down
      </button>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * Changes waiting for your passkey, whoever asked: your agent, your laptop, another tab. Each shows exactly the
 * plan the record keeps and your passkey signs. With `approvalId` (an agent's link), just that one.
 */
export function Approvals({ approvalId }: { readonly approvalId?: string }) {
  const [plans, setPlans] = useState<readonly Waiting[] | "offline">();
  const [done, setDone] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    void waitingPlans().then((list) => setPlans(list ?? "offline"));
  }, []);
  if (plans === undefined) return <p className="empty">Loading…</p>;
  if (plans === "offline")
    return <p className="empty">Approvals load only while you're online on this device.</p>;
  const shown = approvalId === undefined ? plans : plans.filter((p) => p.approvalId === approvalId);
  const open = shown.filter((p) => !done.has(p.approvalId));
  return (
    <section className="approvals">
      <header className="pane-head">
        <h1>Approvals</h1>
        <p className="muted">
          {open.length === 0
            ? approvalId !== undefined && done.size === 0
              ? "This approval isn't waiting any more: it was approved, turned down, or it ended. Ask for it again if it's still wanted."
              : "Nothing waits for your passkey."
            : "Changes to values you checked wait for your passkey. You sign exactly what's shown."}
        </p>
      </header>
      <ul>
        {shown.map((plan) =>
          done.has(plan.approvalId) ? (
            <li key={plan.approvalId} className="approval">
              <p role="status">{done.get(plan.approvalId)}</p>
            </li>
          ) : (
            <Card
              key={plan.approvalId}
              plan={plan}
              onDone={(said) => setDone(new Map(done).set(plan.approvalId, said))}
            />
          ),
        )}
      </ul>
      {approvalId !== undefined && plans.length > shown.length && (
        <p className="more">
          <Link to="/approvals">See everything waiting</Link>
        </p>
      )}
    </section>
  );
}
