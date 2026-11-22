import {
  activity,
  authenticate,
  callTool,
  questionOf,
  canSee,
  changesSince,
  classifyFile,
  dataKey,
  getFile,
  inBackground,
  installFile,
  installLookup,
  installLink,
  linkedOrcid,
  linkOrcid,
  unlinkOrcid,
  type Work,
  installProfile,
  linkWork,
  profileWork,
  requestChecks,
  kindHash,
  repoDeleted,
  syncRepos,
  type Repo,
  type Synced,
  listFiles,
  manifestOf,
  mintFileToken,
  mayClear,
  photoFor,
  photoImages,
  readText,
  recordUpload,
  refuseUpload,
  rewrapDataKey,
  sealFile,
  shareFile,
  shareHash,
  takeFileToken,
  unseal,
  viewFile,
  type VaultKeys,
  type Classified,
  dismissFill,
  forgetSecret,
  listSecrets,
  pendingFills,
  releaseFill,
  saveSecret,
  type FillView,
  type Released,
  type SavedSecret,
  type SecretInput,
  type SecretView,
  type Digest,
  draftRendering,
  packetOf,
  type Rendering,
  type FileToken,
  type Extracted,
  type FileView,
  type Found,
  type LinkSeen,
  type LinkWork,
  type Uploaded,
  connect,
  connectionOf,
  decide,
  digest,
  emails,
  setEmail,
  type Email,
  pending,
  proposalsRev,
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
  decline,
  waitingItems,
  waitingPlans,
  startReview,
  currentSeq,
  doSql,
  dueJobs,
  EMBED_MODEL,
  finishJob,
  jobInput,
  manifestVersion,
  markDispatched,
  migrate,
  mutate,
  mutateAll,
  nextWake,
  overLimit,
  planOf,
  purge,
  putChunks,
  reindex,
  schemaVersion,
  serve,
  setBilling,
  setPlan,
  undoRun,
  type Answer,
  type Approved,
  type WaitingPlan,
  type ChunkInput,
  type Connection,
  type Context,
  type Decided,
  type Pending,
  type Forbidden,
  type GrantPlan,
  type Granted,
  type Mutation,
  type MutationResult,
  type NoteRow,
  type Opened,
  type PlanState,
  type PlanView,
  type Principal,
  type Results,
  type Sql,
  type ProfileSeen,
  type ProfileWork,
  installReminders,
  reminderWork,
  type Reminder,
  type Waiting,
} from "@brainiac/base";
import { decodeClientMessage, type Manifest, type PlanItem, type ServerMessage } from "@brainiac/core";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { DurableObject } from "cloudflare:workers";

import { checkSignature, type Approver } from "./approvals.ts";
import { polarApp } from "./billing.ts";
import type { PacketFiles, PacketParts } from "./drafts.ts";
import type { Env } from "./env.ts";
import type { Models } from "./jobs.ts";

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

/**
 * What a job works on, for the jobs consumer: a note to index, a file to extract (and index once cleared), or a
 * paper's DOI to look up, a profile to read, or a saved link to check. A lookup leaves with the DOI alone, a
 * profile read with its link (and for Google Scholar, paper titles), and a link check with its address, never the
 * note. A reminder leaves as the email's words, which name only normal notes.
 */
export type JobWork =
  | { readonly kind: "index"; readonly note: NoteRow }
  | { readonly kind: "doi"; readonly doi: string }
  | { readonly kind: "drift"; readonly work: ProfileWork }
  | { readonly kind: "link"; readonly work: LinkWork }
  | { readonly kind: "remind"; readonly reminder: Reminder }
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
  /** The proposals counter the person's sockets last heard about (`proposalsRev`). */
  #proposals: number;
  /** The manifest version every socket last heard about (`manifestVersion`). */
  #manifest: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = doSql(ctx.storage);
    // Every wake: a record migrates the first time it is used after a deploy, and re-indexes in the background
    // when chunking or the embedding model changed. A migration can add background work (expiry reminders), so the
    // alarm is re-armed after one; the weekly questions email wakes every record, so none waits longer than a week.
    const { from, to } = migrate(this.sql);
    this.#proposals = proposalsRev(this.sql);
    this.#manifest = manifestVersion(this.sql);
    if (reindex(this.sql) || from !== to) this.wake();
    // Plan limits apply only on a stage that can take payment (billing.ts), so nobody is refused before Pro exists.
    setBilling(this.sql, polarApp(env) !== undefined);
    // While a rotation runs (infra/README.md#rotating-the-vault-key), the record moves its data key onto the new
    // vault key the first time it wakes, off the request it woke for.
    if (env.VAULT_KEY_PREVIOUS)
      this.rewrapDataKey().catch((error: unknown) =>
        console.error("vault key rewrap failed", { error: String(error) }),
      );
  }

  schemaVersion(): number {
    return schemaVersion(this.sql);
  }

  /** The record's plan and what it holds, for the account page. */
  plan(): PlanView {
    return planOf(this.sql, Date.now());
  }

  /** Polar's word on the plan (billing.ts), from its signed webhook; an older word arriving late changes nothing. */
  setPlan(state: PlanState): boolean {
    return setPlan(this.sql, state);
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

  /**
   * The dev seed (dev.ts): creates `mutations` as one change, all or none, only while the record holds no notes, so
   * it never adds to a record someone uses. One synchronous call, so two seeds at once can't interleave.
   */
  seedIfEmpty(
    mutations: readonly Mutation[],
    caller: Caller,
  ): ReturnType<typeof mutateAll> | { readonly status: "notEmpty"; readonly notes: number } {
    const ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    const notes = listNotes(this.sql).length;
    if (notes > 0) return { status: "notEmpty", notes };
    const before = currentSeq(this.sql);
    const result = mutateAll(this.sql, mutations, ctx);
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
   * record answers is the Worker's choice from the token; nothing in the call names one. A background call
   * (nobody there) runs narrowed: normal notes only, and every change waits for the person. A call that asks a
   * question (`questionOf`) has it embedded first, and its grants are read after, so a scope narrowed while the
   * model works applies to the answer.
   */
  async tool(
    via: ({ readonly oauthClientId: string } | { readonly connectionId: string }) & {
      readonly background?: boolean;
      /** The site's origin the call came in on, for the links an answer gives the person. */
      readonly origin?: string;
    },
    name: string,
    args: unknown,
  ): Promise<Answer> {
    const found =
      "oauthClientId" in via
        ? connect(this.sql, { kind: "oauth", oauthClientId: via.oauthClientId }, Date.now())
        : getConnection(this.sql, via.connectionId);
    if (!found) return { ok: false, error: "This connection was disconnected." };
    const question = questionOf(name, args);
    const vector = question === undefined ? undefined : await this.#embed(question);
    // Read again after the model call, by id: a grant narrowed meanwhile applies, and an app disconnected meanwhile
    // stays disconnected (`connect` would make it a new connection).
    const now = Date.now();
    const connection = question === undefined ? found : getConnection(this.sql, found.id);
    if (!connection) return { ok: false, error: "This connection was disconnected." };
    const before = currentSeq(this.sql);
    const answer = callTool(this.sql, name, args, {
      actor: `connection:${connection.id}`,
      connection,
      now,
      ...(via.background && { background: true }),
      ...(vector && { vector }),
      ...(via.origin !== undefined && { origin: via.origin }),
    });
    this.changed(before);
    this.env.USAGE?.writeDataPoint({
      indexes: [this.ctx.id.toString()],
      blobs: ["tool", name],
      doubles: [1],
    });
    return answer.ok && answer.attach !== undefined ? this.#withPhoto(answer, via) : answer;
  }

  /**
   * A `photos` answer with the photo or scan it names, read from R2 and opened, as images. The bytes are read after the call decided
   * it may have them, so it is decided again by the connection's row as it is now: a share the person turned off,
   * or a grant narrowed, while R2 answered holds.
   */
  async #withPhoto(
    answer: Extract<Answer, { readonly ok: true }>,
    via: Parameters<Base["tool"]>[0],
  ): Promise<Answer> {
    const { attach, ...rest } = answer;
    const file = attach && getFile(this.sql, attach.sha256);
    if (!attach || !file) return { ok: false, error: "That photo is gone." };
    const [key, object] = await Promise.all([this.dataKey(), this.env.BLOBS.get(file.r2Key)]);
    if (!object) throw new Error(`The record's file ${file.sha256} is missing from R2.`);
    const bytes = unseal(key, new Uint8Array(await object.arrayBuffer()), `file:${file.sha256}`);
    const connection =
      "oauthClientId" in via
        ? oauthConnection(this.sql, via.oauthClientId)
        : getConnection(this.sql, via.connectionId);
    const still =
      connection && photoFor(this.sql, via.background ? inBackground(connection) : connection, attach.noteId);
    if (!still || "error" in still || still.file.sha256 !== file.sha256)
      return { ok: false, error: still && "error" in still ? still.error : "That photo is gone." };
    const shown = photoImages(still.view.mime, bytes);
    if ("error" in shown) return { ok: false, error: shown.error };
    const { value } = rest;
    const said =
      shown.left !== undefined && typeof value === "object" && value !== null
        ? { ...value, left: shown.left }
        : value;
    return { ...rest, value: said, images: shown.images };
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

  /**
   * This week's email of questions (packages/base/src/questions.ts), for the Worker's weekly cron to send to the
   * record's owner; `undefined` when there is nothing to send. A sensitive question is only counted.
   */
  questionDigest(): Digest | undefined {
    return digest(this.sql, Date.now());
  }

  /**
   * Which emails go out (packages/base/src/emails.ts), the weekly questions and expiry reminders, after turning
   * `email` on or off if given. Each has its own switch, and only the site's session route changes one.
   */
  emails(email?: Email, on?: boolean): Record<Email, boolean> {
    if (email !== undefined && on !== undefined) setEmail(this.sql, email, on);
    return emails(this.sql);
  }

  /**
   * A saved Draft as Typst source, for the site's download route (the person's session only): it renders only
   * while every claim in it matches the record.
   */
  draftRendering(id: string): Rendering | { readonly error: string } {
    return draftRendering(this.sql, id, Date.now());
  }

  /**
   * An application's packet for the site's download route (the person's session only): its drafts as Typst
   * source and its cleared files' bytes, in the packet's order, and what the person adds by hand.
   */
  async packet(id: string): Promise<PacketFiles> {
    const packet = packetOf(this.sql, id, Date.now());
    if ("error" in packet) return packet;
    const key = await this.dataKey();
    const parts: PacketParts = [];
    const missing = [...packet.missing];
    // One file at a time, so only one sealed copy is in memory beside what the zip will hold.
    for (const part of packet.parts) {
      if (part.kind === "draft") {
        parts.push({ name: part.name, source: part.source });
        continue;
      }
      const object = await this.env.BLOBS.get(part.file.r2Key);
      if (!object) {
        // A bug, not a state: logged, and the packet still goes out with the file listed for the person.
        console.error("packet file missing from R2", part.file.sha256);
        missing.push({
          name: part.name,
          why: "is missing from storage: download it from the site, or upload it again",
        });
        continue;
      }
      const sealed = new Uint8Array(await object.arrayBuffer());
      parts.push({ name: part.name, bytes: unseal(key, sealed, `file:${part.file.sha256}`) });
    }
    return { name: packet.name, parts, missing };
  }

  /**
   * The person asks for their profiles to be checked for drift (packages/base/src/profiles.ts). Only the site's
   * signed-in person reaches it: a check is paid, so no connection starts one.
   */
  checkProfiles(): { readonly checking: number; readonly cached: number } {
    const asked = requestChecks(this.sql, Date.now());
    this.wake();
    return asked;
  }

  // The GitHub connector (connectors/github.ts reads GitHub; packages/base/src/github.ts decides). The Worker calls
  // these for an installation the record's owner linked, never from a request that names the record.

  /** What GitHub says about some repos: projects' `synced:` blocks refresh, new repos become proposals. */
  githubRepos(repos: readonly Repo[]): Synced {
    const before = currentSeq(this.sql);
    const result = syncRepos(this.sql, repos, Date.now());
    this.changed(before);
    return result;
  }

  /** A repo deleted on GitHub: its project keeps its snapshot, marked archived. */
  githubRepoDeleted(repoId: string): void {
    const before = currentSeq(this.sql);
    repoDeleted(this.sql, repoId, Date.now());
    this.changed(before);
  }

  // The ORCID connector (connectors/orcid.ts proves the iD; packages/base/src/orcid.ts decides). Only the Worker's
  // ORCID routes call these, for the signed-in owner, with an iD from ORCID's own answer.

  /** Links the iD ORCID proved: its works become proposals, and every paper is looked up again for its position. */
  linkOrcid(orcid: string, works: readonly Work[]): { readonly proposed: number } {
    const before = currentSeq(this.sql);
    const result = linkOrcid(this.sql, orcid, works, Date.now());
    this.changed(before);
    return result;
  }

  /** Forgets the linked iD; papers are looked up again without it. */
  unlinkOrcid(): void {
    unlinkOrcid(this.sql, Date.now());
    this.wake();
  }

  /** The linked ORCID iD, for the account page. */
  orcid(): string | null {
    return linkedOrcid(this.sql) ?? null;
  }

  /**
   * Search over the families the caller may see (`search` in @brainiac/base). The question is embedded here, in
   * the cloud, so a laptop online gets the same ranking by forwarding its call; when Workers AI can't embed it,
   * the answer is keyword-only and says so.
   */
  async search(text: string, caller: Caller): Promise<Results | Forbidden> {
    const asked = this.context(caller);
    if ("status" in asked) return asked;
    const vector = await this.#embed(text);
    // Read again after the model call: a grant narrowed meanwhile applies to this answer.
    const ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    return search(this.sql, principalOf(ctx.connection), text, { ...(vector && { vector }), now: ctx.now });
  }

  /** Workers AI, for questions' embeddings (the jobs consumer embeds chunks with its own). */
  protected models(): Pick<Models, "run"> {
    return this.env.AI;
  }

  /**
   * The question's embedding with `EMBED_MODEL`, or `undefined` when there is no question, nothing to compare it
   * with (a record not embedded yet doesn't wait on the model for a keyword-only answer), or Workers AI fails.
   */
  async #embed(text: string): Promise<number[] | undefined> {
    if (text.trim() === "") return undefined;
    const embedded = this.sql.all("SELECT 1 FROM vectors WHERE model = ? LIMIT 1", EMBED_MODEL);
    if (embedded.length === 0) return undefined;
    try {
      const { data } = await this.models().run(EMBED_MODEL, { text: [text], truncate_inputs: true });
      return data?.[0];
    } catch (error) {
      console.error("question embedding failed", error);
      return undefined;
    }
  }

  // Proposals. A connection may withdraw its own; only the site's session route may decide one.

  withdraw(proposalId: string, caller: Caller): Decided {
    const ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    const result = withdraw(this.sql, proposalId, ctx);
    this.wake();
    return result;
  }

  /** The open proposals the caller may see, with what each would change: the site's list to decide from. */
  listProposals(caller: Caller): Pending[] | Forbidden {
    const ctx = this.context(caller);
    return "status" in ctx ? ctx : pending(this.sql, principalOf(ctx.connection));
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
  // The site's routes (site.ts) call approve (`/api/approve`), startReview and openReview.

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
    const approved = "error" in signed ? signed : recordApproval(this.sql, items, signed, Date.now());
    if ("approvalId" in approved)
      // Every sync client (a laptop's daemon, another tab) resends a blocked edit with this plan.
      this.push(() => ({
        type: "approved",
        approvals: [{ planHash: planHash(items), approvalId: approved.approvalId }],
      }));
    return approved;
  }

  /**
   * Signs a plan the record kept waiting (`pend`) for an agent's or another device's change: the items are the
   * record's own, never the page's, so the passkey signs exactly what the change will do.
   */
  async approveWaiting(
    approvalId: string,
    response: AuthenticationResponseJSON,
    approver: Approver,
  ): Promise<Approved> {
    const items = waitingItems(this.sql, approvalId);
    if (!items) return { error: "This approval isn't waiting any more. Ask again for a new one." };
    return this.approve(items, response, approver);
  }

  /** The plans waiting for the person's passkey (or the one `approvalId` names), for the site's Approvals page. */
  pendingApprovals(approvalId?: string): WaitingPlan[] {
    return waitingPlans(this.sql, approvalId);
  }

  /** The person turns a waiting plan down; false if it wasn't waiting. */
  declineApproval(approvalId: string): boolean {
    return decline(this.sql, approvalId);
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
   * Seals a file into R2, then records it, runs the checks over its text and writes its sidecar note, in one
   * transaction after the only awaits. `kind` from the person is their confirmation; from a connection, a
   * suggestion. `name` is the uploader's filename, which only the person is ever shown.
   */
  async upload(
    bytes: Uint8Array,
    input: { readonly mime: string; readonly kind?: string; readonly name?: string },
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
    if (!getFile(this.sql, sha256)) {
      // A file the plan can't hold, or its sidecar note, never reaches R2.
      const full = overLimit(this.sql, Date.now(), { notes: 1, bytes: bytes.byteLength });
      if (full !== undefined) return { error: full };
      await this.env.BLOBS.put(r2Key, sealed);
      this.env.USAGE?.writeDataPoint({
        indexes: [this.ctx.id.toString()],
        blobs: ["upload", input.mime],
        doubles: [bytes.byteLength],
      });
    }
    // The puts awaited: the connection may have changed meanwhile, so it is loaded again.
    const ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    const before = currentSeq(this.sql);
    const text = readText(bytes, input.mime);
    const upload = {
      sha256,
      r2Key,
      mime: input.mime,
      bytes: bytes.byteLength,
      text,
      ...(input.kind !== undefined && { kind: input.kind }),
      ...(input.name !== undefined && { name: input.name }),
    };
    // Checked again with no await before recording: another upload may have filled the plan while R2 answered.
    const fresh = !getFile(this.sql, sha256);
    if (fresh) {
      const full = overLimit(this.sql, Date.now(), { notes: 1, bytes: bytes.byteLength });
      if (full !== undefined) {
        await this.#dropBlob(r2Key, sha256, sealed);
        return { error: full };
      }
    }
    const result = recordUpload(this.sql, key, upload, ctx);
    this.changed(before);
    // A new file the record didn't keep (a passport's second note past the plan's cap, say) leaves no blob behind.
    if (fresh && "error" in result && !getFile(this.sql, sha256)) await this.#dropBlob(r2Key, sha256, sealed);
    return result;
  }

  /** Deletes a blob the record didn't keep. Blobs are named by their bytes: a same-file upload that recorded while the
   * delete ran gets its blob back. */
  async #dropBlob(r2Key: string, sha256: string, sealed: Uint8Array): Promise<void> {
    await this.env.BLOBS.delete(r2Key);
    if (getFile(this.sql, sha256)) await this.env.BLOBS.put(r2Key, sealed);
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

  /**
   * The person lets their agents see a photo itself, or stops them. Only the site's session route may call this.
   * Letting them needs the person's passkey over the `challenge` a first call returns (contract §4).
   */
  async shareFile(
    sha256: string,
    on: boolean,
    caller: Caller,
    signed?: { readonly response: AuthenticationResponseJSON; readonly approver: Approver },
  ): Promise<Classified> {
    let ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    if (!signed || !on) return shareFile(this.sql, sha256, on, ctx);
    const file = getFile(this.sql, sha256);
    if (!file) return { error: "No such file." };
    const challenge = shareHash(file);
    const signature = await this.check(signed.response, challenge, signed.approver);
    if ("error" in signature) return signature;
    // The check awaited: a turn meanwhile counted in `shares`, which the challenge names.
    ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    return shareFile(this.sql, sha256, on, ctx, { challenge, signature });
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

  // Secrets and the fill path (secrets.ts). Only the site's session routes call these, for the person; an agent asks
  // for a fill with the `fill_form` tool and never gets a value back.

  secrets(caller: Caller): SecretView[] | Forbidden {
    const ctx = this.context(caller);
    return "status" in ctx ? ctx : listSecrets(this.sql, ctx);
  }

  /**
   * The person saves a secret or changes its domain or policy. Letting it fill without asking where it didn't
   * before needs their passkey over the `challenge` a first call returns.
   */
  async saveSecret(
    input: SecretInput,
    caller: Caller,
    signed?: { readonly response: AuthenticationResponseJSON; readonly approver: Approver },
  ): Promise<SavedSecret> {
    const key = await this.dataKey();
    const ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    const first = saveSecret(this.sql, key, input, ctx);
    if (!signed || !("challenge" in first)) return first;
    const signature = await this.check(signed.response, first.challenge, signed.approver);
    if ("error" in signature) return signature;
    // The check awaited: a save meanwhile bumped the secret's rev, which the challenge names.
    return saveSecret(
      this.sql,
      key,
      input,
      { ...ctx, now: Date.now() },
      { challenge: first.challenge, signature },
    );
  }

  forgetSecret(name: string, caller: Caller): { forgot: boolean } | Forbidden {
    const ctx = this.context(caller);
    return "status" in ctx ? ctx : forgetSecret(this.sql, name, ctx);
  }

  /** The fills waiting for the page the person's extension is on. */
  fills(url: string, caller: Caller): FillView[] | Forbidden {
    const ctx = this.context(caller);
    return "status" in ctx ? ctx : pendingFills(this.sql, url, ctx);
  }

  /**
   * The person presses Fill on the page at `url`: the fields' values, once, if the page is on every secret's saved
   * domain. An `ask` secret needs their passkey over the `challenge` a first call returns.
   */
  async fill(
    fillId: string,
    url: string,
    caller: Caller,
    signed?: { readonly response: AuthenticationResponseJSON; readonly approver: Approver },
  ): Promise<Released> {
    const key = await this.dataKey();
    const ctx = this.context(caller);
    if ("status" in ctx) return ctx;
    const first = releaseFill(this.sql, key, fillId, url, ctx);
    if (!signed || !("challenge" in first)) return first;
    const signature = await this.check(signed.response, first.challenge, signed.approver);
    if ("error" in signature) return signature;
    // The check awaited: the fill or a secret may have changed meanwhile, which the challenge names.
    return releaseFill(
      this.sql,
      key,
      fillId,
      url,
      { ...ctx, now: Date.now() },
      {
        challenge: first.challenge,
        signature,
      },
    );
  }

  dismissFill(fillId: string, caller: Caller): { dismissed: boolean } | Forbidden {
    const ctx = this.context(caller);
    return "status" in ctx ? ctx : dismissFill(this.sql, fillId, ctx);
  }

  /** The stage's vault keys: reading them is I/O, so it happens before any transaction that uses them. */
  protected async vaultKeys(): Promise<VaultKeys> {
    const [current, previous] = await Promise.all([
      this.env.VAULT_KEY.get(),
      this.env.VAULT_KEY_PREVIOUS?.get(),
    ]);
    return { current, previous };
  }

  /**
   * Moves the record's data key onto the current vault key if the previous one wraps it; makes none if it has none.
   * The id of the vault key that wraps it now, for the registry (the rotation sweep, vault-rotation.ts).
   */
  async rewrapDataKey(): Promise<string> {
    return rewrapDataKey(this.sql, await this.vaultKeys());
  }

  private dataKey(): Promise<Uint8Array> {
    if (!this.#dataKey) {
      const loading = this.vaultKeys().then((keys) => dataKey(this.sql, keys));
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
    if ("note" in input) {
      if (input.job.kind === "doi") return { kind: "doi", doi: String(JSON.parse(input.note.fm)["doi"]) };
      if (input.job.kind === "index") return { kind: "index", note: input.note };
      if (input.job.kind === "link") {
        const work = linkWork(input.note);
        if (work) return { kind: "link", work };
        // An address we may not fetch (not http or https) is never fetched: the link says so, as a check would.
        const before = currentSeq(this.sql);
        installLink(
          this.sql,
          jobId,
          { status: "unchecked", why: "it isn't a web address" },
          undefined,
          Date.now(),
        );
        this.changed(before);
        return null;
      }
      const work = profileWork(this.sql, input.note);
      if (work) return { kind: "drift", work };
      // Only a profile with a site and a link gets a job, at a revision that still has them; this can't happen.
      throw new Error(`drift job ${jobId} has no profile to read`);
    }
    if (!("file" in input)) return { kind: "remind", reminder: reminderWork(this.sql, Date.now()) };
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

  /** Marks the expiry reminders an email answered as sent (packages/base/src/reminders.ts). */
  installReminders(jobId: string, covered: readonly Waiting[]): "installed" | "dropped" {
    const result = installReminders(this.sql, jobId, covered);
    this.wake();
    return result;
  }

  /** Installs an index job's chunks, only while the note is still at the job's revision. */
  installIndex(jobId: string, chunks: readonly ChunkInput[]): "installed" | "dropped" {
    const result = finishJob(this.sql, jobId, (job) => putChunks(this.sql, job.noteId, job.rev, chunks));
    // The job made room on the queue for the next one.
    this.wake();
    return result;
  }

  /**
   * Writes what a paper's DOI lookup found into its `synced:` block, as the DOI connector, while the paper is still
   * at the job's revision (packages/base/src/papers.ts).
   */
  installLookup(jobId: string, found: Found): "installed" | "dropped" {
    const before = currentSeq(this.sql);
    const result = installLookup(this.sql, jobId, found, Date.now());
    this.changed(before);
    return result;
  }

  /** Writes what a profile showed into its `synced:` block, as the profiles connector (packages/base/src/profiles.ts). */
  installProfile(jobId: string, seen: ProfileSeen): "installed" | "dropped" {
    const before = currentSeq(this.sql);
    const result = installProfile(this.sql, jobId, seen, Date.now());
    this.changed(before);
    return result;
  }

  /**
   * Writes what a link check found into its `synced:` block, as the links connector (packages/base/src/links.ts). A
   * snapshot is sealed into R2 first, the only await, and recorded with its sidecar in the install's transaction.
   */
  async installLink(jobId: string, seen: LinkSeen, pdf?: Uint8Array): Promise<"installed" | "dropped"> {
    let snapshot;
    // A plan with no room for the snapshot (or its sidecar note) gets the link check without it.
    if (pdf && overLimit(this.sql, Date.now(), { notes: 1, bytes: pdf.byteLength }) === undefined) {
      const key = await this.dataKey();
      const { sha256, sealed } = sealFile(key, pdf);
      const r2Key = `blobs/${this.ctx.id.toString()}/${sha256}`;
      if (!getFile(this.sql, sha256)) await this.env.BLOBS.put(r2Key, sealed);
      snapshot = { sha256, r2Key, bytes: pdf.byteLength, key };
    }
    const before = currentSeq(this.sql);
    const result = installLink(this.sql, jobId, seen, snapshot, Date.now());
    this.changed(before);
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
    this.#tellProposals();
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
    this.#tellProposals();
    this.#tellManifest();
  }

  /**
   * Tells the person's open tabs their proposals changed, once per change, after the write that changed them. Every
   * write is followed by `wake`, so this one read covers every way a proposal comes, goes or turns into a conflict.
   * Connections' sockets never hear it: an agent has no proposals to decide.
   */
  #tellProposals(): void {
    const rev = proposalsRev(this.sql);
    if (rev === this.#proposals) return;
    this.#proposals = rev;
    const text = JSON.stringify({ type: "proposals" } satisfies ServerMessage);
    for (const ws of this.ctx.getWebSockets()) {
      const socket: Socket | null = ws.deserializeAttachment();
      if (socket?.clientId && !socket.actor.startsWith("connection:")) ws.send(text);
    }
  }

  /**
   * Tells every open socket the manifest changed, once per change, after the write that changed it (`wake` follows
   * every write, as for proposals). Only that it changed: the manifest itself goes to whoever asks again.
   * Sockets that haven't said hello hear it too, since a tab reads the manifest over HTTP while its hello is
   * on the way and could otherwise keep the one from before.
   */
  #tellManifest(): void {
    const version = manifestVersion(this.sql);
    if (version === this.#manifest) return;
    this.#manifest = version;
    const text = JSON.stringify({ type: "manifest" } satisfies ServerMessage);
    for (const ws of this.ctx.getWebSockets()) ws.send(text);
  }
}
