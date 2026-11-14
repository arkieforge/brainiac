import { doSql, migrate, schemaVersion, type Sql } from "@brainiac/base";
import { DurableObject } from "cloudflare:workers";
import { Client, Pool } from "pg";

import { type AuthConfig, createAuth } from "./auth/config.ts";
import type { Mailer } from "./auth/email.ts";
import { accountPage, signInPage } from "./auth/pages.ts";
import { vouchedUntil } from "./auth/recovery.ts";

export interface Env {
  BASE: DurableObjectNamespace<Base>;
  BLOBS: R2Bucket;
  JOBS: Queue;
  /** Postgres (this stage's Neon branch) for accounts, billing and the base registry. */
  HYPERDRIVE: Hyperdrive;
  /** Signs sessions and encrypts the JWT keys; generated per stage by alchemy.run.ts. */
  BETTER_AUTH_SECRET: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Cloudflare Email Service, bound only once a sending address is set up (infra/README.md). */
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
}

/**
 * One instance per person's record. Holds the record in SQLite (notes, change feed, index; the schema is
 * `@brainiac/base`) and its live connections. The mutation path and sync protocol land through their own
 * issues.
 */
export class Base extends DurableObject<Env> {
  private readonly sql: Sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = doSql(ctx.storage);
    // Every wake: a record migrates the first time it is used after a deploy.
    migrate(this.sql);
  }

  schemaVersion(): number {
    return schemaVersion(this.sql);
  }
}

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

const oauthApp = (clientId: string | undefined, clientSecret: string | undefined) =>
  clientId && clientSecret ? { clientId, clientSecret } : undefined;

const authConfig = (request: Request, env: Env, database: AuthConfig["database"]): AuthConfig => ({
  database,
  baseURL: new URL(request.url).origin,
  secret: env.BETTER_AUTH_SECRET,
  sendEmail: mailer(env),
  turnstileSecret: env.TURNSTILE_SECRET_KEY,
  google: oauthApp(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
  github: oauthApp(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
});

/** Better Auth per request, over a pool Hyperdrive backs (it keeps the real connections warm). */
async function withAuth(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  use: (auth: ReturnType<typeof createAuth>) => Promise<Response>,
): Promise<Response> {
  // Up to 5, because Better Auth runs some queries beside an open transaction.
  const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 5 });
  try {
    return await use(createAuth(authConfig(request, env, pool)));
  } finally {
    ctx.waitUntil(pool.end());
  }
}

async function account(request: Request, auth: ReturnType<typeof createAuth>): Promise<Response> {
  // Straight from Neon: enrolling the sign-up passkey updates the session row, not the cached cookie.
  const session = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });
  if (!session) return Response.redirect(new URL("/sign-in", request.url).toString(), 303);
  const passkeys = await auth.api.listPasskeys({ headers: request.headers });
  return accountPage(session.user.email, passkeys, vouchedUntil(session.session, passkeys));
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return Response.json({ ok: true });
    if (pathname === "/health/db") return checkDb(env, ctx);
    if (pathname.startsWith("/api/auth/"))
      return withAuth(request, env, ctx, (auth) => auth.handler(request));
    if (pathname === "/account") return withAuth(request, env, ctx, (auth) => account(request, auth));
    if (pathname === "/sign-in") {
      const providers = [
        ...(env.GOOGLE_CLIENT_ID ? (["google"] as const) : []),
        ...(env.GITHUB_CLIENT_ID ? (["github"] as const) : []),
      ];
      return signInPage({ turnstileSiteKey: env.TURNSTILE_SITE_KEY, providers });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
