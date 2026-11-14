import { describe, expect, it, vi } from "vite-plus/test";
import type { Env } from "./index.ts";

// `cloudflare:workers` only exists inside workerd; a plain stand-in is enough for routing tests.
// Durable Object behaviour is tested in workerd (base.test.ts).
vi.mock("cloudflare:workers", () => ({ DurableObject: Object }));

// A stand-in for pg's pool. Connects wait until the test opens it, then fail (no database here); it remembers any
// connect made after the pool ended, which the real one refuses ("Cannot use a pool after calling end on the pool").
const pools: FakePool[] = [];
class FakePool {
  ended = false;
  connects = 0;
  connectsAfterEnd = 0;
  private gate = Promise.withResolvers<void>();
  constructor() {
    pools.push(this);
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
vi.mock("pg", () => ({ Pool: FakePool, Client: class {} }));

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
    // Setup can't reach the database yet, so this returning at all shows the 401 doesn't wait for it.
    const res = await worker.fetch(new Request("https://brainiac.test/mcp", { method: "POST" }), env, ctx);
    expect(res.status).toBe(401);
    const pool = pools.at(-1);
    pool?.open();
    await Promise.all(work);
    logged.mockRestore();
    expect(pool?.connects).toBeGreaterThan(0);
    expect(pool?.connectsAfterEnd).toBe(0);
    expect(pool?.ended).toBe(true);
  });
});
