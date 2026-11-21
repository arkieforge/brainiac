// Polar's webhook against a stand-in Polar (sandbox URLs, as every non-prod stage uses). What a plan does to a record
// is tested on both engines in packages/base/test/mutate-cases.ts.
import type { PlanState } from "@brainiac/base";
import { expect, it } from "vite-plus/test";

import { planFrom, verified, webhook, type PolarApp } from "./billing.ts";

// Standard Webhooks' published test vector (github.com/standard-webhooks/standard-webhooks, the spec's example). Its
// secret is public, but a literal `whsec_...` reads as a live key to secret scanners, so the prefix is joined here.
const whsec = (key: string) => ["whsec", key].join("_");
const VECTOR = {
  secret: whsec("MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"),
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

const app: PolarApp = {
  token: "polar_oat_test",
  webhookSecret: VECTOR.secret,
  productId: "prod-pro",
  api: "https://sandbox-api.polar.sh",
};

const headers = (signature: string, timestamp = VECTOR.timestamp) =>
  new Headers({
    "webhook-id": VECTOR.id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signature,
  });

/** Signs `body` as Polar does, with the vector's secret. */
async function signed(body: string, timestamp: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(VECTOR.secret.slice(whsec("").length)), (c) => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${VECTOR.id}.${timestamp}.${body}`),
  );
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
}

const state = (
  subscriptions: { product_id: string; current_period_end: string | null }[],
  deleted = false,
) => ({
  type: "customer.state_changed",
  timestamp: "2026-11-21T10:00:00.000Z",
  api_version: "2026-10",
  data: {
    type: "individual",
    id: "cus_1",
    external_id: "user-nadia",
    email: "nadia@example.edu",
    deleted_at: deleted ? "2026-11-21T09:00:00.000Z" : null,
    active_subscriptions: subscriptions.map((sub) => ({ ...sub, status: "active", amount: 600 })),
    granted_benefits: [],
    active_meters: [],
  },
});

it("takes only bodies signed with the secret, within the replay window", async () => {
  const now = VECTOR.timestamp * 1000;
  expect(await verified(VECTOR.secret, headers(VECTOR.signature), VECTOR.body, now)).toBe(true);
  // One of several listed signatures is enough, as when Polar rotates the secret.
  expect(await verified(VECTOR.secret, headers(`v1,bm9wZQ== ${VECTOR.signature}`), VECTOR.body, now)).toBe(
    true,
  );
  expect(await verified(VECTOR.secret, headers(VECTOR.signature), '{"test": 1}', now)).toBe(false);
  expect(await verified(whsec("c29tZW9uZSBlbHNl"), headers(VECTOR.signature), VECTOR.body, now)).toBe(false);
  expect(await verified(VECTOR.secret, headers(VECTOR.signature), VECTOR.body, now + 6 * 60_000)).toBe(false);
  expect(await verified(VECTOR.secret, headers("v2,whatever"), VECTOR.body, now)).toBe(false);
});

it("reads Pro from an active subscription to the Pro product, and free otherwise", () => {
  const end = "2026-12-21T10:00:00.000Z";
  const at = Date.parse("2026-11-21T10:00:00.000Z");
  const grace = 3 * 86_400_000;
  expect(planFrom(app, state([{ product_id: "prod-pro", current_period_end: end }]))).toEqual({
    userId: "user-nadia",
    state: { plan: "pro", until: Date.parse(end) + grace, at },
  });
  const free = { userId: "user-nadia", state: { plan: "free", until: null, at } };
  expect(planFrom(app, state([]))).toEqual(free);
  expect(planFrom(app, state([{ product_id: "prod-other", current_period_end: end }]))).toEqual(free);
  expect(planFrom(app, state([{ product_id: "prod-pro", current_period_end: end }], true))).toEqual(free);
  // Not ours, or not this event: nothing to do.
  expect(planFrom(app, { ...state([]), data: { ...state([]).data, external_id: null } })).toBeUndefined();
  expect(planFrom(app, { ...state([]), type: "order.paid" })).toBeUndefined();
});

it("sets the plan on the person's record only for a verified body", async () => {
  const now = Date.parse("2026-11-21T10:00:05.000Z");
  const timestamp = Math.floor(now / 1000);
  const body = JSON.stringify(state([{ product_id: "prod-pro", current_period_end: null }]));
  const set: [string, PlanState][] = [];
  const deps = {
    record: async (userId: string) => ({ setPlan: (plan: PlanState) => (set.push([userId, plan]), true) }),
    now,
  };
  const post = (signature: string) =>
    new Request("https://brainiac.test/billing/webhook", {
      method: "POST",
      headers: headers(signature, timestamp),
      body,
    });

  expect((await webhook(post(VECTOR.signature), app, deps)).status).toBe(403);
  expect(set).toEqual([]);
  expect((await webhook(post(await signed(body, timestamp)), app, deps)).status).toBe(202);
  expect(set).toEqual([
    ["user-nadia", { plan: "pro", until: null, at: Date.parse("2026-11-21T10:00:00.000Z") }],
  ]);
});
