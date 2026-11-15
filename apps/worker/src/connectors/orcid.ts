// The ORCID connector (docs/product/features/projects-profiles-links.md): the person signs in to ORCID once
// (OpenID Connect, https://orcid.org/.well-known/openid-configuration), which proves their iD, and their public
// works are read in as proposed papers. This file only talks to ORCID; what the iD and the works do is the
// record's call (packages/base/src/orcid.ts). The iD comes from ORCID's token answer, never from anything typed.
import { bareDoi, bareOrcid, type Work } from "@brainiac/base";
import { type } from "arktype";
import { decodeJwt } from "jose";

import type { Env } from "../env.ts";

/** The ORCID API client, from Doppler (infra/README.md). The connector is off until both exist. */
export interface OrcidApp {
  readonly clientId: string;
  readonly clientSecret: string;
  /** `https://orcid.org`, or ORCID's sandbox everywhere but prod: a sandbox client works only there. */
  readonly issuer: string;
  /** The public API the works are read from, on the same side. */
  readonly api: string;
}

export function orcidApp(env: Env): OrcidApp | undefined {
  const { ORCID_CLIENT_ID: clientId, ORCID_CLIENT_SECRET: clientSecret } = env;
  if (!clientId || !clientSecret) return undefined;
  return env.STAGE === "prod"
    ? { clientId, clientSecret, issuer: "https://orcid.org", api: "https://pub.orcid.org/v3.0" }
    : {
        clientId,
        clientSecret,
        issuer: "https://sandbox.orcid.org",
        api: "https://pub.sandbox.orcid.org/v3.0",
      };
}

/** What the connector asks of a record (the Base DO's methods). */
export interface OrcidRecord {
  linkOrcid(orcid: string, works: readonly Work[]): Promise<{ readonly proposed: number }>;
}

export interface Deps {
  readonly app: OrcidApp;
  readonly fetch: typeof fetch;
  readonly now: () => number;
}

/** How long the person has to finish signing in to ORCID. */
const STATE_MS = 10 * 60 * 1000;

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ]);

const stateText = (userId: string, started: number) =>
  new TextEncoder().encode(`orcid-link:${userId}:${started}`);

/**
 * The `state` the sign-in link carries: when it started and a MAC over that and the signed-in person, so ORCID's
 * answer links only to the person who asked, and only for a few minutes.
 */
async function linkState(secret: string, userId: string, now: number): Promise<string> {
  return `${now}.${hex(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), stateText(userId, now)))}`;
}

async function stateIsTheirs(secret: string, userId: string, state: string | null, now: number) {
  const match = /^(\d+)\.([0-9a-f]{64})$/.exec(state ?? "");
  const started = Number(match?.[1]);
  if (!match?.[2] || !Number.isSafeInteger(started) || started > now || now - started > STATE_MS)
    return false;
  const given = new Uint8Array(match[2].match(/../g)?.map((pair) => parseInt(pair, 16)) ?? []);
  // `verify` compares in constant time.
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), given, stateText(userId, started));
}

const callbackOf = (url: URL) => new URL("/connectors/orcid/callback", url).toString();

/** Where the account page's "Link ORCID" goes: ORCID's own sign-in, asking only to know who the person is. */
export async function linkUrl(app: OrcidApp, url: URL, secret: string, userId: string, now: number) {
  const authorize = new URL("/oauth/authorize", app.issuer);
  authorize.search = new URLSearchParams({
    client_id: app.clientId,
    response_type: "code",
    scope: "openid",
    redirect_uri: callbackOf(url),
    state: await linkState(secret, userId, now),
  }).toString();
  return authorize.toString();
}

// Only what Brainiac keeps, from https://info.orcid.org/documentation/api-tutorials/ (`/oauth/token`).
const TokenAnswer = type({ access_token: "string", id_token: "string" });

/**
 * The iD behind an authorization `code`, from the ID token ORCID's token endpoint hands this client directly (so
 * TLS vouches for it, OpenID Connect Core 3.1.3.7), checked to be ORCID's and for this client.
 */
async function proveOrcid(
  deps: Deps,
  code: string,
  url: URL,
): Promise<{ orcid: string; token: string } | undefined> {
  const response = await deps.fetch(new URL("/oauth/token", deps.app.issuer), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: deps.app.clientId,
      client_secret: deps.app.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackOf(url),
    }),
  });
  if (!response.ok) return undefined;
  const answer = TokenAnswer(await response.json());
  if (answer instanceof type.errors) return undefined;
  const claims = decodeJwt(answer.id_token);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== deps.app.issuer || !audience.includes(deps.app.clientId)) return undefined;
  const orcid = bareOrcid(claims.sub ?? "");
  return orcid === undefined ? undefined : { orcid, token: answer.access_token };
}

// The kinds of ORCID work a Paper stands for; datasets, software, talks and the rest aren't papers.
const PAPER_KINDS = new Set([
  "book",
  "book-chapter",
  "conference-abstract",
  "conference-paper",
  "conference-poster",
  "dissertation-thesis",
  "journal-article",
  "preprint",
  "report",
  "review",
  "working-paper",
]);

const ExternalIds = type({
  "external-id?": type({
    "external-id-type": "string",
    "external-id-value": "string",
    "external-id-relationship?": "string | null",
  }).array(),
});

// From https://pub.orcid.org/v3.0/ (`/{orcid}/works`): one group per work, its sources' summaries inside.
const Works = type({
  "group?": type({
    "external-ids?": ExternalIds.or("null"),
    "work-summary": type({
      "put-code": "number | string",
      "title?": type({ "title?": type({ value: "string" }).or("null") }).or("null"),
      "type?": "string",
    }).array(),
  }).array(),
});

/** The person's public works that are papers, each once, with its own DOI if it has one. */
async function readWorks(deps: Deps, orcid: string, token: string): Promise<Work[]> {
  const response = await deps.fetch(`${deps.app.api}/${orcid}/works`, {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`ORCID answered ${response.status} for the works`);
  return (Works.assert(await response.json()).group ?? []).flatMap((group): Work[] => {
    const [summary] = group["work-summary"];
    const title = summary?.title?.title?.value.trim();
    if (!summary || !title || !PAPER_KINDS.has(summary.type ?? "")) return [];
    const doi = group["external-ids"]?.["external-id"]
      ?.filter((id) => id["external-id-type"] === "doi" && id["external-id-relationship"] !== "part-of")
      .map((id) => bareDoi(id["external-id-value"]))
      .find((found) => found !== undefined);
    return [{ putCode: String(summary["put-code"]), title, ...(doi && { doi }) }];
  });
}

/**
 * Where ORCID sends the person back: our `state` and the `code` of their ORCID sign-in. The iD is linked to their
 * record only if the state is theirs and ORCID vouches for the iD; then their works are proposed.
 */
export async function callback(
  url: URL,
  person: { readonly userId: string; readonly record: OrcidRecord },
  secret: string,
  deps: Deps,
): Promise<Response> {
  const done = (outcome: string) =>
    Response.redirect(new URL(`/account?orcid=${outcome}`, url).toString(), 303);
  if (url.searchParams.get("error") === "access_denied") return done("denied");
  const code = url.searchParams.get("code");
  if (!code || !(await stateIsTheirs(secret, person.userId, url.searchParams.get("state"), deps.now())))
    return done("failed");
  const proved = await proveOrcid(deps, code, url);
  if (!proved) return done("failed");
  let works: Work[] = [];
  try {
    works = await readWorks(deps, proved.orcid, proved.token);
  } catch (error) {
    // Linked all the same: linking again reads the works.
    console.error("orcid works read failed", error);
  }
  await person.record.linkOrcid(proved.orcid, works);
  return done("linked");
}
