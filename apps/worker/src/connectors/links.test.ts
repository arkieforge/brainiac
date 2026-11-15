// Checking a saved link: what counts as gone, and what the first read at an address takes. The record's half (when
// a link is checked, what is kept) runs on both engines in packages/base/test/links-cases.ts.
import { expect, it } from "vite-plus/test";

import type { Web } from "./doi.ts";
import { readLink, type Printer } from "./links.ts";

const URL = "https://example.org/scholarships/daad";
const TOKEN = "treg-test-token";
const PDF = new TextEncoder().encode("%PDF-1.7\nDAAD scholarship database\n%%EOF\n");

/** The page answering `status`, and treg answering an extract; every call is in `asked`. */
function outside(status: number | "down", extract: unknown = { output: { pages: [] } }) {
  const asked: { url: string; body?: unknown; headers: Record<string, string> }[] = [];
  const web: Web = async (url, init) => {
    asked.push({
      url,
      headers: Object.fromEntries(new Headers(init.headers)),
      ...(init.body !== undefined && { body: JSON.parse(String(init.body)) }),
    });
    if (url.startsWith("https://treg.to/")) return Response.json(extract);
    if (status === "down") throw new Error("offline");
    return new Response("page", { status });
  };
  const printed: string[] = [];
  const print: Printer = async (url) => {
    printed.push(url);
    return new Response(PDF, { headers: { "content-type": "application/pdf" } });
  };
  return { web, asked, print, printed };
}

const first = { url: URL, capture: true, extract: true };
const weekly = { url: URL, capture: false, extract: false };
const seen = async (status: number | "down") => (await readLink(weekly, {}, outside(status).web)).seen;
const html: Printer = async () => new Response("<html>blocked</html>");
const broken: Printer = () => Promise.reject(new Error("browser busy"));

it("only a 404 or a 410 is gone; a refusal, a server error or no answer is unchecked, with why", async () => {
  expect(await seen(404)).toEqual({ status: "dead", code: 404 });
  expect(await seen(410)).toEqual({ status: "dead", code: 410 });
  expect(await seen(200)).toEqual({ status: "live" });
  expect(await seen(403)).toEqual({ status: "unchecked", why: "it answered 403" });
  expect(await seen(503)).toEqual({ status: "unchecked", why: "it answered 503" });
  expect(await seen("down")).toEqual({ status: "unchecked", why: "it couldn't be reached" });
});

it("the first read takes the page's text through treg, capped in cost, and a PDF snapshot", async () => {
  const world = outside(200, {
    output: { pages: [{ url: URL, title: "DAAD Scholarship Database", text: "Find a scholarship." }] },
    raw: {},
    _treg: { served_by: "fixture" },
  });
  const read = await readLink(first, { token: TOKEN, print: world.print }, world.web);
  expect(read.seen).toEqual({
    status: "live",
    title: "DAAD Scholarship Database",
    text: "Find a scholarship.",
  });
  expect(read.pdf).toEqual(PDF);
  expect(world.printed).toEqual([URL]);
  // Only the address goes to treg.
  expect(world.asked.find((a) => a.url.startsWith("https://treg.to/"))).toEqual({
    url: "https://treg.to/call/treg.web.extract",
    body: { url: URL },
    headers: { "content-type": "application/json", "x-treg-token": TOKEN, "x-treg-route-max-cost": "0.02" },
  });
});

it("a weekly check or a gone page reads nothing more; a sensitive link or a stage without treg never asks treg", async () => {
  for (const [work, token, status, printed] of [
    [weekly, TOKEN, 200, []],
    [first, TOKEN, 404, []],
    [{ ...first, extract: false }, TOKEN, 200, [URL]],
    [first, undefined, 200, [URL]],
  ] as const) {
    const world = outside(status);
    await readLink(work, { token, print: world.print }, world.web);
    expect(world.asked.filter((a) => a.url.startsWith("https://treg.to/"))).toEqual([]);
    expect(world.printed).toEqual(printed);
  }
});

it("a snapshot that isn't a PDF, or fails, is left out and the check still stands", async () => {
  const world = outside(200);
  expect(await readLink({ ...first, extract: false }, { print: html }, world.web)).toEqual({
    seen: { status: "live" },
  });
  expect(await readLink({ ...first, extract: false }, { print: broken }, world.web)).toEqual({
    seen: { status: "live" },
  });
});
