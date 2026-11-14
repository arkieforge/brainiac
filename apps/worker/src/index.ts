import { DurableObject } from "cloudflare:workers";

export interface Env {
  BASE: DurableObjectNamespace<Base>;
  BLOBS: R2Bucket;
  JOBS: Queue;
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

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return Response.json({ ok: true });
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
