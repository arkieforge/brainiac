import { describe, expect, it, vi } from "vite-plus/test";
import type { Env } from "./index.ts";

// `cloudflare:workers` only exists inside workerd; a plain stand-in is enough for routing tests.
// Durable Object behaviour is tested in workerd (base.test.ts).
vi.mock("cloudflare:workers", () => ({ DurableObject: Object }));

// A stand-in for pg's pool. Connects wait until the test opens it, then fail (no database here); it remembers any
// connect made after the pool ended, which the real one refuses ("Cannot use a pool after calling end on the pool").
const pools: FakePool[] = [];
class FakePool {
  /** Opens every new pool at once, for tests that don't steer the timing. */
  static openAtOnce = false;
  ended = false;
  connects = 0;
  connectsAfterEnd = 0;
  private gate = Promise.withResolvers<void>();
  constructor() {
    pools.push(this);
    if (FakePool.openAtOnce) this.open();
  }
  async connect(): Promise<never> {
    this.connects++;
    if (this.ended) this.connectsAfterEnd++;
    await this.gate.promise;
    throw new Error("no database in tests");
  }
  open() {
    this.gate.resolve();
  }
  async end() {
    this.ended = true;
  }
}
// /health/db's client, which finds no database either.
class FakeClient {
  async connect(): Promise<never> {
    throw new Error("no database in tests");
  }
  async end() {}
}
vi.mock("pg", () => ({ Pool: FakePool, Client: FakeClient }));

const { default: worker } = await import("./index.ts");
// Routing never touches bindings; /health/db is proved against a real stage instead.
const get = (path: string) =>
  worker.fetch(new Request(`https://brainiac.test${path}`), {} as Env, {} as ExecutionContext);

describe("worker", () => {
  it("answers /health", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("404s unknown paths", async () => {
    const res = await get("/nope");
    expect(res.status).toBe(404);
  });

  it("serves the web app's shell for any other page, but not for a missing file", async () => {
    const asked: string[] = [];
    const env = {
      ASSETS: { fetch: async (req: Request) => (asked.push(req.url), new Response("shell")) },
    } as Env;
    const page = (path: string, accept: string) =>
      worker.fetch(
        new Request(`https://brainiac.test${path}`, { headers: { accept } }),
        env,
        {} as ExecutionContext,
      );

    const res = await page("/notes/abc?x=1", "text/html,application/xhtml+xml");
    expect(await res.text()).toBe("shell");
    expect(asked).toEqual(["https://brainiac.test/"]);
    expect((await page("/assets/gone.js", "*/*")).status).toBe(404);
  });

  it("sends plain HTTP to HTTPS before auth runs, keeping the method, path and query", async () => {
    // Over http, Better Auth's MCP plugin refused the http resource URL and every /api/auth request 500ed.
    const res = await worker.fetch(
      new Request("http://brainiac.test/api/auth/email-otp/send-verification-otp?x=1", { method: "POST" }),
      {} as Env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(
      "https://brainiac.test/api/auth/email-otp/send-verification-otp?x=1",
    );
  });

  it("has no dev sign-in on prod, even with a token bound", async () => {
    const env = { STAGE: "prod", DEV_SIGN_IN_TOKEN: "t" } as Env;
    const res = await worker.fetch(
      new Request("https://brainiac.test/dev/sign-in", {
        method: "POST",
        headers: { authorization: "Bearer t" },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
  });

  it("leaves local dev on http://localhost alone", async () => {
    const res = await worker.fetch(
      new Request("http://localhost:1337/health"),
      {} as Env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
  });

  it("keeps the database open until auth's setup is done, even when /mcp answers first", async () => {
    // Better Auth starts its setup (seeding the /mcp resource) as soon as it is made. A request without a token got
    // its 401 first, the pool ended, and the seed then failed and logged an error on every such request.
    const work: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void work.push(promise) } as ExecutionContext;
    const env = {
      STAGE: "pr-1",
      HYPERDRIVE: { connectionString: "postgres://test" },
      BETTER_AUTH_SECRET: "a-test-secret-that-is-long-enough-to-pass",
    } as Env;
    // The failed seed logs through Better Auth's logger; that's expected here.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Setup can't reach the database yet, so this returning at all shows the 401 doesn't wait for it.
      const res = await worker.fetch(new Request("https://brainiac.test/mcp", { method: "POST" }), env, ctx);
      expect(res.status).toBe(401);
      const pool = pools.at(-1);
      pool?.open();
      await Promise.all(work);
      expect(pool?.connects).toBeGreaterThan(0);
      expect(pool?.connectsAfterEnd).toBe(0);
      expect(pool?.ended).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });
});

/** A stand-in for any binding that remembers every call made through it, however deep. */
function recorder(calls: unknown[][]): unknown {
  const fn = (...args: unknown[]) => {
    calls.push(args);
    return proxy;
  };
  const proxy: unknown = new Proxy(fn, {
    get: (_target, key) => (key === "then" ? undefined : (calls.push([key]), proxy)),
  });
  return proxy;
}

// The cross-tenant suite: a record is reached only through a base id from the session or token. Every route
// gets another person's base id every way a request can carry one, and must never pass it to a record.
describe("no route takes a base id from the request", () => {
  const VICTIM = "01M6V1CT1M00000000000000AB";
  // Every route index.ts serves, plus the ones a record would be reached through. A new route goes here.
  const ROUTES = [
    "/health",
    "/health/db",
    "/dev/sign-in",
    "/dev/token",
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
    "/.well-known/oauth-protected-resource/mcp",
    "/api/auth/get-session",
    "/mcp",
    "/consent",
    "/account",
    "/sign-in",
    "/sync",
    "/base",
  ];

  it.each(ROUTES)("%s", async (route) => {
    const calls: unknown[][] = [];
    const work: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void work.push(promise) } as ExecutionContext;
    const env = {
      STAGE: "pr-1",
      HYPERDRIVE: { connectionString: "postgres://test" },
      BETTER_AUTH_SECRET: "a-test-secret-that-is-long-enough-to-pass",
      DEV_SIGN_IN_TOKEN: "not-the-one-sent",
      TURNSTILE_SITE_KEY: "test",
      BASE: recorder(calls),
      BLOBS: recorder(calls),
      JOBS: recorder(calls),
    } as Env;
    const headers = {
      upgrade: "websocket",
      authorization: `Bearer ${VICTIM}`,
      cookie: `base=${VICTIM}`,
      "x-brainiac-base": VICTIM,
      // The DO's own header: a client sending it must not be believed either.
      "x-brainiac-actor": `connection:${VICTIM}`,
    };
    const urls = [
      `https://brainiac.test${route}?base=${VICTIM}&baseId=${VICTIM}&record=${VICTIM}`,
      `https://brainiac.test${route}/${VICTIM}`,
    ];
    FakePool.openAtOnce = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const url of urls) {
        for (const method of ["GET", "POST"]) {
          const body = method === "POST" ? JSON.stringify({ base: VICTIM, baseId: VICTIM }) : null;
          // Only a route that got as far as the database (there is none here) may throw; any other error fails,
          // rather than counting as a route that kept the id out.
          const res = await worker
            .fetch(new Request(url, { method, headers, body }), env, ctx)
            .catch((error: unknown) => {
              if (error instanceof Error && error.message === "no database in tests") return undefined;
              throw error;
            });
          expect(res?.status, `${method} ${url}`).not.toBe(101);
        }
      }
      await Promise.allSettled(work);
    } finally {
      FakePool.openAtOnce = false;
      logged.mockRestore();
    }
    // A forwarded Request or Headers serializes as `{}`, so they are written out: a route that passes the client's
    // own headers along to a record is caught too.
    const seen = JSON.stringify(calls, (_key, value: unknown) =>
      value instanceof Request
        ? { url: value.url, headers: [...value.headers] }
        : value instanceof Headers
          ? [...value]
          : value,
    );
    expect(seen).not.toContain(VICTIM);
  });
});
