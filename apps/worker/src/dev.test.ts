import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vite-plus/test";

import { createAuth, type AuthConfig } from "./auth/config.ts";
import { FIXTURE_STUDENT, serveDev } from "./dev.ts";
import { serveMcp } from "./mcp/handler.ts";

const ORIGIN = "https://brainiac.test";
const TOKEN = "a-dev-sign-in-token-for-tests";

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
  const signIn = (query: string) => serveDev(new Request(`${ORIGIN}/dev/sign-in?${query}`), config, TOKEN);
  /** Who the cookie from a sign-in belongs to, as the real auth handler sees it. */
  const whoIs = async (res: Response) => {
    const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    return session?.user.email;
  };
  return { config, auth, signIn, whoIs };
}

describe("dev sign-in", () => {
  it("signs the holder of the token in as the fixture student", async () => {
    const { signIn, whoIs } = setup();
    const res = await signIn(`token=${TOKEN}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account");
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly.*Secure/);
    expect(await whoIs(res)).toBe(FIXTURE_STUDENT.email);
    // Signing in again finds the same account rather than making another.
    expect(await whoIs(await signIn(`token=${TOKEN}`))).toBe(FIXTURE_STUDENT.email);
  });

  it("looks like nothing is there without the right token", async () => {
    const { signIn } = setup();
    for (const query of ["", "token=wrong", `token=${TOKEN}x`]) {
      const res = await signIn(query);
      expect(res.status).toBe(404);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("makes a separate fixture account per tag, and refuses tags that aren't plain", async () => {
    const { signIn, whoIs } = setup();
    expect(await whoIs(await signIn(`token=${TOKEN}&as=e2e-1`))).toBe("ada.okafor+e2e-1@example.edu");
    expect((await signIn(`token=${TOKEN}&as=${encodeURIComponent("x@evil.example")}`)).status).toBe(404);
  });

  it("only redirects within the site", async () => {
    const { signIn } = setup();
    expect((await signIn(`token=${TOKEN}&next=/consent`)).headers.get("location")).toBe("/consent");
    for (const next of ["//evil.example/", "https://evil.example/", "/\\evil.example/", ""]) {
      const res = await signIn(`token=${TOKEN}&next=${encodeURIComponent(next)}`);
      expect(res.headers.get("location")).toBe("/account");
    }
  });
});

const mint = (config: AuthConfig, authorization: string) =>
  serveDev(new Request(`${ORIGIN}/dev/token`, { method: "POST", headers: { authorization } }), config, TOKEN);

describe("dev token", () => {
  it("mints an access token that /mcp accepts, and nothing without the dev token", async () => {
    const { config, auth } = setup();
    expect((await mint(config, "Bearer wrong")).status).toBe(404);
    const res = await mint(config, `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const accessToken =
      body && typeof body === "object" && "access_token" in body ? String(body.access_token) : "";
    const initialize = await serveMcp(
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
    );
    expect(initialize.status).toBe(200);
  });
});
