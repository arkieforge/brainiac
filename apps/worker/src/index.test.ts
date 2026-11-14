import { describe, expect, it, vi } from "vite-plus/test";

// `cloudflare:workers` only exists inside workerd; a plain stand-in is enough for routing tests.
// Durable Object behaviour is tested in the Workers test pool (tracked in its own issue).
vi.mock("cloudflare:workers", () => ({ DurableObject: Object }));

const { default: worker } = await import("./index.ts");

describe("worker", () => {
  it("answers /health", async () => {
    const res = await worker.fetch(new Request("https://brainiac.test/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("404s unknown paths", async () => {
    const res = await worker.fetch(new Request("https://brainiac.test/nope"));
    expect(res.status).toBe(404);
  });
});
