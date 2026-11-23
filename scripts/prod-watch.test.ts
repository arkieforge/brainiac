import { describe, expect, it } from "vite-plus/test";

import type { RequestLog } from "./logs.ts";
import { filed, maskPath, problems } from "./prod-watch.ts";

const request = (over: Partial<RequestLog>): RequestLog => ({
  time: 0,
  ray: "r",
  method: "GET",
  url: "https://x.test/api/proposals",
  status: 200,
  outcome: "ok",
  lines: [],
  errored: false,
  ...over,
});

describe("maskPath", () => {
  it("keeps route words and masks ids, emails and anything a person typed in capitals", () => {
    expect(maskPath("https://x.test/api/auth/email-otp/send-verification-otp?email=a@b.c")).toBe(
      "/api/auth/email-otp/send-verification-otp",
    );
    expect(maskPath("https://x.test/n/01JD5Y9Q2B3C4D5E6F7G8H9J0K")).toBe("/n/:id");
    expect(maskPath("https://x.test/u/nadia.karim@example.edu/Nadia")).toBe("/u/:id/:id");
    expect(maskPath("https://x.test/f/3f2a9c1e-77b0-4d1e-9a51-0c6f1e2d3b4a")).toBe("/f/:id");
  });
});

describe("problems", () => {
  it("groups failed requests by kind with their latest refs, and never copies a log line", () => {
    const found = problems(
      [{ name: "Database reachable through Hyperdrive", fix: "/health/db failed" }],
      [
        request({ ray: "a", time: 1, status: 500, url: "https://x.test/n/01JD5Y9Q2B3C4D5E6F7G8H9J0K" }),
        request({ ray: "b", time: 2, status: 500, url: "https://x.test/n/01JD5Y9Q2B3C4D5E6F7G8H9J0L" }),
        request({ ray: "c", errored: true, lines: ["error: no mail to nadia.karim@example.edu"] }),
        request({ ray: "d" }),
        request({
          ray: "e",
          method: "POST",
          url: "https://x.test/mcp",
          status: undefined,
          outcome: "canceled",
        }),
      ],
    );
    expect(found.map((p) => p.title)).toEqual([
      'prod: doctor fails "Database reachable through Hyperdrive"',
      "prod: GET /n/:id 500 ok",
      "prod: GET /api/proposals 200 ok, logged an error",
    ]);
    expect(found[1]!.body).toContain("2 failed requests");
    expect(found[1]!.body).toContain("`a`, `b`");
    expect(found.map((p) => p.body).join()).not.toContain("nadia");
  });
});

describe("filed", () => {
  it("skips open issues and ones closed as not planned, and files again what a fix closed", () => {
    const titles = filed([
      { title: "open", state: "OPEN", stateReason: "" },
      { title: "expected", state: "CLOSED", stateReason: "NOT_PLANNED" },
      { title: "fixed", state: "CLOSED", stateReason: "COMPLETED" },
    ]);
    expect([...titles]).toEqual(["open", "expected"]);
  });
});
