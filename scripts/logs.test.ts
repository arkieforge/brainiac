import { describe, expect, it } from "vite-plus/test";

import { failed, requestFromTail, requestsFromEvents, sinceMs } from "./logs.ts";

const invocation = (requestId: string, status: number, timestamp: number) => ({
  timestamp,
  $metadata: {
    requestId,
    rayId: `ray-${requestId}`,
    message: `POST https://x.test/api/auth/a`,
    level: "info",
  },
  $workers: {
    requestId,
    outcome: "ok",
    event: { request: { method: "POST", url: "https://x.test/api/auth/a" }, response: { status } },
  },
});

describe("requestsFromEvents", () => {
  it("groups log lines under their request and counts a logged error as a failure even on a 200", () => {
    const requests = requestsFromEvents([
      invocation("b", 200, 20),
      invocation("a", 200, 10),
      {
        timestamp: 21,
        $metadata: { requestId: "b", level: "error", message: "send_email: destination not verified" },
      },
    ]);
    expect(requests.map((r) => [r.ray, failed(r)])).toEqual([
      ["ray-a", false],
      ["ray-b", true],
    ]);
    expect(requests[1]!.lines).toEqual(["error: send_email: destination not verified"]);
  });

  it("counts a 500 with no log lines as a failure", () => {
    const [request] = requestsFromEvents([invocation("a", 500, 1)]);
    expect(failed(request!)).toBe(true);
  });
});

describe("requestFromTail", () => {
  it("takes the ray id without its colo, so it matches the ref the site shows", () => {
    const request = requestFromTail({
      outcome: "exception",
      event: {
        request: { method: "GET", url: "https://x.test/", headers: { "cf-ray": "a5a78da64a6ff8fb-SIN" } },
      },
      logs: [],
      exceptions: [{ name: "Error", message: "boom" }],
    });
    expect(request.ray).toBe("a5a78da64a6ff8fb");
    expect(failed(request)).toBe(true);
  });
});

describe("sinceMs", () => {
  it("reads minutes, hours and days, and refuses anything else", () => {
    expect(sinceMs("30m")).toBe(1_800_000);
    expect(sinceMs("2d")).toBe(172_800_000);
    expect(() => sinceMs("1w")).toThrow(/--since/);
  });
});
