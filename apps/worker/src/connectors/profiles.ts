// The profiles connector's read (docs/product/features/projects-profiles-links.md): what one of the person's own
// public profiles shows, through treg (docs/operations/services.md), which holds the providers' keys and picks the
// one that answers. LinkedIn and X are read by the profile's link; Google Scholar is searched for the record's own
// paper titles. A read that fails in any way comes back `unchecked` with why, never as an empty profile.
import type { ProfileSeen, ProfileWork } from "@brainiac/base";
import { titleKey, type ScholarSays } from "@brainiac/core";
import { type } from "arktype";

import type { Web } from "./doi.ts";

const TREG = "https://treg.to/call/";
/**
 * The most one call may cost, in USD. A routed call moves on to the next provider when one misses, and some bill a
 * miss; a profile is worth a few tenths of a cent, so the waterfall stops well before treg's $1 default.
 */
const MAX_COST = "0.02";

/** A LinkedIn member's link (`linkedin.com/in/<handle>`), as treg takes it. */
function linkedinUrl(url: string): string | undefined {
  const handle = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#\s]+)\/?(?:[?#].*)?$/i.exec(
    url.trim(),
  )?.[1];
  return handle === undefined ? undefined : `https://www.linkedin.com/in/${handle}`;
}

/** An X username from `x.com/<name>`, `twitter.com/<name>` or `@name`. */
function xUsername(url: string): string | undefined {
  const text = url.trim();
  const name =
    /^@?([A-Za-z0-9_]{1,15})$/.exec(text)?.[1] ??
    /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/i.exec(text)?.[1];
  return name;
}

const Text = type("string | null | undefined");
// treg's routed answer is `{output, raw, _treg}`; `output` follows the capability's contract (catalog_get).
const LinkedInAnswer = type({
  output: { "full_name?": Text, "headline?": Text, "about?": Text, "location?": Text },
});
const XAnswer = type({ output: { "username?": Text, "name?": Text, "description?": Text } });
// Serper's Scholar answer, relayed unchanged. A search that ran always has `organic`, empty when nothing matched;
// an answer without it (an error object) says nothing about whether the paper is listed.
const ScholarAnswer = type({ organic: type({ "title?": "string", "year?": "number | string" }).array() });

const text = (value: string | null | undefined) => (value?.trim() ? value.trim() : undefined);

/** One treg call: the answer, or why there is none. */
async function call(
  web: Web,
  token: string,
  endpoint: string,
  body: object,
): Promise<{ readonly answer: unknown } | { readonly unchecked: string }> {
  let response: Response;
  try {
    response = await web(`${TREG}${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-treg-token": token,
        "x-treg-route-max-cost": MAX_COST,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { unchecked: "it couldn't be reached" };
  }
  // A provider's refusal or a block costs nothing and says nothing about the profile.
  if (!response.ok) return { unchecked: `the read was refused (${response.status})` };
  try {
    return { answer: await response.json() };
  } catch {
    return { unchecked: "the answer couldn't be read" };
  }
}

async function linkedin(web: Web, token: string, url: string): Promise<ProfileSeen> {
  const link = linkedinUrl(url);
  if (link === undefined) return { unchecked: "that isn't a LinkedIn profile link" };
  const got = await call(web, token, "treg.linkedin.user.profile", { linkedin_url: link });
  if ("unchecked" in got) return got;
  const answer = LinkedInAnswer(got.answer);
  if (answer instanceof type.errors) return { unchecked: "the answer wasn't a profile" };
  const { output } = answer;
  // treg's miss: no provider showed the profile (private, removed, or blocked).
  const name = text(output.full_name);
  if (name === undefined) return { unchecked: "it didn't show this profile" };
  const headline = text(output.headline);
  const about = text(output.about);
  const location = text(output.location);
  return {
    says: { name, ...(headline && { headline }), ...(about && { about }), ...(location && { location }) },
  };
}

async function x(web: Web, token: string, url: string): Promise<ProfileSeen> {
  const username = xUsername(url);
  if (username === undefined) return { unchecked: "that isn't an X profile link" };
  const got = await call(web, token, "treg.x.user.profile", { username });
  if ("unchecked" in got) return got;
  const answer = XAnswer(got.answer);
  if (answer instanceof type.errors) return { unchecked: "the answer wasn't a profile" };
  const { output } = answer;
  if (text(output.username) === undefined) return { unchecked: "it didn't show this profile" };
  const name = text(output.name);
  const about = text(output.description);
  return { says: { ...(name && { name }), ...(about && { about }) } };
}

/** Google Scholar's answer for one title: the listing whose title is the same, letter for letter. */
async function scholarSays(web: Web, token: string, title: string): Promise<ScholarSays> {
  const got = await call(web, token, "serper.google.serp.scholar", { q: title });
  if ("unchecked" in got) return "unchecked";
  const answer = ScholarAnswer(got.answer);
  if (answer instanceof type.errors) return "unchecked";
  const hit = answer.organic.find(
    (row) => row.title !== undefined && titleKey(row.title) === titleKey(title),
  );
  if (!hit) return "missing";
  const year = Number(hit.year);
  return Number.isInteger(year) && year > 1000 ? year : "listed";
}

/**
 * What `work`'s site shows. Without a treg token (a stage that has none) every profile is unchecked, and says so.
 */
export async function readProfile(
  work: ProfileWork,
  token: string | undefined,
  web: Web = fetch,
): Promise<ProfileSeen> {
  if (!token) return { unchecked: "drift checks aren't set up here yet" };
  if (work.site !== "scholar")
    return work.site === "linkedin" ? linkedin(web, token, work.url) : x(web, token, work.url);
  const papers = await Promise.all(
    work.papers.map(
      async (paper) =>
        [paper.id, { title: paper.title, says: await scholarSays(web, token, paper.title) }] as const,
    ),
  );
  return { papers: Object.fromEntries(papers) };
}
