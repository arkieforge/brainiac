// A Worker for engines.test.ts: one Durable Object per conformance case, so each starts from an empty
// SQLite database, the same storage the Base DO uses in production.
import { doSql, type DurableObjectSql } from "../src/index.ts";
import { runCase, type Fixture } from "./cases.ts";

export class CaseRunner {
  readonly #storage: DurableObjectSql;

  constructor(state: { readonly storage: DurableObjectSql }) {
    this.#storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    // Sent by engines.test.ts, never by anyone else.
    const { name, fixtures } = (await request.json()) as { name: string; fixtures: Fixture[] };
    return Response.json(runCase(name, doSql(this.#storage), fixtures));
  }
}

export default {
  fetch: () => new Response("Not found", { status: 404 }),
};
