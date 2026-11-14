import { DurableObject } from "cloudflare:workers";
import { Client } from "pg";

export interface Env {
  BASE: DurableObjectNamespace<Base>;
  BLOBS: R2Bucket;
  JOBS: Queue;
  /** Postgres (this stage's Neon branch) for accounts, billing and the base registry. */
  HYPERDRIVE: Hyperdrive;
}

/**
 * One instance per person's record. Holds the record in SQLite (notes, change feed, index)
 * and its live connections. The schema and sync protocol land through their own issues;
 * for now it only reports which schema version it is on.
 */
export class Base extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    ctx.storage.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('schemaVersion', '0')");
  }

  schemaVersion(): number {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schemaVersion'")
      .one();
    return Number(row.value);
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

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return Response.json({ ok: true });
    if (pathname === "/health/db") return checkDb(env, ctx);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
