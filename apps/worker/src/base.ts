import {
  authenticate,
  canSee,
  changesSince,
  connect,
  decide,
  disconnect,
  getConnection,
  grant,
  grantHash,
  listNotes,
  mintToken,
  releaseDue,
  restrict,
  search,
  withdraw,
  lastCounter,
  openReview,
  planHash,
  recordApproval,
  startReview,
  currentSeq,
  doSql,
  dueJobs,
  finishJob,
  jobInput,
  markDispatched,
  migrate,
  mutate,
  nextWake,
  purge,
  putChunks,
  schemaVersion,
  serve,
  undoRun,
  type Approved,
  type ChunkInput,
  type Connection,
  type Context,
  type Decided,
  type Forbidden,
  type GrantPlan,
  type Granted,
  type Mutation,
  type MutationResult,
  type NoteRow,
  type Opened,
  type Sql,
} from "@brainiac/base";
import { decodeClientMessage, type PlanItem, type ServerMessage } from "@brainiac/core";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { DurableObject } from "cloudflare:workers";

import { checkSignature, type Approver } from "./approvals.ts";
import type { Env } from "./env.ts";

const RETRY_MS = 60_000;

/**
 * Who a sync socket speaks for. The Worker's authenticated route sets it on the upgrade request; nothing
 * outside the Worker can reach a DO, so the header can't come from a client.
 * shortcut: no route forwards sockets yet; /sync lands with #87, routing a CLI token by the base id inside it.
 */
export const ACTOR_HEADER = "x-brainiac-actor";

/** What a socket remembers across hibernation. */
interface Socket {
  readonly actor: string;
  /** Set by the socket's hello; a mutate under another id is refused. */
  readonly clientId: string | null;
}

/** What the outbox puts on the jobs queue: the record (this DO's own id, never from a request) and the job. */
export interface JobMessage {
  readonly base: string;
  readonly jobId: string;
}

/** Who asks for a change. Set by the transport from the session or token, never from the request body. */
export interface Caller {
  /** For the person on the site; a connection's actor is always `connection:<id>`. */
  readonly actor: string;
  /**
   * The connection a tool call comes through (a CLI token's, or an MCP client's consent): its level, sensitive
   * scope and hold window apply. Absent only on the site's session route, which speaks for the person.
   */
  readonly connectionId?: string;
  readonly runId?: string;
  /** An approval the person gave for this exact change (from `approve`); used up when the change lands. */
  readonly approvalId?: string;
  /** A review session the person opened (`openReview`) over the notes this change touches. */
  readonly review?: string;
}

/**
 * One instance per person's record: the authority for its notes, its change feed and its job dispatcher.
 * Every change goes through `mutate`, `undoRun` or a sync client's `mutate` message (`@brainiac/base`), one
 * SQL transaction each with no I/O; each one is pushed to every sync socket, and follow-up work leaves
 * through the jobs outbox, dispatched by the alarm.
 */
export class Base extends DurableObject<Env> {
  protected readonly sql: Sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = doSql(ctx.storage);
    // Every wake: a record migrates the first time it is used after a deploy.
    migrate(this.sql);
  }

  schemaVersion(): number {
    return schemaVersion(this.sql);
  }

  /** The caller as the record knows it: a connection's grants come from its own table, never the caller. */
  private context(caller: Caller): Context | Forbidden {
    const { connectionId, ...rest } = caller;
    const now = Date.now();
    if (connectionId === undefined) return { ...rest, now };
    const connection = getConnection(this.sql, connectionId);
    if (!connection) return { status: "forbidden", reason: "This connection was disconnected." };
    return { ...rest, actor: `connection:${connection.id}`, connection, now };
  }

  mutate(mutation: Mutation, caller: Caller): MutationResult {
    const ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    const before = currentSeq(this.sql);
    const result = mutate(this.sql, mutation, ctx);
    this.changed(before);
    return result;
  }

  undoRun(runId: string, caller: Caller): ReturnType<typeof undoRun> {
    const ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    const before = currentSeq(this.sql);
    const result = undoRun(this.sql, runId, ctx);
    this.changed(before);
    return result;
  }

  /** Live notes the caller may see: a connection sees sensitive ones only with the scope granted. */
  notes(caller: Caller): NoteRow[] | Forbidden {
    const ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    return listNotes(this.sql).filter((note) => canSee(ctx.connection, note));
  }

  /** Keyword search over the families the caller may see. */
  search(text: string, caller: Caller): string[] | Forbidden {
    const ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    const families = canSee(ctx.connection, { class: "sensitive" })
      ? (["normal", "sensitive"] as const)
      : (["normal"] as const);
    return families.flatMap((family) => search(this.sql, family, text).map((hit) => hit.noteId));
  }

  // Proposals. A connection may withdraw its own; only the site's session route may decide one.

  withdraw(proposalId: string, caller: Caller): Decided {
    const ctx = this.context(caller);
    return "status" in ctx ? ctx : withdraw(this.sql, proposalId, ctx);
  }

  decide(proposalId: string, decision: "accept" | "reject", caller: Caller): Decided {
    const ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    const before = currentSeq(this.sql);
    const result = decide(this.sql, proposalId, decision, ctx);
    this.changed(before);
    return result;
  }

  // Connections. Only the site's session route may call these, for the record's owner; the Worker routes a CLI
  // token to its record by the id inside it (`tokenBase`), and `authenticate` decides whether it is good.
  // shortcut: no route calls them yet; /sync and /mcp resolve their connections with #17.

  /** A new connection at the floor (propose, no sensitive notes, a 3-day hold), or an MCP client's existing one. */
  // Not `connect`: a Durable Object's `connect` is its TCP socket handler.
  addConnection(input: Parameters<typeof connect>[1]): Connection {
    return connect(this.sql, input, Date.now());
  }

  /** A new token for a CLI connection, naming this record. Shown once. */
  mintToken(connectionId: string): string {
    return mintToken(this.sql, this.ctx.id.toString(), connectionId, Date.now());
  }

  authenticate(token: string): Connection | null {
    return authenticate(this.sql, token, Date.now()) ?? null;
  }

  /** Loosens a connection with the person's passkey over `grantHash(plan)` (contract §4). */
  async grant(plan: GrantPlan, response: AuthenticationResponseJSON, approver: Approver): Promise<Granted> {
    const signed = await this.check(response, grantHash(plan), approver);
    // The check awaited: a change to the connection meanwhile moved its rev, which the plan names.
    return "error" in signed ? signed : grant(this.sql, plan, signed);
  }

  /** Tightens a connection; no passkey needed. */
  restrict(connectionId: string, change: Parameters<typeof restrict>[2]): Granted {
    return restrict(this.sql, connectionId, change);
  }

  disconnect(connectionId: string): void {
    disconnect(this.sql, connectionId);
  }

  // Approvals. Only the site's session route may call these, with the record owner's passkey loaded from Neon
  // (`Approver`); no agent, token or MCP tool reaches them, so none can approve.
  // shortcut: no route calls them yet; the site's approval page lands with the editor (#16).

  /**
   * Checks a passkey signature over `planHash(items)` and records it, for the change with that exact effect to
   * cite once as `approvalId`. The items are the ones a `needsApproval` result returned.
   */
  async approve(
    items: readonly PlanItem[],
    response: AuthenticationResponseJSON,
    approver: Approver,
  ): Promise<Approved> {
    const signed = await this.check(response, planHash(items), approver);
    // The check awaited: anything may have landed meanwhile, which the change's own plan hash catches.
    return "error" in signed ? signed : recordApproval(this.sql, items, signed, Date.now());
  }

  /** A nonce for the person to sign, opening a review session over the notes shown, for them alone. */
  startReview(noteIds: readonly string[], caller: Caller): string {
    return startReview(this.sql, noteIds, caller.actor, Date.now());
  }

  /** Opens a review session once its nonce is signed: 10 minutes of verify, fix and undo on its notes. */
  async openReview(
    nonce: string,
    response: AuthenticationResponseJSON,
    approver: Approver,
    caller: Caller,
  ): Promise<Opened> {
    const signed = await this.check(response, nonce, approver);
    return "error" in signed ? signed : openReview(this.sql, nonce, caller.actor, signed, Date.now());
  }

  private check(response: AuthenticationResponseJSON, challenge: string, approver: Approver) {
    return checkSignature(
      response,
      challenge,
      approver,
      lastCounter(this.sql, approver.credentialId),
      Date.now(),
    );
  }

  /** Accepts a sync socket (hibernatable, so idle connections cost nothing). */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket")
      return new Response("Expected a WebSocket", { status: 426 });
    const actor = request.headers.get(ACTOR_HEADER);
    if (!actor) return new Response("Unauthorized", { status: 401 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ actor, clientId: null } satisfies Socket);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const send = (message: ServerMessage) => ws.send(JSON.stringify(message));
    const message = decodeClientMessage(typeof data === "string" ? data : new TextDecoder().decode(data));
    if ("error" in message) return send({ type: "error", message: message.error });
    const socket: Socket = ws.deserializeAttachment();
    if (message.type === "hello")
      ws.serializeAttachment({ ...socket, clientId: message.clientId } satisfies Socket);
    else if (message.clientId !== socket.clientId)
      return send({ type: "error", message: "Say hello first." });
    let served;
    try {
      served = serve(this.sql, message, { actor: socket.actor, now: Date.now() });
    } catch (error) {
      // A bug, not a refusal (refusals come back as results): the transaction rolled back and the change
      // keeps its number, so the client resends it once the bug is fixed. Say so rather than going quiet.
      console.error("sync message failed", error);
      return send({ type: "error", message: "The record could not apply that message." });
    }
    for (const reply of served.replies) send(reply);
    if (served.push) this.push(served.push);
    this.wake();
  }

  /** After a change from anywhere: re-arm the alarm and push what changed to every sync socket. */
  private changed(before: number): void {
    this.wake();
    if (currentSeq(this.sql) > before) this.push(changesSince(this.sql, before));
  }

  private push(message: ServerMessage): void {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      const socket: Socket | null = ws.deserializeAttachment();
      if (socket?.clientId) ws.send(text);
    }
  }

  /**
   * The note a job works on, or `null` when the job is done or stale (its note has moved on). For the jobs
   * consumer only: it returns sensitive text with no connection check, so no transport may expose it.
   */
  jobInput(jobId: string): NoteRow | null {
    return jobInput(this.sql, jobId)?.note ?? null;
  }

  /** Installs an index job's chunks, only while the note is still at the job's revision. */
  installIndex(jobId: string, chunks: readonly ChunkInput[]): "installed" | "dropped" {
    return finishJob(this.sql, jobId, (job) => putChunks(this.sql, job.noteId, job.rev, chunks));
  }

  /**
   * Dispatches due jobs, purges expired tombstones and applies held changes whose hold ran out. A job is marked dispatched only after the queue has
   * it, so a crash at any point sends it again; a dispatched job nobody acknowledges is sent again after its
   * lease. Both sides drop stale results, so a duplicate delivery costs work, not correctness.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    purge(this.sql, now);
    const seq = currentSeq(this.sql);
    releaseDue(this.sql, now);
    if (currentSeq(this.sql) > seq) this.push(changesSince(this.sql, seq));
    const due = dueJobs(this.sql, now);
    if (due.length > 0) {
      try {
        await this.env.JOBS.sendBatch(
          due.map((job) => ({ body: { base: this.ctx.id.toString(), jobId: job.id } })),
        );
      } catch (error) {
        // The queue is down: the jobs stay due. Try again in a minute rather than spinning, and rather than
        // throwing, since the runtime stops retrying a failing alarm after a few attempts.
        console.error("job dispatch failed", error);
        void this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
        return;
      }
      markDispatched(
        this.sql,
        due.map((job) => job.id),
        now,
      );
    }
    this.wake();
  }

  /**
   * Points the alarm at the next background work, or clears it. No await separates it from the write it
   * follows, so the runtime commits both together.
   */
  private wake(): void {
    const at = nextWake(this.sql, Date.now());
    void (at === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(at));
  }
}
