import {
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
  undoRun,
  type ChunkInput,
  type Mutation,
  type MutationResult,
  type NoteRow,
  type Sql,
  type UndoResult,
} from "@brainiac/base";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env.ts";

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
 * Every change goes through `mutate` or `undoRun` (`@brainiac/base`), one SQL transaction each with no I/O,
 * and follow-up work leaves through the jobs outbox, dispatched by the alarm.
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
    const result = mutate(this.sql, mutation, { ...caller, now: Date.now() });
    this.wake();
    return result;
  }

  undoRun(runId: string, caller: Caller): UndoResult {
    const result = undoRun(this.sql, runId, { ...caller, now: Date.now() });
    this.wake();
    return result;
  }

  /** The note a job works on, or `null` when the job is done or stale (its note has moved on). */
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
      await this.env.JOBS.sendBatch(
        due.map((job) => ({ body: { base: this.ctx.id.toString(), jobId: job.id } })),
      );
      markDispatched(
        this.sql,
        due.map((job) => job.id),
        now,
      );
    }
    this.wake();
  }

  /** Points the alarm at the next background work, or clears it. No await separates it from the write it follows,
   * so the runtime commits both together. */
  private wake(): void {
    const at = nextWake(this.sql, Date.now());
    void (at === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(at));
  }
}
