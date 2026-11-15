// Review mode's session (contract §4): one passkey signature over a nonce covers verify, fix and undo on the items
// it was opened over, for 10 minutes. The record checks every edit against it; this tab only remembers which
// nonce to send and when to ask for a new signature.
import {
  overview,
  parseNote,
  type Manifest,
  type Overview,
  type QuestionNote,
  type ReviewNote,
} from "@brainiac/core";
import type { SyncClient } from "@brainiac/sync";

import { sign } from "./approve.ts";
import { api } from "./record.ts";

/** How long a session lasts after its signature (REVIEW_MS in packages/base), less a margin for the clock. */
const SESSION_MS = 10 * 60 * 1000 - 30_000;
/** How many items, from the current one on, a signature covers: the ones this session will show. */
export const SESSION_ITEMS = 50;

let session:
  | { readonly nonce: string; readonly until: number; readonly items: ReadonlySet<string> }
  | undefined;

/** The open session's nonce, if it covers `noteId` and hasn't run out. */
export const sessionFor = (noteId: string, now = Date.now()) =>
  session && session.until > now && session.items.has(noteId) ? session.nonce : undefined;

/** Forgets the session: the record said it ended. */
export const endSession = () => {
  session = undefined;
};

const postJson = (path: string, body: unknown) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Starts a session over `noteIds` and has the person sign its nonce with their passkey. */
export async function openSession(noteIds: readonly string[]): Promise<string | { readonly error: string }> {
  const started = await postJson("/api/review", { noteIds }).catch(() => undefined);
  const body = await started?.json().catch(() => ({}));
  if (!started?.ok || typeof body?.nonce !== "string")
    return { error: body?.error ?? "Review couldn't start. Are you online?" };
  const nonce: string = body.nonce;
  const signed = await sign(nonce);
  if ("error" in signed) return { error: "No passkey answered, so nothing was checked." };
  const opened = await postJson("/api/review/open", { nonce, response: signed.response }).catch(
    () => undefined,
  );
  const answer = await opened?.json().catch(() => ({}));
  if (!opened?.ok) return { error: answer?.error ?? "Your passkey's answer didn't check out." };
  session = { nonce, until: Date.now() + SESSION_MS, items: new Set(noteIds) };
  return nonce;
}

/** Parsed front-matter by note, reused while the text is the same: the overview re-reads only what changed. */
const parsed = new Map<string, { readonly raw: string; readonly data: ReviewNote["data"] }>();

/** Every note the person can see in this tab's copy, parsed, in path order, as the detectors and questions read it. */
export function parsedNotes(client: SyncClient | undefined): QuestionNote[] {
  const notes: QuestionNote[] = [];
  const seen = new Set<string>();
  for (const [id, remote] of client?.state.remote ?? []) {
    const raw = client?.working(id);
    if (raw === undefined) continue;
    seen.add(id);
    let entry = parsed.get(id);
    if (entry?.raw !== raw) {
      try {
        entry = { raw, data: parseNote(raw).data };
      } catch {
        // A note whose front-matter can't be read has no fields to judge; its own pane says why.
        continue;
      }
      parsed.set(id, entry);
    }
    notes.push({ id, path: remote.path, data: entry.data, class: remote.class });
  }
  for (const id of parsed.keys()) if (!seen.has(id)) parsed.delete(id);
  return notes.toSorted((a, b) => a.path.localeCompare(b.path));
}

/** The record's overview from this tab's copy: every note the person can see, as the detectors read it. */
export function overviewOf(client: SyncClient | undefined, manifest: Manifest | null, now: number): Overview {
  return overview(parsedNotes(client), manifest, now);
}
