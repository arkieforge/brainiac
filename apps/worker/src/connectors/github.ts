// The GitHub connector (docs/product/features/projects-profiles-links.md): our GitHub App, installed on the repos
// the person picks, feeds their record through webhooks and a daily sweep. This file only talks to GitHub and
// Neon; what a repo does to the record is the record's call (packages/base/src/github.ts).
//
// Which record an installation feeds comes from `github_links` (infra/migrations/0004_github.sql), written only
// after the signed-in person proves through GitHub that they can reach the installation. Nothing in a webhook or
// URL names a record. On an organization's installation a member may not see every repo, so their link reads only
// the repos their own GitHub sign-in can see there (0006_github_organizations.sql), checked again on every sweep.
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
  /** The auth secret: it signs the install link's state and seals a member's GitHub sign-in. */
  readonly secret: string;
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
  path: string,
  token: string,
  etags: readonly string[],
): Promise<{ readonly repos: Repo[]; readonly etags: string[] }> {
  const repos: Repo[] = [];
  const next: string[] = [];
  for (let page = 1; ; page++) {
    const etag = etags[page - 1];
    const response = await github(deps, `${path}?per_page=${PAGE}&page=${page}`, token, {
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

/** How a record reaches an installation: the whole of it (`repos` null: the person's own account), or as a member. */
interface Link {
  readonly installationId: number;
  readonly baseId: string;
  /** A member's repos as their sign-in last saw them; empty once the sign-in ran out (`grant` null). */
  readonly repos: readonly Repo[] | null;
  readonly grant: string | null;
}

async function linksOf(db: Db, installationId: number): Promise<Link[]> {
  const { rows } = await db.query<{ baseId: string; repos: string | null; grant: string | null }>(
    `select "baseId", "repos", "grant" from "github_links" where "installationId" = $1`,
    [installationId],
  );
  return rows.map((row) => linkOf({ ...row, installationId }));
}

const linkOf = (row: {
  installationId: number | string;
  baseId: string;
  repos: string | null;
  grant: string | null;
}): Link => ({
  installationId: Number(row.installationId),
  baseId: row.baseId,
  repos: row.repos === null ? null : row.grant === null ? [] : (JSON.parse(row.repos) as Repo[]),
  grant: row.grant,
});

/** A GitHub sign-in kept for a member's link: its refresh token, or the token itself if the App's don't expire. */
type Grant = { readonly refresh: string } | { readonly access: string };

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function grantKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: new TextEncoder().encode("github-grant") },
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Sealed to its own link, so a grant copied onto another row doesn't open. */
const grantData = (installationId: number, baseId: string) =>
  new TextEncoder().encode(`github-grant:${installationId}:${baseId}`);

async function sealGrant(
  secret: string,
  installationId: number,
  baseId: string,
  grant: Grant,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: grantData(installationId, baseId) },
    await grantKey(secret),
    new TextEncoder().encode(JSON.stringify(grant)),
  );
  return `${b64(iv)}.${b64(new Uint8Array(sealed))}`;
}

async function openGrant(secret: string, link: Link): Promise<Grant | undefined> {
  const [iv, sealed] = (link.grant ?? "").split(".");
  if (!iv || !sealed) return undefined;
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv), additionalData: grantData(link.installationId, link.baseId) },
      await grantKey(secret),
      unb64(sealed),
    );
    return JSON.parse(new TextDecoder().decode(opened)) as Grant;
  } catch {
    // The auth secret changed: the person connects again.
    return undefined;
  }
}

/** GitHub's token endpoint, for an OAuth code or a refresh token. Undefined when GitHub refuses it. */
async function signIn(
  deps: Deps,
  params: Record<string, string>,
): Promise<{ readonly token: string; readonly grant: Grant } | undefined> {
  const response = await deps.fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "brainiac" },
    body: JSON.stringify({ client_id: deps.app.clientId, client_secret: deps.app.clientSecret, ...params }),
  });
  if (!response.ok) throw new Error(`GitHub ${response.status} on its token endpoint`);
  const body = (await response.json()) as { access_token?: string; refresh_token?: string };
  if (!body.access_token) return undefined;
  return {
    token: body.access_token,
    grant: body.refresh_token ? { refresh: body.refresh_token } : { access: body.access_token },
  };
}

/**
 * The repos of an installation that a person's own GitHub sign-in can see: GitHub's "repositories accessible to
 * the user access token". None if they can no longer reach the installation at all.
 */
async function memberRepos(deps: Deps, installationId: number, token: string): Promise<Repo[]> {
  try {
    return (await listRepos(deps, `/user/installations/${installationId}/repositories`, token, [])).repos;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GitHub 404 ")) return [];
    throw error;
  }
}

const same = (a: Repo, b: Repo) => JSON.stringify(a) === JSON.stringify(b);

/**
 * One member's link to an organization installation: renews their GitHub sign-in, reads what it can see there and
 * tells the record only the repos that changed. A sign-in GitHub refuses (revoked, or six months unused) ends the
 * reading until they connect again; a repo they lost access to stops updating, its project as it last was.
 */
async function sweepMember(deps: Deps, link: Link): Promise<number> {
  const grant = await openGrant(deps.secret, link);
  const renewed =
    grant &&
    ("refresh" in grant
      ? await signIn(deps, { grant_type: "refresh_token", refresh_token: grant.refresh })
      : { token: grant.access, grant });
  if (!renewed) {
    await deps.db.query(
      `update "github_links" set "grant" = null where "installationId" = $1 and "baseId" = $2`,
      [link.installationId, link.baseId],
    );
    return 0;
  }
  // The old refresh token is spent once GitHub answers: keep the new one before anything else can fail.
  if (renewed.grant !== grant)
    await deps.db.query(
      `update "github_links" set "grant" = $3 where "installationId" = $1 and "baseId" = $2`,
      [
        link.installationId,
        link.baseId,
        await sealGrant(deps.secret, link.installationId, link.baseId, renewed.grant),
      ],
    );
  const repos = await memberRepos(deps, link.installationId, renewed.token);
  const changed = repos.filter((repo) => !link.repos?.some((was) => same(was, repo)));
  if (changed.length > 0) await deps.record(link.baseId).githubRepos(changed);
  await deps.db.query(
    `update "github_links" set "repos" = $3, "checkedAt" = $4 where "installationId" = $1 and "baseId" = $2`,
    [link.installationId, link.baseId, JSON.stringify(repos), new Date(deps.now())],
  );
  return changed.length;
}

/**
 * Reads one installation's repos into every record linked to the whole of it. `only` is a record that just
 * linked: it reads the whole list, unconditionally, into that record alone, and leaves the others' ETags as they
 * were.
 */
async function sweepInstallation(deps: Deps, installationId: number, only?: string): Promise<number> {
  const bases =
    only === undefined
      ? (await linksOf(deps.db, installationId))
          .filter((link) => link.repos === null)
          .map((link) => link.baseId)
      : [only];
  if (bases.length === 0) return 0;
  const { rows } = await deps.db.query<{ etags: string }>(
    `select "etags" from "github_installations" where "id" = $1`,
    [installationId],
  );
  const stored: string[] = only === undefined ? JSON.parse(rows[0]?.etags ?? "[]") : [];
  const token = await installationToken(deps, installationId);
  const { repos, etags } = await listRepos(deps, "/installation/repositories", token, stored);
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
 * The daily sweep: every unsuspended installation linked whole, then every member's link to an organization one,
 * one at a time. One that fails or is rate limited is logged and tried again tomorrow; webhooks carry the changes
 * in between.
 */
// shortcut: one cron run walks every installation and member link in turn; fan it out over the jobs queue when
// their number nears the Worker's subrequest limit.
export async function sweep(deps: Deps): Promise<{ readonly swept: number; readonly failed: number }> {
  const { rows: whole } = await deps.db.query<{ id: string }>(
    `select distinct i."id" from "github_installations" i join "github_links" l on l."installationId" = i."id"
     where not i."suspended" and l."repos" is null order by i."id"`,
    [],
  );
  const { rows: members } = await deps.db.query<{
    installationId: string;
    baseId: string;
    repos: string;
    grant: string;
  }>(
    `select l."installationId", l."baseId", l."repos", l."grant" from "github_links" l
     join "github_installations" i on i."id" = l."installationId"
     where not i."suspended" and l."repos" is not null and l."grant" is not null order by l."installationId", l."baseId"`,
    [],
  );
  const units = [
    ...whole.map(({ id }) => ({ id, run: () => sweepInstallation(deps, Number(id)) })),
    ...members.map((row) => ({ id: row.installationId, run: () => sweepMember(deps, linkOf(row)) })),
  ];
  let swept = 0;
  let failed = 0;
  for (const { id, run } of units) {
    try {
      await run();
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
  const links = await linksOf(deps.db, installationId);
  if (links.length === 0) return new Response(null, { status: 204 });
  // A repo added to the installation: the list brings it with its stars and language, which the event leaves out.
  // A member's link reads it at the next sweep, once their own sign-in shows they can see it. A removed one keeps
  // its project as it last was.
  if (event === "installation_repositories" && payload.action === "added") {
    for (const link of links)
      if (link.repos === null) await sweepInstallation(deps, installationId, link.baseId);
  } else if (event === "repository" || event === "star") {
    const repo = repoOf(payload.repository);
    // A member's link hears only of repos their sign-in last saw.
    const bases = links
      .filter((link) => link.repos === null || link.repos.some((seen) => seen.id === repo?.id))
      .map((link) => link.baseId);
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
 * Whether the GitHub account behind an OAuth `code` can reach `installationId`, and whether the installation is on
 * that account itself or on an organization they belong to. Their sign-in comes back with it, for reading what
 * they can see on an organization's installation.
 */
async function reach(
  deps: Deps,
  code: string,
  installationId: number,
): Promise<
  | {
      readonly account: string;
      readonly organization: boolean;
      readonly token: string;
      readonly grant: Grant;
    }
  | undefined
> {
  const signedIn = await signIn(deps, { code });
  if (!signedIn) return undefined;
  const { token } = signedIn;
  const user = (await (await github(deps, "/user", token)).json()) as { id: number; login: string };
  for (let page = 1; ; page++) {
    const response = await github(deps, `/user/installations?per_page=${PAGE}&page=${page}`, token);
    const body = (await response.json()) as {
      total_count: number;
      installations: { id: number; account?: { id?: number; login?: string } }[];
    };
    const found = body.installations.find((installation) => installation.id === installationId);
    if (found) {
      const organization = found.account?.id !== user.id;
      return { ...signedIn, organization, account: (organization ? found.account?.login : user.login) ?? "" };
    }
    if (page * PAGE >= body.total_count) return undefined;
  }
}

/**
 * Where GitHub sends the person after they pick repos: `installation_id`, the `code` of their GitHub sign-in and
 * our `state`. The installation is linked to their record only if the state is theirs and their GitHub account can
 * reach it. On their own account it reads in whole; on an organization's, only the repos they can see there, and
 * their sign-in is kept, sealed, to check that again on every sweep. Connecting again renews it.
 */
export async function setup(
  url: URL,
  person: { readonly userId: string; readonly baseId: string },
  deps: Deps,
): Promise<Response> {
  const done = (outcome: string) =>
    Response.redirect(new URL(`/account?github=${outcome}`, url).toString(), 303);
  const installationId = Number(url.searchParams.get("installation_id"));
  const code = url.searchParams.get("code");
  // An organization owner still has to approve the install: GitHub sends no installation yet.
  if (url.searchParams.get("setup_action") === "request") return done("requested");
  if (!Number.isSafeInteger(installationId) || installationId <= 0 || !code) return done("failed");
  if (url.searchParams.get("state") !== (await installState(deps.secret, person.userId)))
    return done("failed");
  const reached = await reach(deps, code, installationId);
  if (!reached) return done("failed");
  await deps.db.query(
    `insert into "github_installations" ("id", "account") values ($1, $2)
     on conflict ("id") do update set "account" = excluded."account"`,
    [installationId, reached.account],
  );
  if (reached.organization) {
    let repos: Repo[] = [];
    try {
      repos = await memberRepos(deps, installationId, reached.token);
    } catch (error) {
      // Linked all the same: the daily sweep reads what they can see.
      console.error("github first read failed", installationId, error);
    }
    await deps.db.query(
      `insert into "github_links" ("installationId", "baseId", "repos", "grant", "checkedAt") values ($1, $2, $3, $4, $5)
       on conflict ("installationId", "baseId") do update
       set "repos" = excluded."repos", "grant" = excluded."grant", "checkedAt" = excluded."checkedAt"`,
      [
        installationId,
        person.baseId,
        JSON.stringify(repos),
        await sealGrant(deps.secret, installationId, person.baseId, reached.grant),
        new Date(deps.now()),
      ],
    );
    if (repos.length > 0) await deps.record(person.baseId).githubRepos(repos);
    return done("connected");
  }
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
  /** On an organization's installation: the repos read in, by name, and whether the person's sign-in ran out. */
  readonly member?: { readonly repos: readonly string[]; readonly lapsed: boolean };
}

export async function linked(db: Db, baseId: string): Promise<Linked[]> {
  const { rows } = await db.query<{
    id: string;
    account: string;
    checkedAt: Date | null;
    suspended: boolean;
    memberCheckedAt: Date | null;
    repos: string | null;
    grant: string | null;
  }>(
    `select i."id", i."account", i."checkedAt", i."suspended", l."checkedAt" as "memberCheckedAt", l."repos", l."grant"
     from "github_links" l join "github_installations" i on i."id" = l."installationId"
     where l."baseId" = $1 order by i."account"`,
    [baseId],
  );
  return rows.map(({ id, account, checkedAt, suspended, memberCheckedAt, repos, grant }) => {
    const link = linkOf({ installationId: id, baseId, repos, grant });
    return {
      id: link.installationId,
      account,
      suspended,
      checkedAt: link.repos === null ? checkedAt : memberCheckedAt,
      ...(link.repos && {
        member: { repos: link.repos.map((repo) => repo.name).toSorted(), lapsed: grant === null },
      }),
    };
  });
}

/** Stops an installation feeding this record. The App stays installed on GitHub until the person removes it there. */
export async function unlink(db: Db, baseId: string, installationId: number): Promise<void> {
  await db.query(`delete from "github_links" where "installationId" = $1 and "baseId" = $2`, [
    installationId,
    baseId,
  ]);
}
