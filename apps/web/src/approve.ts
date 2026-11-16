// Approvals on the site (contract §4): the person's passkey signs exactly the change the record asked about,
// a plan's hash or a file kind's challenge. The record checks the signature against its own hash of what it was
// sent, and Neon's copy of the passkey, never one named here.
import type { PlanItem } from "@brainiac/core";

import { api } from "./record.ts";

const NO_ANSWER = "No passkey answered, so nothing was approved.";

/** The person's passkey answering `challenge`, as JSON for the record to check, or why there is none. */
export async function sign(
  challenge: string,
): Promise<{ readonly response: unknown } | { readonly error: string }> {
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({
      publicKey: PublicKeyCredential.parseRequestOptionsFromJSON({ challenge, userVerification: "required" }),
    });
  } catch {
    return { error: NO_ANSWER };
  }
  return credential instanceof PublicKeyCredential ? { response: credential.toJSON() } : { error: NO_ANSWER };
}

/** Signs the plan a `needsApproval` result named and has the record keep the approval for the change to cite. */
export async function approvePlan(
  planHash: string,
  items: readonly PlanItem[],
): Promise<{ readonly approvalId: string } | { readonly error: string }> {
  const signed = await sign(planHash);
  if ("error" in signed) return signed;
  const res = await api("/api/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items, response: signed.response }),
  }).catch(() => undefined);
  const body = await res?.json().catch(() => ({}));
  if (!res) return { error: "You're offline, so nothing was approved." };
  if (!res.ok || typeof body?.approvalId !== "string")
    return { error: body?.error ?? "Your passkey's answer didn't check out." };
  return { approvalId: body.approvalId };
}

/** A plan waiting for the person's passkey, as the record keeps it (`GET /api/approvals`). */
export interface Waiting {
  readonly approvalId: string;
  readonly planHash: string;
  readonly items: readonly PlanItem[];
  /** Who asked, in the person's words. */
  readonly from: string;
  /** What asked: a tab or a laptop resends on its own once signed; an agent waits to be told. */
  readonly by: "site" | "laptop" | "agent";
  readonly at: number;
  /** A note in it changed since, so it can't land as signed. */
  readonly stale: boolean;
}

/**
 * The plans waiting for the person (or just the one `approvalId` names), or undefined offline: they load only from
 * the record, never a cache.
 */
export async function waitingPlans(approvalId?: string): Promise<readonly Waiting[] | undefined> {
  const query = approvalId === undefined ? "" : `?${new URLSearchParams({ id: approvalId })}`;
  const res = await api(`/api/approvals${query}`).catch(() => undefined);
  const body = res?.ok ? await res.json().catch(() => undefined) : undefined;
  return Array.isArray(body?.approvals) ? body.approvals : undefined;
}

/**
 * Signs a plan the record kept for an agent's or another device's change. The challenge is its hash as the record
 * listed it, and the record checks the signature against its own copy of the plan, by id.
 */
export async function approveWaiting(
  plan: Pick<Waiting, "approvalId" | "planHash">,
): Promise<{ readonly approvalId: string } | { readonly error: string }> {
  const signed = await sign(plan.planHash);
  if ("error" in signed) return signed;
  const res = await api("/api/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approvalId: plan.approvalId, response: signed.response }),
  }).catch(() => undefined);
  const body = await res?.json().catch(() => ({}));
  if (!res) return { error: "You're offline, so nothing was approved." };
  if (!res.ok || typeof body?.approvalId !== "string")
    return { error: body?.error ?? "Your passkey's answer didn't check out." };
  return { approvalId: body.approvalId };
}

/** Turns a waiting plan down: nothing changes, and whoever asked has to ask again. */
export async function declineWaiting(approvalId: string): Promise<{ readonly error: string } | undefined> {
  const res = await api("/api/approvals/decline", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approvalId }),
  }).catch(() => undefined);
  if (!res) return { error: "You're offline, so nothing was turned down." };
  if (!res.ok) return { error: (await res.json().catch(() => ({})))?.error ?? "That didn't work." };
  return undefined;
}
