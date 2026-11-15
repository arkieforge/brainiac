import {
  activity,
  authenticate,
  callTool,
  canSee,
  changesSince,
  classifyFile,
  dataKey,
  getFile,
  installFile,
  kindHash,
  listFiles,
  manifestOf,
  mintFileToken,
  mayClear,
  readText,
  recordUpload,
  refuseUpload,
  sealFile,
  takeFileToken,
  unseal,
  viewFile,
  type Classified,
  type FileToken,
  type Extracted,
  type FileView,
  type Uploaded,
  connect,
  connectionOf,
  decide,
  disconnect,
  getConnection,
  grant,
  grantHash,
  listNotes,
  mintToken,
  oauthConnection,
  PERSON,
  principalOf,
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
  reindex,
  schemaVersion,
  serve,
  undoRun,
  type Answer,
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
  type Principal,
  type Sql,
} from "@brainiac/base";
import { decodeClientMessage, type Manifest, type PlanItem, type ServerMessage } from "@brainiac/core";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { DurableObject } from "cloudflare:workers";

import { checkSignature, type Approver } from "./approvals.ts";
import type { Env } from "./env.ts";

const RETRY_MS = 60_000;

/**
 * Who a sync socket speaks for: the person, or `connection:<id>`. The Worker's `/sync` route (devices.ts) sets it
 * on the upgrade request from the session or a CLI token, after dropping any the client sent; nothing outside the
 * Worker can reach a DO. What the socket may read, and whether it may write, comes from the connection's own row,
 * read again for every message and push, so narrowing a connection reaches its open sockets at once.
 */
export const ACTOR_HEADER = "x-brainiac-actor";

/** What a socket remembers across hibernation. */
interface Socket {
  readonly actor: string;
  /** Set by the socket's hello; a mutate under another id is refused. */
  readonly clientId: string | null;
}

/** What a job works on, for the jobs consumer: a note to index, or a file to extract (and index once cleared). */
export type JobWork =
  | { readonly kind: "index"; readonly note: NoteRow }
  | {
      readonly kind: "file";
      readonly sha256: string;
      readonly mime: string;
      readonly fileKind: string | null;
      readonly bytes: Uint8Array;
      /** Whether to embed its pages: it is cleared if the checks come out clean. */
      readonly embed: boolean;
    };

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
  /** The record's data key, unwrapped once per instance; reading the vault key is the only I/O it costs. */
  #dataKey: Promise<Uint8Array> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = doSql(ctx.storage);
    // Every wake: a record migrates the first time it is used after a deploy, and re-indexes in the background
    // when chunking or the embedding model changed.
    migrate(this.sql);
    if (reindex(this.sql)) this.wake();
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

  /**
   * One MCP tool call, as the connection it comes through: an MCP client's, found by its OAuth client id (and
   * connected at the floor on its first call), or the CLI connection whose token the Worker checked here. Which
   * record answers is the Worker's choice from the token; nothing in the call names one.
   */
  tool(
    via: { readonly oauthClientId: string } | { readonly connectionId: string },
    name: string,
    args: unknown,
  ): Answer {
    const now = Date.now();
    const connection =
      "oauthClientId" in via
        ? connect(this.sql, { kind: "oauth", oauthClientId: via.oauthClientId }, now)
        : getConnection(this.sql, via.connectionId);
    if (!connection) return { ok: false, error: "This connection was disconnected." };
    const before = currentSeq(this.sql);
    const answer = callTool(this.sql, name, args, { actor: `connection:${connection.id}`, connection, now });
    this.changed(before);
    return answer;
  }

  /** Ends an MCP client's connection when the person disconnects the app, so it can't come back with its grants. */
  disconnectApp(oauthClientId: string): void {
    const connection = oauthConnection(this.sql, oauthClientId);
    if (connection) this.disconnect(connection.id);
  }

  /** The record's manifest (its types and their fields), for the site's forms; null until it has one. */
  manifest(): Manifest | null {
    return manifestOf(this.sql) ?? null;
  }

  /** Keyword search over the families the caller may see: note ids, and `<sha256>#p<page>` for a file's page. */
  search(text: string, caller: Caller): string[] | Forbidden {
    const ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    return search(this.sql, principalOf(ctx.connection), text).map((hit) =>
      "noteId" in hit ? hit.noteId : `${hit.fileSha}#p${hit.page}`,
    );
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

  // Connections. Only the site's session routes may call these, for the record's owner; the Worker routes a CLI
  // token to its record by the id inside it (`tokenBase`), and `authenticate` decides whether it is good.

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

  /** `brainiac login`: a new CLI connection at the floor and its token, for the person's session route. Shown once. */
  login(): string {
    return this.mintToken(this.addConnection({ kind: "cli" }).id);
  }

  /** `brainiac logout`: ends the connection a CLI token belongs to, closing its sockets. False if the token is no good here. */
  logout(token: string): boolean {
    const connection = authenticate(this.sql, token, Date.now());
    if (connection) this.disconnect(connection.id);
    return connection !== undefined;
  }

  /** Loosens a connection with the person's passkey over `grantHash(plan)` (contract §4). */
  async grant(plan: GrantPlan, response: AuthenticationResponseJSON, approver: Approver): Promise<Granted> {
    const signed = await this.check(response, grantHash(plan), approver);
    // The check awaited: a change to the connection meanwhile moved its rev, which the plan names.
    if ("error" in signed) return signed;
    const result = grant(this.sql, plan, signed);
    // A grant can move or clear waiting releases: the alarm follows them.
    this.wake();
    if ("connection" in result) this.resync(plan.connectionId);
    return result;
  }

  /** Tightens a connection; no passkey needed. */
  restrict(connectionId: string, change: Parameters<typeof restrict>[2]): Granted {
    const result = restrict(this.sql, connectionId, change);
    this.wake();
    if ("connection" in result) this.resync(connectionId);
    return result;
  }

  /** Each connection and its most recent tool calls (the audit log), for the person's account page. */
  activity(): ReturnType<typeof activity> {
    return activity(this.sql);
  }

  disconnect(connectionId: string): void {
    disconnect(this.sql, connectionId);
    this.resync(connectionId, 4001, "This connection was disconnected.");
  }

  /**
   * Closes a connection's open sockets after its grants change. A push re-reads only notes that changed, so a
   * narrowed one would keep notes it may no longer hold; its client says hello again and, its principal having
   * changed, gets a snapshot that names them as withheld.
   */
  private resync(connectionId: string, code = 4002, reason = "This connection's access changed."): void {
    for (const ws of this.ctx.getWebSockets()) {
      const socket: Socket | null = ws.deserializeAttachment();
      if (socket?.actor === `connection:${connectionId}`) ws.close(code, reason);
    }
  }

  // Approvals. Only the site's session route may call these, with the record owner's passkey loaded from Neon
  // (`Approver`); no agent, token or MCP tool reaches them, so none can approve.
  // Review mode's routes (site.ts) call startReview and openReview.
  // shortcut: no route calls approve yet; the site's approval page arrives with #99.

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

  // The vault (contract §5). Every upload is sealed with the record's data key before it reaches R2 and starts
  // unclassified; only the person confirms what a file is. The site's file routes (files.ts) call these.

  /**
   * Seals a file into R2, then records it and runs the checks over its text, in one transaction after the only
   * awaits. `kind` from the person is their confirmation; from a connection, a suggestion.
   */
  async upload(
    bytes: Uint8Array,
    input: { readonly mime: string; readonly kind?: string },
    caller: Caller,
  ): Promise<Uploaded> {
    const allowed = this.context(caller);
    if ("status" in allowed) return allowed;
    // Refused before anything reaches R2, so a refused upload leaves no blob behind.
    const refused = refuseUpload(allowed, input.kind);
    if (refused) return refused;
    const key = await this.dataKey();
    const { sha256, sealed } = sealFile(key, bytes);
    const r2Key = `blobs/${this.ctx.id.toString()}/${sha256}`;
    if (!getFile(this.sql, sha256)) await this.env.BLOBS.put(r2Key, sealed);
    // The puts awaited: the connection may have changed meanwhile, so it is loaded again.
    const ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    const before = currentSeq(this.sql);
    const text = readText(bytes, input.mime);
    const upload = { sha256, r2Key, mime: input.mime, bytes: bytes.byteLength, text };
    const result = recordUpload(
      this.sql,
      key,
      input.kind === undefined ? upload : { ...upload, kind: input.kind },
      ctx,
    );
    this.changed(before);
    return result;
  }

  /** What the caller may know about a file: a connection gets only a summary of one that isn't cleared. */
  file(sha256: string, caller: Caller): FileView | undefined | Forbidden {
    const ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    const file = getFile(this.sql, sha256);
    return file && viewFile(ctx.connection, file);
  }

  /**
   * The person says what a file is. Only the site's session route may call this. Loosening a kind they confirmed
   * before needs their passkey over the `challenge` a first call returns.
   */
  async classifyFile(
    sha256: string,
    kind: string,
    caller: Caller,
    signed?: { readonly response: AuthenticationResponseJSON; readonly approver: Approver },
  ): Promise<Classified> {
    let ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    if (!signed) {
      const result = classifyFile(this.sql, sha256, kind, ctx);
      // A confirmation can enqueue a file job: the alarm dispatches it.
      this.wake();
      return result;
    }
    const file = getFile(this.sql, sha256);
    if (!file) return { error: "No such file." };
    const challenge = kindHash(file, kind);
    const signature = await this.check(signed.response, challenge, signed.approver);
    if ("error" in signature) return signature;
    // The check awaited: a confirmation meanwhile bumped the file's rev, which the challenge names.
    ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    const result = classifyFile(this.sql, sha256, kind, ctx, { challenge, signature });
    this.wake();
    return result;
  }

  /** Every file, as the caller may know it. */
  files(caller: Caller): FileView[] | Forbidden {
    const ctx = this.context(caller);
    return "status" in ctx ? ctx : listFiles(this.sql, ctx.connection);
  }

  /**
   * A single-use token that opens a file's original from the usercontent origin, for the person only. The Worker
   * says whether their session proved a passkey lately (`passkey`), which an unclassified or vault file needs.
   */
  fileToken(
    sha256: string,
    caller: Caller,
    opts: { readonly origin: string; readonly passkey: boolean },
  ): FileToken {
    const ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    return mintFileToken(this.sql, this.ctx.id.toString(), sha256, ctx, opts);
  }

  /**
   * The original a file token opens, once: the token is used up before the read, so a second request gets
   * nothing even while the first is still loading. Null for a token that is unknown, used or expired.
   */
  async openFile(
    token: string,
  ): Promise<{ readonly bytes: Uint8Array; readonly mime: string; readonly origin: string } | null> {
    const taken = takeFileToken(this.sql, token, Date.now());
    if (!taken) return null;
    const { file, origin } = taken;
    const [key, object] = await Promise.all([this.dataKey(), this.env.BLOBS.get(file.r2Key)]);
    if (!object) throw new Error(`The record's file ${file.sha256} is missing from R2.`);
    const bytes = unseal(key, new Uint8Array(await object.arrayBuffer()), `file:${file.sha256}`);
    return { bytes, mime: file.mime, origin };
  }

  private dataKey(): Promise<Uint8Array> {
    if (!this.#dataKey) {
      const loading = this.env.VAULT_KEY.get().then((vaultKey) => dataKey(this.sql, vaultKey));
      // A failed read of the vault key is tried again by the next call, not remembered.
      loading.catch(() => (this.#dataKey = undefined));
      this.#dataKey = loading;
    }
    return this.#dataKey;
  }

  /** Accepts a sync socket (hibernatable, so idle connections cost nothing). */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket")
      return new Response("Expected a WebSocket", { status: 426 });
    const actor = request.headers.get(ACTOR_HEADER);
    if (!actor || !this.sender(actor)) return new Response("Unauthorized", { status: 401 });
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
    const sender = this.sender(socket.actor);
    if (!sender) return ws.close(4001, "This connection was disconnected.");
    if (message.type === "hello")
      ws.serializeAttachment({ ...socket, clientId: message.clientId } satisfies Socket);
    else if (message.clientId !== socket.clientId)
      return send({ type: "error", message: "Say hello first." });
    let served;
    try {
      const ctx = { actor: socket.actor, now: Date.now(), readOnly: sender.readOnly };
      served = serve(this.sql, message, ctx, sender.reader);
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

  /**
   * What a socket's actor may do now: the person reads and writes everything; a connection reads what its grants
   * allow and, above read level, syncs file edits as unattributed ones (contract §3). `undefined` once it is gone.
   */
  private sender(actor: string): { readonly reader: Principal; readonly readOnly: boolean } | undefined {
    if (!actor.startsWith("connection:")) return { reader: PERSON, readOnly: false };
    const connection = connectionOf(this.sql, actor);
    return connection && { reader: principalOf(connection), readOnly: connection.level === "read" };
  }

  /** After a change from anywhere: re-arm the alarm and push what changed to every sync socket. */
  private changed(before: number): void {
    this.wake();
    if (currentSeq(this.sql) > before) this.push((reader) => changesSince(this.sql, before, reader));
  }

  /** Sends each socket that said hello what changed, as its principal may see it now. */
  private push(feed: (reader: Principal) => ServerMessage): void {
    // Most sockets of a record read as the person, so each distinct principal's message is built once.
    const built = new Map<string, string>();
    for (const ws of this.ctx.getWebSockets()) {
      const socket: Socket | null = ws.deserializeAttachment();
      if (!socket?.clientId) continue;
      const reader = this.sender(socket.actor)?.reader;
      if (!reader) {
        ws.close(4001, "This connection was disconnected.");
        continue;
      }
      const key = JSON.stringify(reader);
      let text = built.get(key);
      if (text === undefined) built.set(key, (text = JSON.stringify(feed(reader))));
      ws.send(text);
    }
  }

  /**
   * What a job works on, or `null` when the job is done or stale (its note or file has moved on): a note, or a
   * file's opened bytes. For the jobs consumer only: it returns sensitive text and unclassified files with no
   * connection check, so no transport may expose it.
   */
  async jobInput(jobId: string): Promise<JobWork | null> {
    const input = jobInput(this.sql, jobId);
    if (!input) {
      // A stale job was dropped, which makes room on the queue like an install does.
      this.wake();
      return null;
    }
    if ("note" in input) return { kind: "index", note: input.note };
    const { file } = input;
    const object = await this.env.BLOBS.get(file.r2Key);
    // Gone from R2 is a bug, not a state: fail the job loudly rather than mark the file read.
    if (!object) throw new Error(`file ${file.sha256} is missing from R2`);
    const sealed = new Uint8Array(await object.arrayBuffer());
    return {
      kind: "file",
      sha256: file.sha256,
      mime: file.mime,
      fileKind: file.kind,
      bytes: unseal(await this.dataKey(), sealed, `file:${file.sha256}`),
      embed: mayClear(file),
    };
  }

  /** Installs an index job's chunks, only while the note is still at the job's revision. */
  installIndex(jobId: string, chunks: readonly ChunkInput[]): "installed" | "dropped" {
    const result = finishJob(this.sql, jobId, (job) => putChunks(this.sql, job.noteId, job.rev, chunks));
    // The job made room on the queue for the next one.
    this.wake();
    return result;
  }

  /**
   * Installs a file job's extraction while the file is still at the job's revision: the checks run over it, a
   * passport's MRZ is written, and a cleared file's pages are indexed with `vectors` (vault.ts `installFile`).
   */
  async installFile(
    jobId: string,
    extracted: Extracted,
    vectors: readonly Uint8Array[],
  ): Promise<"installed" | "dropped"> {
    const key = await this.dataKey();
    const before = currentSeq(this.sql);
    const result = installFile(this.sql, key, jobId, extracted, vectors, Date.now());
    this.changed(before);
    return result;
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
    if (currentSeq(this.sql) > seq) this.push((reader) => changesSince(this.sql, seq, reader));
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
