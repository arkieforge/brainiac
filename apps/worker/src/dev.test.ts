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
  /** What the sign-in page does with the link: POST its query, the fragment's token in the header. */
  const signIn = (query: string, token = TOKEN) =>
    serveDev(
      new Request(`${ORIGIN}/dev/sign-in?${query}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
      config,
      TOKEN,
    );
  /** Who the cookie from a sign-in belongs to, as the real auth handler sees it. */
  const whoIs = async (res: Response) => {
    const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    return session?.user.email;
  };
  const landsOn = async (res: Response) => {
    const body: unknown = await res.json();
    return body && typeof body === "object" && "location" in body ? body.location : undefined;
  };
  return { config, auth, signIn, whoIs, landsOn };
}

describe("dev sign-in", () => {
  it("signs the holder of the token in as the fixture student", async () => {
    const { signIn, whoIs, landsOn } = setup();
    const res = await signIn("");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly.*Secure.*Max-Age=\d+/);
    expect(await whoIs(res.clone())).toBe(FIXTURE_STUDENT.email);
    expect(await landsOn(res)).toBe(`${ORIGIN}/account`);
    // Signing in again finds the same account rather than making another.
    expect(await whoIs(await signIn(""))).toBe(FIXTURE_STUDENT.email);
  });

  it("serves the link's page without the token, and nothing without the right one", async () => {
    const { config, signIn } = setup();
    // The token stays in the link's fragment, so the page itself needs none and sets nothing.
    const page = await serveDev(new Request(`${ORIGIN}/dev/sign-in?as=x`), config, TOKEN);
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
    expect(await whoIs(await signIn("as=e2e-1"))).toBe("ada.okafor+e2e-1@example.edu");
    expect((await signIn(`as=${encodeURIComponent("x@evil.example")}`)).status).toBe(404);
  });

  it("only lands within the site", async () => {
    const { signIn, landsOn } = setup();
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

const mint = (config: AuthConfig, authorization: string) =>
  serveDev(new Request(`${ORIGIN}/dev/token`, { method: "POST", headers: { authorization } }), config, TOKEN);

describe("dev token", () => {
  it("mints an access token that /mcp accepts, and nothing without the dev token", async () => {
    const { config, auth } = setup();
    expect((await mint(config, "Bearer wrong")).status).toBe(404);
    const get = new Request(`${ORIGIN}/dev/token`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect((await serveDev(get, config, TOKEN)).status).toBe(404);
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
