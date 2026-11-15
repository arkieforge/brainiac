// The GitHub connector (docs/product/features/projects-profiles-links.md): our GitHub App, installed on the repos
// the person picks, feeds their record through webhooks and a daily sweep. This file only talks to GitHub and
// Neon; what a repo does to the record is the record's call (packages/base/src/github.ts).
//
// Which record an installation feeds comes from `github_links` (infra/migrations/0004_github.sql), written only
// after the signed-in person proves through GitHub that they can reach the installation. Nothing in a webhook or
// URL names a record.
import type { Repo } from "@brainiac/base";
import { importPKCS8, SignJWT } from "jose";

import type { Env } from "../env.ts";
import type { Db } from "../registry.ts";

/** The App's settings, from Doppler (infra/README.md). The connector is off until all of them exist. */
export interface GithubApp {
  /** The App's URL name: `github.com/apps/<slug>`. */
  readonly slug: string;
  /** Also the JWT issuer: GitHub accepts the client id in place of the App id. */
  readonly clientId: string;
  readonly clientSecret: string;
  /** PKCS#8 PEM (`openssl pkcs8 -topk8 -nocrypt` turns GitHub's download into it). */
  readonly privateKey: string;
  readonly webhookSecret: string;
}

export function githubApp(env: Env): GithubApp | undefined {
  const {
    GITHUB_APP_SLUG: slug,
    GITHUB_APP_CLIENT_ID: clientId,
    GITHUB_APP_CLIENT_SECRET: clientSecret,
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_WEBHOOK_SECRET: webhookSecret,
  } = env;
  return slug && clientId && clientSecret && privateKey && webhookSecret
    ? { slug, clientId, clientSecret, privateKey, webhookSecret }
    : undefined;
}

/** What the connector asks of a record (the Base DO's methods). */
export interface GithubRecord {
  githubRepos(repos: readonly Repo[]): Promise<unknown>;
  githubRepoDeleted(repoId: string): Promise<unknown>;
}

export interface Deps {
  readonly app: GithubApp;
  readonly db: Db;
  readonly record: (baseId: string) => GithubRecord;
  readonly fetch: typeof fetch;
  readonly now: () => number;
}

/** The daily sweep's cron (alchemy.run.ts): 03:00 UTC. */
export const SWEEP_CRON = "0 3 * * *";

const API = "https://api.github.com";
const PAGE = 100;

/** GitHub said to slow down; the sweep stops for this installation and tries again tomorrow. */
class RateLimited extends Error {
  override readonly name = "RateLimited";
}

async function github(deps: Deps, path: string, token: string, init: RequestInit = {}): Promise<Response> {
  const response = await deps.fetch(path.startsWith("https://") ? path : `${API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "brainiac",
      "x-github-api-version": "2022-11-28",
      ...init.headers,
    },
  });
  const limited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));
  if (limited) throw new RateLimited(`GitHub rate limit on ${path}`);
  if (!response.ok && response.status !== 304)
    throw new Error(`GitHub ${response.status} on ${path}: ${await response.text()}`);
  return response;
}

/** A short-lived JWT that speaks for the App itself, signed with its private key. */
async function appJwt(app: GithubApp, now: number): Promise<string> {
  const key = await importPKCS8(app.privateKey, "RS256");
  const seconds = Math.floor(now / 1000);
  // Backdated a minute for clock drift; GitHub refuses one that lives more than ten.
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(app.clientId)
    .setIssuedAt(seconds - 60)
    .setExpirationTime(seconds + 540)
    .sign(key);
}

/** An hour's token for one installation: it reads only the repos the person picked. */
async function installationToken(deps: Deps, installationId: number): Promise<string> {
  const response = await github(
    deps,
    `/app/installations/${installationId}/access_tokens`,
    await appJwt(deps.app, deps.now()),
    { method: "POST" },
  );
  const { token } = (await response.json()) as { token: string };
  return token;
}

/** A repo as GitHub's REST API and webhooks describe it; anything else is skipped. */
function repoOf(value: unknown): Repo | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  if (
    typeof r["node_id"] !== "string" ||
    typeof r["full_name"] !== "string" ||
    typeof r["html_url"] !== "string"
  )
    return undefined;
  const pushed = r["pushed_at"];
  return {
    id: r["node_id"],
    name: r["full_name"],
    url: r["html_url"],
    private: r["private"] === true,
    archived: r["archived"] === true,
    stars: typeof r["stargazers_count"] === "number" ? r["stargazers_count"] : 0,
    language: typeof r["language"] === "string" ? r["language"] : null,
    // REST and most webhooks send ISO text; a push event sends seconds.
    pushed:
      typeof pushed === "string"
        ? pushed.slice(0, 10)
        : typeof pushed === "number"
          ? new Date(pushed * 1000).toISOString().slice(0, 10)
          : null,
  };
}

/**
 * The installation's repos, page by page. With the ETags of the last sweep, a page that hasn't changed answers
 * 304, which costs nothing against the rate limit, and brings no repos: only changed pages come back.
 */
async function listRepos(
  deps: Deps,
  token: string,
  etags: readonly string[],
): Promise<{ readonly repos: Repo[]; readonly etags: string[] }> {
  const repos: Repo[] = [];
  const next: string[] = [];
  for (let page = 1; ; page++) {
    const etag = etags[page - 1];
    const response = await github(deps, `/installation/repositories?per_page=${PAGE}&page=${page}`, token, {
      headers: etag ? { "if-none-match": etag } : {},
    });
    if (response.status === 304) {
      next.push(etag ?? "");
      // An unchanged page says nothing of the pages after it; the last sweep's count of pages does.
      if (page >= etags.length) break;
      continue;
    }
    const body = (await response.json()) as { total_count: number; repositories: unknown[] };
    for (const raw of body.repositories) {
      const repo = repoOf(raw);
      if (repo) repos.push(repo);
    }
    next.push(response.headers.get("etag") ?? "");
    if (page * PAGE >= body.total_count) break;
  }
  return { repos, etags: next };
}

const linkedBases = async (db: Db, installationId: number) =>
  (
    await db.query<{ baseId: string }>(`select "baseId" from "github_links" where "installationId" = $1`, [
      installationId,
    ])
  ).rows.map((row) => row.baseId);

/**
 * Reads one installation's repos into every record linked to it. `only` is a record that just linked: it reads
 * the whole list, unconditionally, into that record alone, and leaves the others' ETags as they were.
 */
async function sweepInstallation(deps: Deps, installationId: number, only?: string): Promise<number> {
  const bases = only === undefined ? await linkedBases(deps.db, installationId) : [only];
  if (bases.length === 0) return 0;
  const { rows } = await deps.db.query<{ etags: string }>(
    `select "etags" from "github_installations" where "id" = $1`,
    [installationId],
  );
  const stored: string[] = only === undefined ? JSON.parse(rows[0]?.etags ?? "[]") : [];
  const token = await installationToken(deps, installationId);
  const { repos, etags } = await listRepos(deps, token, stored);
  if (repos.length > 0) await Promise.all(bases.map((base) => deps.record(base).githubRepos(repos)));
  if (only === undefined)
    await deps.db.query(`update "github_installations" set "etags" = $2, "checkedAt" = $3 where "id" = $1`, [
      installationId,
      JSON.stringify(etags),
      new Date(deps.now()),
    ]);
  return repos.length;
}

/**
 * The daily sweep: every linked, unsuspended installation, one at a time. One that fails or is rate limited is
 * logged and tried again tomorrow; webhooks carry the changes in between.
 */
// shortcut: one cron run walks every installation in turn; fan it out over the jobs queue when the number of
// installations nears the Worker's subrequest limit.
export async function sweep(deps: Deps): Promise<{ readonly swept: number; readonly failed: number }> {
  const { rows } = await deps.db.query<{ id: string }>(
    `select distinct i."id" from "github_installations" i join "github_links" l on l."installationId" = i."id"
     where not i."suspended" order by i."id"`,
    [],
  );
  let swept = 0;
  let failed = 0;
  for (const { id } of rows) {
    try {
      await sweepInstallation(deps, Number(id));
      swept++;
    } catch (error) {
      failed++;
      console.error("github sweep failed", id, error);
    }
  }
  return { swept, failed };
}

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ]);

/** Whether `signature` (`x-hub-signature-256`) is GitHub's HMAC of `body` under the webhook secret. */
async function signedByGithub(secret: string, body: string, signature: string | null): Promise<boolean> {
  const match = /^sha256=([0-9a-f]{64})$/.exec(signature ?? "");
  if (!match?.[1]) return false;
  const bytes = new Uint8Array(match[1].match(/../g)?.map((pair) => parseInt(pair, 16)) ?? []);
  // `verify` compares in constant time.
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), bytes, new TextEncoder().encode(body));
}

/**
 * One webhook delivery. Only GitHub's signature lets it in; it can only reach records already linked to its
 * installation, and it carries repo facts, never a record id.
 */
export async function webhook(request: Request, deps: Deps): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await request.text();
  if (!(await signedByGithub(deps.app.webhookSecret, body, request.headers.get("x-hub-signature-256"))))
    return new Response("Bad signature", { status: 401 });
  const event = request.headers.get("x-github-event");
  const payload = JSON.parse(body) as {
    action?: string;
    installation?: { id?: number };
    repository?: unknown;
  };
  const installationId = payload.installation?.id;
  if (event === "ping" || typeof installationId !== "number") return new Response(null, { status: 204 });

  if (event === "installation") {
    if (payload.action === "deleted")
      await deps.db.query(`delete from "github_installations" where "id" = $1`, [installationId]);
    else if (payload.action === "suspend" || payload.action === "unsuspend")
      await deps.db.query(`update "github_installations" set "suspended" = $2 where "id" = $1`, [
        installationId,
        payload.action === "suspend",
      ]);
    return new Response(null, { status: 204 });
  }
  const bases = await linkedBases(deps.db, installationId);
  if (bases.length === 0) return new Response(null, { status: 204 });
  // A repo the person added to the installation: the list brings it with its stars and language, which the
  // event leaves out. A removed one keeps its project as it last was.
  if (event === "installation_repositories" && payload.action === "added") {
    for (const base of bases) await sweepInstallation(deps, installationId, base);
  } else if (event === "repository" || event === "star") {
    const repo = repoOf(payload.repository);
    if (repo && event === "repository" && payload.action === "deleted")
      await Promise.all(bases.map((base) => deps.record(base).githubRepoDeleted(repo.id)));
    else if (repo) await Promise.all(bases.map((base) => deps.record(base).githubRepos([repo])));
  }
  return new Response(null, { status: 204 });
}

/**
 * The `state` the install link carries for the signed-in person, which the setup route checks, so a link someone
 * else started can't attach their installation to this person's record.
 */
export async function installState(secret: string, userId: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    new TextEncoder().encode(`github-install:${userId}`),
  );
  return hex(mac);
}

/** Where the account page's "Connect GitHub" goes: GitHub's own page for picking repos. */
export const installUrl = async (app: GithubApp, secret: string, userId: string) =>
  `https://github.com/apps/${app.slug}/installations/new?state=${await installState(secret, userId)}`;

/**
 * Whether `installationId` is on the GitHub account behind an OAuth `code`. Only the person's own account: reaching
 * an organization's installation doesn't mean they can see every repo on it, and linking it would read them all in.
 */
async function ownInstallation(
  deps: Deps,
  code: string,
  installationId: number,
): Promise<{ account: string } | "organization" | undefined> {
  const exchanged = await deps.fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "brainiac" },
    body: JSON.stringify({ client_id: deps.app.clientId, client_secret: deps.app.clientSecret, code }),
  });
  const { access_token: token } = (await exchanged.json()) as { access_token?: string };
  if (!token) return undefined;
  const user = (await (await github(deps, "/user", token)).json()) as { id: number; login: string };
  for (let page = 1; ; page++) {
    const response = await github(deps, `/user/installations?per_page=${PAGE}&page=${page}`, token);
    const body = (await response.json()) as {
      total_count: number;
      installations: { id: number; account?: { id?: number } }[];
    };
    const found = body.installations.find((installation) => installation.id === installationId);
    if (found) return found.account?.id === user.id ? { account: user.login } : "organization";
    if (page * PAGE >= body.total_count) return undefined;
  }
}

/**
 * Where GitHub sends the person after they pick repos: `installation_id`, the `code` of their GitHub sign-in and
 * our `state`. The installation is linked to their record only if the state is theirs and it is on their own GitHub
 * account; then its repos are read in at once.
 */
export async function setup(
  url: URL,
  person: { readonly userId: string; readonly baseId: string },
  secret: string,
  deps: Deps,
): Promise<Response> {
  const done = (outcome: string) =>
    Response.redirect(new URL(`/account?github=${outcome}`, url).toString(), 303);
  const installationId = Number(url.searchParams.get("installation_id"));
  const code = url.searchParams.get("code");
  // An organization owner still has to approve the install: GitHub sends no installation yet.
  if (url.searchParams.get("setup_action") === "request") return done("requested");
  if (!Number.isSafeInteger(installationId) || installationId <= 0 || !code) return done("failed");
  if (url.searchParams.get("state") !== (await installState(secret, person.userId))) return done("failed");
  const reached = await ownInstallation(deps, code, installationId);
  // shortcut: organization installations aren't linked; reading one in needs each repo checked against what the
  // person can see on GitHub, for every sweep and webhook.
  if (reached === "organization") return done("organization");
  if (!reached) return done("failed");
  await deps.db.query(
    `insert into "github_installations" ("id", "account") values ($1, $2)
     on conflict ("id") do update set "account" = excluded."account"`,
    [installationId, reached.account],
  );
  await deps.db.query(
    `insert into "github_links" ("installationId", "baseId") values ($1, $2) on conflict do nothing`,
    [installationId, person.baseId],
  );
  try {
    await sweepInstallation(deps, installationId, person.baseId);
  } catch (error) {
    // Linked all the same: the daily sweep reads it in.
    console.error("github first read failed", installationId, error);
  }
  return done("connected");
}

/** An installation linked to a record, for the account page. */
export interface Linked {
  readonly id: number;
  readonly account: string;
  readonly checkedAt: Date | null;
  readonly suspended: boolean;
}

export async function linked(db: Db, baseId: string): Promise<Linked[]> {
  const { rows } = await db.query<{
    id: string;
    account: string;
    checkedAt: Date | null;
    suspended: boolean;
  }>(
    `select i."id", i."account", i."checkedAt", i."suspended" from "github_links" l
     join "github_installations" i on i."id" = l."installationId" where l."baseId" = $1 order by i."account"`,
    [baseId],
  );
  return rows.map((row) => ({ ...row, id: Number(row.id) }));
}

/** Stops an installation feeding this record. The App stays installed on GitHub until the person removes it there. */
export async function unlink(db: Db, baseId: string, installationId: number): Promise<void> {
  await db.query(`delete from "github_links" where "installationId" = $1 and "baseId" = $2`, [
    installationId,
    baseId,
  ]);
}
