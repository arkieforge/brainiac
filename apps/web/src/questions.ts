// The person's questions in this tab (packages/core/src/questions.ts): found from the notes it holds, so a gap
// filled on another device or by an agent closes here as soon as its edit arrives. An answer is the person's
// ordinary edit to each note it touches, through the same paths as the note form: the sync client, or online
// only for a sensitive note.
import {
  answerEdits,
  findQuestions,
  patch,
  parseNote,
  validate,
  type Manifest,
  type Question,
  type Reply,
} from "@brainiac/core";
import type { SyncClient } from "@brainiac/sync";

import { savesOnline, type SaveOnline } from "./fields.ts";
import { parsedNotes } from "./review.ts";

/** Every open question on this tab's copy, soonest deadline first. */
export const questionsOf = (
  client: SyncClient | undefined,
  manifest: Manifest | null,
  now: number,
): Question[] => findQuestions(parsedNotes(client), manifest, now);

/** What's wrong with a note's next text for the fields an edit touched, by the record's own validator. */
function issueWith(manifest: Manifest | null, raw: string, fields: ReadonlySet<string>): string | undefined {
  if (!manifest) return undefined;
  const issue = validate(manifest, parseNote(raw).data).find((i) => fields.has(i.field));
  return issue?.message;
}

/**
 * Sends an answer, one note at a time and in order, as the person's edits. Stops at the first that can't be made:
 * an asked question is closed last, so it never says answered when its value didn't land. Resolves to why it
 * stopped, or undefined once every edit is sent.
 */
export async function answer(
  client: SyncClient,
  manifest: Manifest | null,
  question: Question,
  reply: Reply,
  online: SaveOnline,
): Promise<string | undefined> {
  for (const { noteId, ops } of answerEdits(question, reply)) {
    const base = client.working(noteId);
    if (base === undefined) return "This note is gone.";
    let raw: string;
    try {
      raw = patch(base, ops);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    const issue = issueWith(
      manifest,
      raw,
      new Set(ops.flatMap((op) => ("path" in op ? [String(op.path[0])] : []))),
    );
    if (issue) return issue;
    if (savesOnline(client, noteId)) {
      const saved = await online(noteId, (latest) => patch(latest, ops));
      if (saved && "error" in saved) return saved.error;
    } else if (raw !== base) client.edit(noteId, raw, base);
  }
  return undefined;
}
