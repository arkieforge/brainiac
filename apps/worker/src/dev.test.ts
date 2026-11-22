import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { listNotes, migrate, mutate } from "@brainiac/base";
import { nodeSql } from "@brainiac/base/node";
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

/** A person's record on node:sqlite through packages/base's own mutation path, as the Base DO runs it. */
function memoryRecord() {
  const sql = nodeSql(new DatabaseSync(":memory:"));
  migrate(sql);
  const record: SeedRecord = {
    notes: async () => listNotes(sql),
    mutate: async (mutation, caller) => mutate(sql, mutation, { ...caller, now: Date.now() }),
  };
  return { record, paths: () => listNotes(sql).map((note) => note.path) };
}

function setup() {
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
  const bases = new Map<string, ReturnType<typeof memoryRecord>>();
  const recordOf = async (userId: string) => {
    const base = bases.get(userId) ?? memoryRecord();
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

describe("dev seed", () => {
  it("fills a new account's record once, through the record's own mutation path", async () => {
    const { config, bases, recordOf } = setup();
    const seed = (body: unknown, authorization = `Bearer ${TOKEN}`, query = "") =>
      serveDev(
        new Request(`${ORIGIN}/dev/seed${query}`, {
          method: "POST",
          headers: { authorization },
          body: JSON.stringify(body),
        }),
        config,
        TOKEN,
        recordOf,
      );
    const notes = [note(ROLE), note(PERSON)];

    expect((await seed({ notes }, "Bearer wrong")).status).toBe(404);
    expect(bases.size).toBe(0);
    expect((await seed({ notes: [{ path: "x.md", raw: 1, class: "normal" }] })).status).toBe(400);

    const first = await seed({ notes });
    expect(await first.json()).toEqual({ seeded: 2, existing: 0, refused: [] });
    const [base] = bases.values();
    expect(base?.paths().toSorted()).toEqual([ROLE, PERSON]);

    // A record someone has used is never added to, even by a second seed with other notes.
    const again = await seed({ notes: [note("facts/papers/swahili-ner-2026.md")] });
    expect(await again.json()).toEqual({ seeded: 0, existing: 2, refused: [] });
    expect(base?.paths()).toHaveLength(2);

    // A tagged account gets a record of its own.
    expect(await (await seed({ notes }, `Bearer ${TOKEN}`, "?as=e2e-1")).json()).toMatchObject({ seeded: 2 });
    expect(bases.size).toBe(2);
  });

  it("reports a note the record doesn't apply instead of forcing it", async () => {
    const { config, recordOf } = setup();
    const res = await serveDev(
      new Request(`${ORIGIN}/dev/seed`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ notes: [note(ROLE, "../outside.md"), note(PERSON)] }),
      }),
      config,
      TOKEN,
      recordOf,
    );
    const body: unknown = await res.json();
    expect(body).toMatchObject({ seeded: 1, refused: [{ path: "../outside.md" }] });
  });
});
