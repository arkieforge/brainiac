import type { PlanItem } from "@brainiac/core";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { approvePlan } from "../approve.ts";
import { LIST } from "../motion.ts";
import { api, loadProposals, useRecord, type ProposalItem } from "../record.ts";
import { ApproveButton, Plan } from "./Approval.tsx";
import { Pip } from "./Pip.tsx";

type Answer =
  | { readonly done: true }
  | { readonly plan: { readonly planHash: string; readonly items: readonly PlanItem[] } }
  | { readonly error: string };

/**
 * The person accepts or rejects one proposal on the record. One that changes a value they verified comes back with
 * the plan to sign, then goes again with the approval. The socket tells every tab the list changed; this one asks
 * again at once too, so the card leaves without waiting for the push.
 */
async function decide(id: string, decision: "accept" | "reject", approvalId?: string): Promise<Answer> {
  const res = await api(`/api/proposals/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision, ...(approvalId !== undefined && { approvalId }) }),
  }).catch(() => undefined);
  if (!res) return { error: "You're offline, so nothing was decided." };
  const body = await res.json().catch(() => ({}));
  if (res.status === 409 && body?.needsApproval)
    return { plan: { planHash: body.planHash, items: body.items } };
  void loadProposals();
  return res.ok ? { done: true } : { error: body?.error ?? "That didn't go through." };
}

/** What a proposal would do, said plainly: what Accept means for this one. */
function headline(proposal: ProposalItem) {
  if (proposal.kind === "conflict") return "Two versions of this note disagree. Pick the one kept out?";
  const [first] = proposal.items;
  if (!first) return "A change";
  const notes = proposal.items.length > 1 ? ` and ${proposal.items.length - 1} more` : "";
  if (first.baseRev === 0) return `A new note${notes}`;
  if (first.patch.live?.after === false) return `Delete this note${notes}`;
  return `A change to this note${notes}`;
}

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function Card({ proposal, online }: { readonly proposal: ProposalItem; readonly online: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [plan, setPlan] = useState<{ readonly planHash: string; readonly items: readonly PlanItem[] }>();
  const sensitive = proposal.items.some((item) => item.class === "sensitive");
  const conflict = proposal.kind === "conflict";

  const send = async (decision: "accept" | "reject") => {
    setBusy(true);
    setError(undefined);
    setPlan(undefined);
    const answer = await decide(proposal.id, decision);
    setBusy(false);
    if ("plan" in answer) setPlan(answer.plan);
    if ("error" in answer) setError(answer.error);
  };
  const approve = async () => {
    if (!plan) return undefined;
    const approved = await approvePlan(plan.planHash, plan.items);
    if ("error" in approved) return approved;
    const answer = await decide(proposal.id, "accept", approved.approvalId);
    if ("error" in answer) return answer;
    setPlan(undefined);
    return undefined;
  };

  return (
    <li className="proposal" data-kind={proposal.kind}>
      <p className="who">
        <span className="by">{proposal.by}</span>
        {conflict ? <span className="badge conflict">conflict</span> : null}
        {sensitive && <span className="badge sensitive">sensitive</span>}
      </p>
      <p className="what">{headline(proposal)}</p>
      <ul className="notes small">
        {proposal.items.map((item) => (
          <li key={item.noteId} translate="no">
            {item.baseRev === 0 ? (
              item.path
            ) : (
              <Link to="/n/$noteId" params={{ noteId: item.noteId }}>
                {item.path}
              </Link>
            )}
          </li>
        ))}
      </ul>
      <div className="approval">
        <Plan items={proposal.items} />
      </div>
      {proposal.autoApplyAt !== null && (
        <p className="small warn">
          Held: it applies on its own on {when(proposal.autoApplyAt)} unless you decide first.
        </p>
      )}
      <div className="decide">
        <button
          type="button"
          className="primary"
          disabled={busy || !online}
          onClick={() => void send("accept")}
        >
          {conflict ? "Use this version" : "Accept"}
        </button>
        <button type="button" disabled={busy || !online} onClick={() => void send("reject")}>
          {conflict ? "Keep the note as it is" : "Reject"}
        </button>
      </div>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      {plan && (
        <div className="approval" role="status">
          <p>
            This changes a value you verified, so it needs your passkey. Approving lets exactly this through:
          </p>
          <Plan items={plan.items} />
          <ApproveButton approve={approve} />
        </div>
      )}
    </li>
  );
}

/**
 * Proposals: every change waiting for the person (an agent at propose level, a held change, an import, a connector
 * like GitHub, a conflict), with what it would do, accepted or rejected in place. They live in the record, so the
 * list needs it online; it follows the record live, so a proposal decided on another device leaves this one.
 */
export function Proposals() {
  const { status, proposals } = useRecord();
  const [list] = useAutoAnimate<HTMLUListElement>(LIST);
  const online = status === "live";
  if (proposals === undefined)
    return (
      <section className="proposals">
        <header className="pane-head">
          <h1>Proposals</h1>
          <p className="muted">
            {status === "offline" || status === "signed-out"
              ? "Proposals live in your record: they show when you're online."
              : "Loading…"}
          </p>
        </header>
      </section>
    );
  return (
    <section className="proposals">
      <header className="pane-head">
        <h1>Proposals</h1>
        <p className="muted">
          {proposals.length === 0
            ? "Nothing waits for you."
            : `${proposals.length === 1 ? "1 change waits" : `${proposals.length} changes wait`} for you, oldest first. Nothing here is in your record until you accept it.`}
        </p>
        {!online && <p className="warn small">You're offline: deciding needs the record.</p>}
      </header>
      {proposals.length === 0 && (
        <div className="empty">
          <Pip sticker="coffee" say="No proposals. What your agents and connectors suggest shows up here." />
        </div>
      )}
      <ul ref={list}>
        {proposals.map((proposal) => (
          <Card key={`${proposal.id} ${proposal.kind}`} proposal={proposal} online={online} />
        ))}
      </ul>
    </section>
  );
}
