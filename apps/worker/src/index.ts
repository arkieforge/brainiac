import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { Client, Pool } from "pg";

import { type AuthConfig, createAuth } from "./auth/config.ts";
import type { Mailer } from "./auth/email.ts";
import { consent } from "./auth/consent.ts";
import { accountPage, landing, signInPage } from "./auth/pages.ts";
import { vouchedUntil, type ApprovingPasskey } from "./auth/recovery.ts";
import type { JobMessage } from "./base.ts";
import type { Env } from "./env.ts";
import { serveDev } from "./dev.ts";
import { cliLogin, cliLogout, openSync, type SignedIn } from "./devices.ts";
import { consume } from "./jobs.ts";
import { serveMcp, type Records } from "./mcp/handler.ts";
import { baseOf } from "./registry.ts";
import { routeSite, type Session } from "./site.ts";

export { Base } from "./base.ts";
export type { Env } from "./env.ts";

/** Runs one query against this stage's Neon branch through Hyperdrive; proves the whole path is wired. */
async function checkDb(env: Env, ctx: ExecutionContext): Promise<Response> {
  // Hyperdrive pools connections, so a client per request is the intended pattern.
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return Response.json({ ok: true });
  } catch (error) {
    console.error("db health check failed", error);
    return Response.json({ ok: false }, { status: 503 });
  } finally {
    ctx.waitUntil(client.end());
  }
}

const mailer =
  (env: Env): Mailer =>
  async ({ to, subject, text }) => {
    if (!env.EMAIL || !env.EMAIL_FROM) throw new Error("Email isn't set up for this stage (EMAIL_FROM)");
    await env.EMAIL.send({ from: { name: "Brainiac", email: env.EMAIL_FROM }, to, subject, text });
  };

/** The record a CLI token names, if that is an id this namespace made at all. */
const recordById = (env: Env, baseId: string) => {
  try {
    return env.BASE.get(env.BASE.idFromString(baseId));
  } catch {
    return undefined;
  }
};

/** A signed-in person's record, from the base registry; undefined once it was deleted. */
const recordOf = async (env: Env, pool: Pool, userId: string) => {
  const baseId = await baseOf(pool, userId, () => env.BASE.newUniqueId().toString());
  return baseId === undefined ? undefined : recordById(env, baseId);
};

/** The records /mcp reaches: a signed-in person's, or the one a CLI token names. */
const records = (env: Env, pool: Pool): Records => ({
  of: (userId) => recordOf(env, pool, userId),
  byId: (baseId) => recordById(env, baseId),
});

const oauthApp = (clientId: string | undefined, clientSecret: string | undefined) =>
  clientId && clientSecret ? { clientId, clientSecret } : undefined;

const authConfig = (request: Request, env: Env, pool: Pool): AuthConfig => ({
  database: pool,
  baseURL: new URL(request.url).origin,
  secret: env.BETTER_AUTH_SECRET,
  sendEmail: mailer(env),
  turnstileSecret: env.TURNSTILE_SECRET_KEY,
  google: oauthApp(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
  github: oauthApp(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
  onDisconnect: async (userId, clientId) => {
    await (await recordOf(env, pool, userId))?.disconnectApp(clientId);
  },
});

/**
 * Auth's config per request, over a pool Hyperdrive backs (it keeps the real connections warm). `keepOpen` hands
 * over work that may still use the pool after the response; the pool ends once it settles.
 */
async function withAuthConfig<T>(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  use: (config: AuthConfig, keepOpen: (work: Promise<unknown>) => void, pool: Pool) => Promise<T>,
): Promise<T> {
  // Up to 5, because Better Auth runs some queries beside an open transaction.
  const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 5 });
  const pending: Promise<unknown>[] = [];
  try {
    return await use(authConfig(request, env, pool), (work) => pending.push(work), pool);
  } finally {
    ctx.waitUntil(Promise.allSettled(pending).then(() => pool.end()));
  }
}

const withAuth = <T>(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  use: (auth: ReturnType<typeof createAuth>, pool: Pool) => Promise<T>,
) =>
  withAuthConfig(request, env, ctx, (config, keepOpen, pool) => {
    const auth = createAuth(config);
    // Better Auth starts its setup (seeding the /mcp resource) as soon as it's made; a quick answer, like /mcp's
    // 401, mustn't end the pool under it.
    // shortcut: the seed's read is one Neon round trip that every request reaching a Better Auth handler waits for
    // (Better Auth awaits plugin setup before any handler), because its "done" mark is per Better Auth instance and a Worker can't keep a pool
    // across requests; upgrade when Better Auth can skip the seed or remember it per isolate (#83).
    keepOpen(auth.$context);
    return use(auth, pool);
  });

/**
 * The signed-in person and their record, from the session and the registry. `fresh` reads the session from Neon
 * rather than the cookie's 5-minute cache, for minting a credential: a session ended elsewhere can't make one.
 */
const signedIn =
  (request: Request, env: Env, ctx: ExecutionContext, fresh = false): SignedIn =>
  () =>
    withAuth(request, env, ctx, async (auth, pool) => {
      const session = await auth.api.getSession({
        headers: request.headers,
        query: { disableCookieCache: fresh },
      });
      if (!session) return undefined;
      const baseId = await baseOf(pool, session.user.id, () => env.BASE.newUniqueId().toString());
      return baseId === undefined ? undefined : { email: session.user.email, baseId };
    });

/**
 * The signed-in person for the site's routes (site.ts). Proving a passkey reads the session fresh from Neon, as
 * minting any credential does, and lists the person's passkeys to see whether the session proved one lately.
 */
const siteSession =
  (request: Request, env: Env, ctx: ExecutionContext): Session =>
  ({ passkey = false } = {}) =>
    withAuth(request, env, ctx, async (auth, pool) => {
      const found = await auth.api.getSession({
        headers: request.headers,
        query: { disableCookieCache: passkey },
      });
      if (!found) return undefined;
      const baseId = await baseOf(pool, found.user.id, () => env.BASE.newUniqueId().toString());
      if (baseId === undefined) return undefined;
      const passkeys: ApprovingPasskey[] = passkey
        ? await auth.api.listPasskeys({ headers: request.headers })
        : [];
      return {
        userId: found.user.id,
        baseId,
        passkey: passkey && vouchedUntil(found.session, passkeys) >= Date.now(),
      };
    });

async function account(request: Request, auth: ReturnType<typeof createAuth>): Promise<Response> {
  // Straight from Neon: enrolling the sign-up passkey updates the session row, not the cached cookie.
  const session = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });
  if (!session) return Response.redirect(new URL("/sign-in", request.url).toString(), 303);
  const [passkeys, apps] = await Promise.all([
    auth.api.listPasskeys({ headers: request.headers }),
    auth.api.listConnectedApps({ headers: request.headers }),
  ]);
  return accountPage(session.user.email, passkeys, vouchedUntil(session.session, passkeys), apps);
}

// OAuth discovery, at the root where MCP clients look for it. The issuer is `<origin>/api/auth`, so a client may
// ask under either RFC 8414's path insertion or OIDC's path appending.
const AUTH_SERVER_METADATA = new Set([
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/api/auth",
]);
const OPENID_METADATA = new Set([
  "/.well-known/openid-configuration",
  "/.well-known/openid-configuration/api/auth",
  "/api/auth/.well-known/openid-configuration",
]);

// Local dev (`vp run dev`) is the only place Brainiac is served over plain HTTP. Browsers resolve every
// `*.localhost` name to loopback, which is how dev gets its own usercontent origin.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const isLoopback = (hostname: string) => LOOPBACK.has(hostname) || hostname.endsWith(".localhost");

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    // Auth's base URL is the request's origin, and over http the MCP plugin refuses it, so every /api/auth
    // request would 500. Passkeys and Secure cookies need HTTPS anyway.
    if (url.protocol === "http:" && !isLoopback(url.hostname)) {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 308);
    }
    // First, so the usercontent origin answers nothing but its files.
    const site = routeSite(request, env, siteSession(request, env, ctx));
    if (site) return site;
    const { pathname } = url;
    if (pathname === "/health") return Response.json({ ok: true });
    if (pathname === "/health/db") return checkDb(env, ctx);
    if (pathname.startsWith("/dev/")) {
      // Dev sign-in (dev.ts) exists only where the token is bound, and never on prod even if it were.
      const token = env.DEV_SIGN_IN_TOKEN;
      if (!token || env.STAGE === "prod") return new Response("Not found", { status: 404 });
      return withAuthConfig(request, env, ctx, (config) => serveDev(request, config, token));
    }
    if (AUTH_SERVER_METADATA.has(pathname))
      return withAuth(request, env, ctx, (auth) => oauthProviderAuthServerMetadata(auth)(request));
    if (OPENID_METADATA.has(pathname))
      return withAuth(request, env, ctx, (auth) => oauthProviderOpenIdConfigMetadata(auth)(request));
    // The protected-resource metadata (RFC 9728) for /mcp, which the mcp() plugin serves.
    if (pathname.startsWith("/api/auth/") || pathname.startsWith("/.well-known/oauth-protected-resource"))
      return withAuth(request, env, ctx, (auth) => auth.handler(request));
    if (pathname === "/mcp")
      return withAuth(request, env, ctx, (auth, pool) =>
        serveMcp(auth, request, records(env, pool), {
          devTokens: Boolean(env.DEV_SIGN_IN_TOKEN) && env.STAGE !== "prod",
        }),
      );
    if (pathname === "/consent") return withAuth(request, env, ctx, (auth) => consent(request, auth));
    if (pathname === "/account") return withAuth(request, env, ctx, (auth) => account(request, auth));
    if (pathname === "/sync") return openSync(request, env, signedIn(request, env, ctx));
    if (pathname === "/cli/login") return cliLogin(request, env, signedIn(request, env, ctx, true));
    if (pathname === "/cli/logout") return cliLogout(request, env);
    if (pathname === "/sign-in") {
      const providers = [
        ...(env.GOOGLE_CLIENT_ID ? (["google"] as const) : []),
        ...(env.GITHUB_CLIENT_ID ? (["github"] as const) : []),
      ];
      return signInPage({
        next: landing(url.searchParams.get("next"), url.origin),
        turnstileSiteKey: env.TURNSTILE_SITE_KEY,
        providers,
        emailCodes: Boolean(env.EMAIL && env.EMAIL_FROM),
      });
    }
    // Every other page belongs to the web app: its shell, whose router reads the path. Only pages, so a missing
    // script or image is a 404 and not HTML.
    if (request.method === "GET" && request.headers.get("accept")?.includes("text/html"))
      return env.ASSETS.fetch(new Request(new URL("/", url), request));
    return new Response("Not found", { status: 404 });
  },
  queue: consume,
} satisfies ExportedHandler<Env, JobMessage>;
