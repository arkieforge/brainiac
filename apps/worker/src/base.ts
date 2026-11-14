import {
  changesSince,
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
  type ChunkInput,
  type Mutation,
  type MutationResult,
  type NoteRow,
  type Sql,
  type UndoResult,
} from "@brainiac/base";
import { decodeClientMessage, type ServerMessage } from "@brainiac/core";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env.ts";

const RETRY_MS = 60_000;

/**
 * Who a sync socket speaks for. The Worker's authenticated route sets it on the upgrade request; nothing
 * outside the Worker can reach a DO, so the header can't come from a client.
 * shortcut: no route forwards sockets yet; it lands with connection tokens (#13), which carry the base id.
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
  readonly actor: string;
  readonly runId?: string;
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

  mutate(mutation: Mutation, caller: Caller): MutationResult {
    const before = currentSeq(this.sql);
    const result = mutate(this.sql, mutation, { ...caller, now: Date.now() });
    this.changed(before);
    return result;
  }

  undoRun(runId: string, caller: Caller): UndoResult {
    const before = currentSeq(this.sql);
    const result = undoRun(this.sql, runId, { ...caller, now: Date.now() });
    this.changed(before);
    return result;
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
    const { replies, push } = serve(this.sql, message, { actor: socket.actor, now: Date.now() });
    for (const reply of replies) send(reply);
    if (push) this.push(push);
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
   * Dispatches due jobs and purges expired tombstones. A job is marked dispatched only after the queue has
   * it, so a crash at any point sends it again; a dispatched job nobody acknowledges is sent again after its
   * lease. Both sides drop stale results, so a duplicate delivery costs work, not correctness.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    purge(this.sql, now);
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
