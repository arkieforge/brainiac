// The real Base DO and jobs consumer, loaded into workerd by base.test.ts. TestBase adds what a test needs to
// see and steer: reads, a crash, and running the dispatcher when the test says rather than when it fires.
import { getNote, search, type ChunkInput, type Job, type Principal } from "@brainiac/base";

import { ACTOR_HEADER, Base } from "../src/base.ts";
import type { Env } from "../src/env.ts";
import { consume } from "../src/jobs.ts";

export class TestBase extends Base {
  readonly #waiting: ((result: "installed" | "dropped") => void)[] = [];
  readonly #alarms: (() => void)[] = [];

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

  jobs(): Job[] {
    return this.sql.all<Job>("SELECT * FROM jobs ORDER BY id");
  }

  find(principal: Principal, text: string): string[] {
    return search(this.sql, principal, text).map((hit) => hit.noteId);
  }

  rev(noteId: string): number | null {
    return getNote(this.sql, noteId)?.rev ?? null;
  }

  /** Gives the record a manifest, as onboarding does. */
  setManifest(yaml: string): void {
    this.sql.all("INSERT INTO schema (version, manifest) VALUES (1, ?)", yaml);
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

export default {
  queue: consume,
  // Stands in for the authenticated route (#87): every socket reaches one record, as "tester" (the person), or as
  // the actor `?as=` names, like `connection:<id>`. The real route takes the actor from the session or token.
  fetch: (request: Request, env: Env) => {
    const headers = new Headers(request.headers);
    headers.set(ACTOR_HEADER, new URL(request.url).searchParams.get("as") ?? "tester");
    return env.BASE.get(env.BASE.idFromName("sync")).fetch(request.url, { headers });
  },
};
