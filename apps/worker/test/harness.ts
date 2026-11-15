// The real Base DO and jobs consumer, loaded into workerd by base.test.ts. TestBase adds what a test needs to
// see and steer: reads, a crash, and running the dispatcher when the test says rather than when it fires.
import {
  dataKey,
  getNote,
  mutate,
  oauthConnection,
  recordApproval,
  search,
  unseal,
  type ChunkInput,
  type Connection,
  type Job,
  type NoteClass,
  type Principal,
} from "@brainiac/base";

import { Base } from "../src/base.ts";
import { cliLogin, cliLogout, openSync, type SignedIn } from "../src/devices.ts";
import type { Env } from "../src/env.ts";
import { consume } from "../src/jobs.ts";

export class TestBase extends Base {
  readonly #waiting: ((result: "installed" | "dropped") => void)[] = [];
  readonly #alarms: (() => void)[] = [];
  /** Sync messages left before the one this instance dies handling; 0 is none. */
  #dieAt = 0;

  /** Alarms the runtime fires do nothing, as if the process died before dispatching. */
  override async alarm(): Promise<void> {
    for (const resolve of this.#alarms.splice(0)) resolve();
  }

  /** Resolves when the runtime next fires this record's alarm. Call it before the write that should arm it. */
  nextAlarm(): Promise<void> {
    return new Promise((resolve) => this.#alarms.push(resolve));
  }

  /** The real alarm: dispatch due jobs, purge, re-arm. */
  dispatch(): Promise<void> {
    return super.alarm();
  }

  /** Ends this instance mid-flight; the next call gets a fresh one over the same storage. */
  crash(): void {
    this.ctx.abort("test crash");
  }

  /** The process dies handling the `n`th sync message from now: after its transaction, before its reply. */
  dieHandling(n: number): void {
    this.#dieAt = n;
  }

  override webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (this.#dieAt === 0 || --this.#dieAt > 0) return super.webSocketMessage(ws, data);
    const dying = new Proxy(ws, {
      get: (target, key) => {
        if (key === "send") return () => this.crash();
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return super.webSocketMessage(dying, data);
  }

  jobs(): Job[] {
    return this.sql.all<Job>("SELECT * FROM jobs ORDER BY id");
  }

  find(principal: Principal, text: string): string[] {
    return search(this.sql, principal, text).map((hit) => hit.noteId);
  }

  rev(noteId: string): number | null {
    return getNote(this.sql, noteId)?.rev ?? null;
  }

  /**
   * Loads notes as the person made them, ids in order. A verified one is approved as if the person signed: real
   * signatures are tested in approvals.test.ts.
   */
  seed(
    notes: readonly { readonly path: string; readonly raw: string; readonly class: NoteClass }[],
  ): string[] {
    const ctx = { actor: "human", now: Date.now() };
    return notes.map((note) => {
      const mutation = { op: "create", ...note } as const;
      let result = mutate(this.sql, mutation, ctx);
      if (result.status === "needsApproval") {
        const signed = { credentialId: "test-passkey", counter: 0, assertion: "{}" };
        const approved = recordApproval(this.sql, result.items, signed, ctx.now);
        if ("error" in approved) throw new Error(approved.error);
        result = mutate(this.sql, mutation, { ...ctx, approvalId: approved.approvalId });
      }
      if (result.status !== "applied") throw new Error(JSON.stringify(result));
      return result.noteId;
    });
  }

  /** An MCP client's connection, if it has one. */
  connectionFor(oauthClientId: string): Connection | null {
    return oauthConnection(this.sql, oauthClientId) ?? null;
  }

  /** Sets a connection's grants as if the person signed them (grants are tested in connections.test.ts). */
  setGrants(connectionId: string, grants: Pick<Connection, "level" | "sensitive" | "holdDays">): void {
    this.sql.all(
      "UPDATE connections SET level = ?, sensitive = ?, holdDays = ?, rev = rev + 1 WHERE id = ?",
      grants.level,
      grants.sensitive ? 1 : 0,
      grants.holdDays,
      connectionId,
    );
  }

  /** Gives the record a manifest, as onboarding does. */
  setManifest(yaml: string): void {
    this.sql.all("INSERT INTO schema (version, manifest) VALUES (1, ?)", yaml);
  }

  /** The record's data key, for a test to open what the vault sealed. */
  async key(): Promise<Uint8Array> {
    return dataKey(this.sql, await this.env.VAULT_KEY.get());
  }

  /** A secret's value. Nothing outside tests reads one back: the fill path (#37) will be the only way out. */
  async secretValue(name: string): Promise<string | null> {
    const [row] = this.sql.all<{ ciphertext: string }>("SELECT ciphertext FROM secrets WHERE name = ?", name);
    return row
      ? Buffer.from(
          unseal(await this.key(), Buffer.from(row.ciphertext, "base64"), `secret:${name}`),
        ).toString()
      : null;
  }

  actorOf(noteId: string): string | null {
    const [row] = this.sql.all<{ actor: string }>(
      "SELECT actor FROM revisions WHERE noteId = ? ORDER BY rev DESC LIMIT 1",
      noteId,
    );
    return row?.actor ?? null;
  }

  override installIndex(jobId: string, chunks: readonly ChunkInput[]): "installed" | "dropped" {
    const result = super.installIndex(jobId, chunks);
    for (const resolve of this.#waiting.splice(0)) resolve(result);
    return result;
  }

  /** Resolves when the queue consumer next hands a job's result back. Call it before dispatching. */
  nextInstall(): Promise<"installed" | "dropped"> {
    return new Promise((resolve) => this.#waiting.push(resolve));
  }
}

/**
 * Stands in for Better Auth and the registry, and only them: the cookie `user=<name>` is a session for the person
 * whose record is the one named `<name>`. The routes themselves are the real ones (devices.ts).
 */
const fakeSession =
  (request: Request, env: Env): SignedIn =>
  async () => {
    const user = /(?:^|; )user=([\w-]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
    // The fixture student (fictional).
    if (user === undefined) return undefined;
    return { email: "ada.okafor@example.edu", baseId: env.BASE.idFromName(user).toString() };
  };

export default {
  queue: consume,
  fetch: (request: Request, env: Env) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/sync") return openSync(request, env, fakeSession(request, env));
    if (pathname === "/cli/login") return cliLogin(request, env, fakeSession(request, env));
    if (pathname === "/cli/logout") return cliLogout(request, env);
    return new Response("Not found", { status: 404 });
  },
};
