// Billing, with Polar as merchant of record (docs/operations/services.md, docs/product/pricing.md). The person pays
// on Polar's checkout as themselves: our user id is Polar's external customer id. Polar's signed
// `customer.state_changed` webhook then says whether they hold the Pro product, and their record keeps that
// (packages/base/src/plan.ts), where the limits are enforced. This file only talks to Polar.
import type { PlanState } from "@brainiac/base";
import { type } from "arktype";

import type { Env } from "./env.ts";

/** Polar, from Doppler (infra/README.md). Billing is off, and no record has limits, until all three exist. */
export interface PolarApp {
  readonly token: string;
  readonly webhookSecret: string;
  /** The Pro product: an active subscription to it is Pro. */
  readonly productId: string;
  /** Polar's API, or its sandbox everywhere but prod: a sandbox token works only there. */
  readonly api: string;
}

export function polarApp(env: Env): PolarApp | undefined {
  const { POLAR_ACCESS_TOKEN: token, POLAR_WEBHOOK_SECRET: webhookSecret, POLAR_PRODUCT_ID: productId } = env;
  if (!token || !webhookSecret || !productId) return undefined;
  const api = env.STAGE === "prod" ? "https://api.polar.sh" : "https://sandbox-api.polar.sh";
  return { token, webhookSecret, productId, api };
}

const Checkout = type({ url: "string.url" });
const Portal = type({ customer_portal_url: "string.url" });

/** One call to Polar's API; the caller checks the answer's shape. */
async function post(app: PolarApp, fetcher: typeof fetch, path: string, body: object) {
  const res = await fetcher(`${app.api}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${app.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Polar ${path} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** Where Upgrade goes: Polar's checkout for Pro, as this person, coming back to the account page. */
export async function checkoutUrl(
  app: PolarApp,
  fetcher: typeof fetch,
  user: { readonly id: string; readonly email: string },
  origin: string,
): Promise<string> {
  const checkout = Checkout(
    await post(app, fetcher, "/v1/checkouts/", {
      products: [app.productId],
      external_customer_id: user.id,
      customer_email: user.email,
      success_url: `${origin}/account?billing=paid`,
      return_url: `${origin}/account`,
    }),
  );
  if (checkout instanceof type.errors) throw new Error(`Polar's checkout: ${checkout.summary}`);
  return checkout.url;
}

/** Where Manage billing goes: Polar's customer portal for this person (invoices, card, cancel). */
export async function portalUrl(app: PolarApp, fetcher: typeof fetch, userId: string, origin: string) {
  const session = Portal(
    await post(app, fetcher, "/v1/customer-sessions/", {
      external_customer_id: userId,
      return_url: `${origin}/account`,
    }),
  );
  if (session instanceof type.errors) throw new Error(`Polar's customer portal: ${session.summary}`);
  return session.customer_portal_url;
}

/** How old a webhook may be: Standard Webhooks' replay window. */
const TOLERANCE_S = 5 * 60;

const unbase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/**
 * Whether Polar sent this body (Standard Webhooks, https://www.standardwebhooks.com): an HMAC-SHA256 over
 * `<webhook-id>.<webhook-timestamp>.<body>`, keyed by the secret's bytes (base64 after `whsec_`), listed in
 * `webhook-signature` as space-separated `v1,<base64>`. Polar's secrets from 8 September 2026 on are this kind; an
 * older one is keyed by the UTF-8 bytes of the whole `whsec_...` string, so both keys are tried, as Polar's SDK does.
 */
export async function verified(secret: string, headers: Headers, body: string, now: number) {
  const id = headers.get("webhook-id");
  const timestamp = Number(headers.get("webhook-timestamp"));
  const signatures = headers.get("webhook-signature")?.split(" ") ?? [];
  if (!id || !Number.isSafeInteger(timestamp) || Math.abs(now / 1000 - timestamp) > TOLERANCE_S) return false;
  const raws = [new TextEncoder().encode(secret)];
  try {
    raws.unshift(unbase64(secret.replace(/^whsec_/, "")));
  } catch {
    // Not base64 after the prefix: only the older kind can match.
  }
  const keys = await Promise.all(
    raws.map((raw) =>
      crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]),
    ),
  );
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
  for (const signature of signatures) {
    const [version, value] = signature.split(",");
    if (version !== "v1" || !value) continue;
    let given;
    try {
      given = unbase64(value);
    } catch {
      continue;
    }
    // `verify` compares in constant time.
    for (const key of keys) if (await crypto.subtle.verify("HMAC", key, given, signed)) return true;
  }
  return false;
}

// Only what the plan needs from Polar's customer state; the rest of the payload is dropped unread.
const StateChanged = type({
  type: "'customer.state_changed'",
  timestamp: "string",
  data: {
    external_id: "string | null",
    deleted_at: "string | null",
    active_subscriptions: type({ product_id: "string", current_period_end: "string | null" }).array(),
  },
});

/** How long Pro outlasts a paid period, so a renewal whose webhook comes late never drops someone who paid. */
const GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The plan a `customer.state_changed` body says one of our people has: Pro while they hold an active (or trialing)
 * subscription to the Pro product, free otherwise. Undefined for other events and customers not made by us. Polar
 * lists a `past_due` subscription (a renewal whose payment failed) as not active, so that is free at once.
 */
export function planFrom(app: PolarApp, payload: unknown): { userId: string; state: PlanState } | undefined {
  const event = StateChanged(payload);
  if (event instanceof type.errors || event.data.external_id === null) return undefined;
  const at = Date.parse(event.timestamp);
  if (Number.isNaN(at)) return undefined;
  const pro =
    event.data.deleted_at === null
      ? event.data.active_subscriptions.find((sub) => sub.product_id === app.productId)
      : undefined;
  const end = pro?.current_period_end ? Date.parse(pro.current_period_end) : Number.NaN;
  const state: PlanState = pro
    ? { plan: "pro", until: Number.isNaN(end) ? null : end + GRACE_MS, at }
    : { plan: "free", until: null, at };
  return { userId: event.data.external_id, state };
}

/** What the webhook asks of a person's record (the Base DO's method). */
export interface BillingRecord {
  setPlan(state: PlanState): boolean | Promise<boolean>;
}

/**
 * Polar's webhook: no session, so its signature is the only way in. Every event Polar may send is acknowledged
 * (anything but 2xx makes Polar retry it), and only a verified `customer.state_changed` changes a plan.
 */
export async function webhook(
  request: Request,
  app: PolarApp,
  deps: { readonly record: (userId: string) => Promise<BillingRecord | undefined>; readonly now: number },
): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await request.text();
  if (!(await verified(app.webhookSecret, request.headers, body, deps.now)))
    return new Response("Bad signature", { status: 403 });
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Not JSON", { status: 400 });
  }
  const plan = planFrom(app, payload);
  // A customer with no record here is acknowledged; any other failure throws, so Polar retries it.
  if (plan) await (await deps.record(plan.userId))?.setPlan(plan.state);
  return new Response(null, { status: 202 });
}
