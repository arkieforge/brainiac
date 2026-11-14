import { describe, expect, it, vi } from "vite-plus/test";
import type { Env } from "./index.ts";

// `cloudflare:workers` only exists inside workerd; a plain stand-in is enough for routing tests.
// Durable Object behaviour is tested in workerd (base.test.ts).
vi.mock("cloudflare:workers", () => ({ DurableObject: Object }));

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
      new Request("https://brainiac.test/dev/sign-in?token=t"),
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
});
