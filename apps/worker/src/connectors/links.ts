// The links connector's read (docs/product/features/projects-profiles-links.md): whether a page the person saved
// is still there, and on the first read at an address, its text through treg `web.extract` and a PDF of it through
// Browser Rendering. Only a 404 or a 410 says a page is gone; anything else that isn't an answer is unchecked, with
// why, so a site that turns robots away is never called dead.
import type { LinkSeen, LinkWork } from "@brainiac/base";
import { type } from "arktype";

import type { Web } from "./doi.ts";

const TREG = "https://treg.to/call/treg.web.extract";
/** The most one extract may cost, in USD: providers that bill a miss are tried in turn, cheapest first. */
const MAX_COST = "0.02";
/** A generic client name, never the person's details. */
const USER_AGENT = "Brainiac link check (https://github.com/arkieforge/brainiac)";
/** The largest snapshot kept; a bigger PDF is left out, and the link still checked. */
const MAX_SNAPSHOT = 10 * 1024 * 1024;

/** Prints a page to PDF: Browser Rendering's `pdf` quick action, or a test answering in its place. */
export type Printer = (url: string) => Promise<Response>;

/** What one read brings back: the answer, and the snapshot's bytes when this read took one. */
export interface LinkRead {
  readonly seen: LinkSeen;
  readonly pdf?: Uint8Array;
}

// treg's routed answer; each provider's page object has its own shape, so only the common keys are read.
const ExtractAnswer = type({ output: { pages: type({ "title?": "unknown", "text?": "unknown" }).array() } });
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** Whether the page is there: a 404 or 410 is gone, a 2xx is live, anything else couldn't be told. */
async function health(web: Web, url: string): Promise<LinkSeen> {
  let response: Response;
  try {
    response = await web(url, { method: "GET", redirect: "follow", headers: { "user-agent": USER_AGENT } });
  } catch {
    return { status: "unchecked", why: "it couldn't be reached" };
  }
  // Only the status matters: the body is never read, so a large page costs nothing.
  await response.body?.cancel();
  if (response.status === 404 || response.status === 410) return { status: "dead", code: response.status };
  if (response.ok) return { status: "live" };
  return { status: "unchecked", why: `it answered ${response.status}` };
}

/** The page's title and text through treg, or nothing when it can't give them. */
async function extract(web: Web, token: string, url: string): Promise<{ title?: string; text?: string }> {
  try {
    const response = await web(TREG, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-treg-token": token,
        "x-treg-route-max-cost": MAX_COST,
      },
      body: JSON.stringify({ url }),
    });
    if (!response.ok) return {};
    const answer = ExtractAnswer(await response.json());
    if (answer instanceof type.errors) return {};
    const [page] = answer.output.pages;
    const title = text(page?.title);
    const body = text(page?.text);
    return { ...(title && { title }), ...(body && { text: body }) };
  } catch {
    return {};
  }
}

/** The page as a PDF, or nothing: the snapshot is evidence on top, never a reason the check fails. */
async function snapshot(print: Printer, url: string): Promise<Uint8Array | undefined> {
  try {
    const response = await print(url);
    // Logged without the address, which is the person's: only that a snapshot failed, and how.
    if (!response.ok) {
      console.error("link snapshot refused", { status: response.status });
      return undefined;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const pdf = new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
    return pdf && bytes.byteLength <= MAX_SNAPSHOT ? bytes : undefined;
  } catch (error) {
    console.error("link snapshot failed", { error: String(error).replaceAll(/https?:\/\/\S+/g, "<url>") });
    return undefined;
  }
}

/**
 * Reads `work`'s page. A page that is there, read for the first time at its address, also gets its text (when the
 * stage has a treg token and the note isn't sensitive) and a snapshot (when the stage has Browser Rendering).
 */
export async function readLink(
  work: LinkWork,
  outside: { readonly token?: string | undefined; readonly print?: Printer | undefined },
  web: Web = fetch,
): Promise<LinkRead> {
  const seen = await health(web, work.url);
  if (seen.status !== "live") return { seen };
  const [found, pdf] = await Promise.all([
    work.extract && outside.token ? extract(web, outside.token, work.url) : {},
    work.capture && outside.print ? snapshot(outside.print, work.url) : undefined,
  ]);
  return { seen: { status: "live", ...found }, ...(pdf && { pdf }) };
}
