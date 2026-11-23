import { readFileSync } from "node:fs";
import { join } from "node:path";

import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vite-plus/test";

import { createAuth, type AuthConfig } from "./auth/config.ts";
import { FIXTURE_STUDENT, serveDev, type SeedRecord } from "./dev.ts";
import { serveMcp } from "./mcp/handler.ts";

const ORIGIN = "https://brainiac.test";
const TOKEN = "a-dev-sign-in-token-for-tests";

/** Where the sign-in answer sends the page. */
const landsOn = async (res: Response) => {
  const body: unknown = await res.json();
  return body && typeof body === "object" && "location" in body ? body.location : undefined;
};

type SeedAnswer = Awaited<ReturnType<SeedRecord["seedIfEmpty"]>>;

/**
 * A record that answers every seed with `answer` and keeps what it was asked. The real seedIfEmpty (all or none, only
 * while empty) is tested on the Base DO in workerd (test/base.test.ts); this tests the route around it.
 */
function stubRecord(answer: SeedAnswer) {
  const asked: Parameters<SeedRecord["seedIfEmpty"]>[] = [];
  const record: SeedRecord = {
    seedIfEmpty: async (...args) => {
      asked.push(args);
      return answer;
    },
  };
  return { record, asked };
}

function setup(answer: SeedAnswer = { status: "applied" }) {
  const config: AuthConfig = {
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      passkey: [],
      jwks: [],
      oauthClient: [],
      oauthRefreshToken: [],
      oauthAccessToken: [],
      oauthConsent: [],
    }),
    baseURL: ORIGIN,
    secret: "a-test-secret-that-is-long-enough-to-pass",
    sendEmail: async () => {},
  };
  const auth = createAuth(config);
  /** Each person's record by user id, made on first use like the base registry's. */
  const bases = new Map<string, ReturnType<typeof stubRecord>>();
  const recordOf = async (userId: string) => {
    const base = bases.get(userId) ?? stubRecord(answer);
    bases.set(userId, base);
    return base.record;
  };
  /** What the sign-in page does with the link: POST its query, the fragment's token in the header. */
  const signIn = (query: string, token = TOKEN) =>
    serveDev(
      new Request(`${ORIGIN}/dev/sign-in?${query}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
      config,
      TOKEN,
      recordOf,
    );
  /** Who the cookie from a sign-in belongs to, as the real auth handler sees it. */
  const whoIs = async (res: Response) => {
    const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    return session?.user.email;
  };
  return { config, auth, signIn, whoIs, bases, recordOf };
}

describe("dev sign-in", () => {
  it("signs the holder of the token in as the fixture student", async () => {
    const { signIn, whoIs } = setup();
    const res = await signIn("");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly.*Secure.*Max-Age=\d+/);
    expect(await whoIs(res.clone())).toBe(FIXTURE_STUDENT.email);
    expect(await landsOn(res)).toBe(`${ORIGIN}/account`);
    // Signing in again finds the same account rather than making another.
    expect(await whoIs(await signIn(""))).toBe(FIXTURE_STUDENT.email);
  });

  it("serves the link's page without the token, and nothing without the right one", async () => {
    const { config, signIn, recordOf } = setup();
    // The token stays in the link's fragment, so the page itself needs none and sets nothing.
    const page = await serveDev(new Request(`${ORIGIN}/dev/sign-in?as=x`), config, TOKEN, recordOf);
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toBeNull();
    for (const token of ["", "wrong", `${TOKEN}x`]) {
      const res = await signIn("", token);
      expect(res.status).toBe(404);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("makes a separate fixture account per tag, and refuses tags that aren't plain", async () => {
    const { signIn, whoIs } = setup();
    expect(await whoIs(await signIn("as=e2e-1"))).toBe("nadia.karim+e2e-1@example.edu");
    expect((await signIn(`as=${encodeURIComponent("x@evil.example")}`)).status).toBe(404);
  });

  it("only lands within the site", async () => {
    const { signIn } = setup();
    expect(await landsOn(await signIn("next=/consent?x=1"))).toBe(`${ORIGIN}/consent?x=1`);
    for (const next of [
      "//evil.example/",
      "https://evil.example/",
      "/\\evil.example/",
      "/.//evil.example/",
      "",
    ]) {
      const location = await landsOn(await signIn(`next=${encodeURIComponent(next)}`));
      expect(new URL(String(location)).origin).toBe(ORIGIN);
    }
  });
});

const noRecord = async () => undefined;

const mint = (config: AuthConfig, authorization: string) =>
  serveDev(
    new Request(`${ORIGIN}/dev/token`, { method: "POST", headers: { authorization } }),
    config,
    TOKEN,
    noRecord,
  );

// initialize calls no tool, so the record is never asked anything.
const unused = () => Promise.reject(new Error("initialize reaches no record"));

describe("dev token", () => {
  it("mints an access token that /mcp accepts, and nothing without the dev token", async () => {
    const { config, auth } = setup();
    expect((await mint(config, "Bearer wrong")).status).toBe(404);
    const get = new Request(`${ORIGIN}/dev/token`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect((await serveDev(get, config, TOKEN, noRecord)).status).toBe(404);
    const res = await mint(config, `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const accessToken =
      body && typeof body === "object" && "access_token" in body ? String(body.access_token) : "";
    const records = { of: async () => ({ tool: unused, authenticate: unused }), byId: () => undefined };
    const initialize = (devTokens: boolean) =>
      serveMcp(
        auth,
        new Request(`${ORIGIN}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "test", version: "1" },
            },
          }),
        }),
        records,
        { devTokens },
      );
    expect((await initialize(true)).status).toBe(200);
    // No consent stands behind a dev token, so where dev tokens aren't taken (prod) it is refused.
    expect((await initialize(false)).status).toBe(401);
  });
});

/** A fixture note, at `path` or where the fixture keeps it. */
const note = (from: string, path = from) => ({
  path,
  raw: readFileSync(join(import.meta.dirname, "../../../fixtures/nadia", from), "utf8"),
  class: "normal",
});
const ROLE = "facts/roles/acme-intern-2025.md";
const PERSON = "people/dr-okafor.md";

/** A /dev/seed request with `body`, as scripts/dev-auth.ts sends it. */
const seedRequest = (body: unknown, authorization = `Bearer ${TOKEN}`, query = "") =>
  new Request(`${ORIGIN}/dev/seed${query}`, {
    method: "POST",
    headers: { authorization },
    body: JSON.stringify(body),
  });

describe("dev seed", () => {
  it("hands the notes to the account's own record as creates by the person", async () => {
    const { config, bases, recordOf } = setup();
    const seed = (...args: Parameters<typeof seedRequest>) =>
      serveDev(seedRequest(...args), config, TOKEN, recordOf);
    const notes = [note(ROLE), note(PERSON)];

    expect((await seed({ notes }, "Bearer wrong")).status).toBe(404);
    expect((await seed({ notes: [{ path: "x.md", raw: 1, class: "normal" }] })).status).toBe(400);
    expect(bases.size).toBe(0);

    expect(await (await seed({ notes })).json()).toEqual({ seeded: 2, existing: 0 });
    const [base] = bases.values();
    expect(base?.asked).toEqual([[notes.map((n) => ({ op: "create", ...n })), { actor: "human" }]]);
    // A tagged account gets a record of its own.
    await seed({ notes }, `Bearer ${TOKEN}`, "?as=e2e-1");
    expect(bases.size).toBe(2);
  });

  it("says how many notes a used record already held, and passes on a refusal", async () => {
    const used = setup({ status: "notEmpty", notes: 3 });
    const kept = await serveDev(seedRequest({ notes: [note(ROLE)] }), used.config, TOKEN, used.recordOf);
    expect(await kept.json()).toEqual({ seeded: 0, existing: 3 });

    const refusing = setup({ status: "invalid" });
    const refused = await serveDev(
      seedRequest({ notes: [note(ROLE)] }),
      refusing.config,
      TOKEN,
      refusing.recordOf,
    );
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ result: { status: "invalid" } });
  });
});
