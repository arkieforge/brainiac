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
});
