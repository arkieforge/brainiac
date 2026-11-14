import { chunkNote } from "@brainiac/base";

import type { JobMessage } from "./base.ts";
import type { Env } from "./env.ts";

/**
 * The jobs queue's consumer: does each job's work outside the record, then hands the result back, which the
 * record installs only if the note is still at the job's revision. A failure retries the message; the
 * record's lease also re-sends anything never acknowledged.
 */
export async function consume(batch: MessageBatch<JobMessage>, env: Pick<Env, "BASE">): Promise<void> {
  for (const message of batch.messages) {
    try {
      const base = env.BASE.get(env.BASE.idFromString(message.body.base));
      const note = await base.jobInput(message.body.jobId);
      if (note) await base.installIndex(message.body.jobId, chunkNote(note));
      message.ack();
    } catch (error) {
      console.error("job failed", message.body.jobId, error);
      message.retry();
    }
  }
}
