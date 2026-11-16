// The body editor's logic, apart from CodeMirror's view. How a change from the record reaches the editor: one minimal edit, so the cursor and anything typed but not
// yet sent map through it, kept out of undo history, so Ctrl+Z undoes only the person's own typing and never sends
// another tab's edit back as a revert.
import { Annotation, Transaction, type EditorState, type TransactionSpec } from "@codemirror/state";
import type { SyncClient } from "@brainiac/sync";

import { bodyOf, savesOnline, withBody, type Approval, type Base, type Saved } from "./fields.ts";

/** Marks a change that came from the record, so it isn't sent back as the person's edit. */
export const fromRecord = Annotation.define<boolean>();

/** The smallest one-range change from `before` to `after`. */
function change(before: string, after: string) {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let end = 0;
  while (
    end < before.length - from &&
    end < after.length - from &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  return { from, to: before.length - end, insert: after.slice(from, after.length - end) };
}

/** The transaction that brings the editor to the record's `body`, or undefined when it already shows it. */
export function recordChange(state: EditorState, body: string): TransactionSpec | undefined {
  const before = state.doc.toString();
  if (before === body) return undefined;
  return {
    changes: change(before, body),
    annotations: [fromRecord.of(true), Transaction.addToHistory.of(false)],
  };
}

/** What a sensitive note's body save goes through: `saveOnline` with the draft's base, in the site. */
export type SaveFrom = (noteId: string, base: Base, raw: string) => Promise<Saved>;

/**
 * The body editor's draft: the person's text and the note text and revision it was typed over. Every send is made
 * on that base, never on whatever the record has by the time it goes: a normal note's edit carries it into the sync
 * client, so the record's three-way merge keeps both sides; a sensitive note's online save sends its revision, so
 * a body changed elsewhere since comes back as a conflict, the person's text stays in the editor, and nothing is
 * overwritten.
 */
export class BodyDraft {
  readonly #client: SyncClient;
  readonly #noteId: string;
  readonly #save: SaveFrom;
  /** After a save's answer: the body to show, when the record moved on meanwhile, and the conflict state. */
  readonly #changed: (body: string | undefined) => void;
  #base: Base;
  #body: string;
  /** Typed and not sent yet. */
  #dirty = false;
  /** A sensitive note's online save is on its way; the next waits for it, to build on what it wrote. */
  #saving = false;
  #conflict: string | undefined;
  /** The last save, held by the record for the person's passkey. */
  #approval: Approval | undefined;

  constructor(
    client: SyncClient,
    noteId: string,
    save: SaveFrom,
    changed: (body: string | undefined) => void,
  ) {
    this.#client = client;
    this.#noteId = noteId;
    this.#save = save;
    this.#changed = changed;
    this.#base = this.#record() ?? { rev: 0, raw: "" };
    this.#body = bodyOf(this.#base.raw);
  }

  get body(): string {
    return this.#body;
  }

  /** Why the last save didn't land; the person's text stays until they try again or take the record's. */
  get conflict(): string | undefined {
    return this.#conflict;
  }

  /** The plan the last save needs the person's passkey over, while it waits for them. */
  get approval(): Approval | undefined {
    return this.#approval;
  }

  /** The person typed: `body` is the editor's whole text now. */
  type(body: string): void {
    this.#body = body;
    this.#dirty = true;
  }

  /** The note as the record (and, for a normal note, this tab's queued edits) has it now. */
  #record(): Base | undefined {
    const rev = this.#client.state.remote.get(this.#noteId)?.rev;
    const raw = this.#client.working(this.#noteId);
    return rev === undefined || raw === undefined ? undefined : { rev, raw };
  }

  /** Sends what was typed, on the base it was typed over. */
  flush(): void {
    if (!this.#dirty || this.#conflict !== undefined) return;
    const base = this.#base;
    const raw = withBody(base.raw, this.#body);
    if (!savesOnline(this.#client, this.#noteId)) {
      this.#dirty = false;
      this.#base = { rev: base.rev, raw };
      if (raw !== base.raw) this.#client.edit(this.#noteId, raw, base.raw);
      return;
    }
    if (this.#saving) return; // sent once the save before it lands, on what that one wrote
    this.#dirty = false;
    if (raw === base.raw) return;
    this.#saving = true;
    void this.#save(this.#noteId, base, raw).then((saved) => this.#landed(saved));
  }

  #landed(saved: Saved): void {
    this.#saving = false;
    if (saved && "error" in saved) {
      this.#conflict = saved.error;
      this.#approval = saved.approval;
      this.#dirty = true;
    } else if (saved) this.#base = saved;
    // A push that came while the save was on its way was held back; catch up with whichever is newer now,
    // after sending anything typed meanwhile on what this save wrote.
    this.#changed(this.fromRecord());
  }

  /**
   * The person approved the held save with their passkey: the same text goes again on the same base, citing the
   * approval. Anything typed since follows it once it lands, on what it wrote.
   */
  async approved(approvalId: string): Promise<void> {
    const approval = this.#approval;
    if (!approval) return;
    this.#conflict = undefined;
    this.#approval = undefined;
    this.#saving = true;
    this.#landed(await approval.resend(approvalId));
  }

  /**
   * The record's note changed: unsent typing goes first, on its own base; then the editor takes the record's
   * body, unless the person's text is still waiting to land. Returns the body to show, if it should change.
   */
  fromRecord(): string | undefined {
    if (savesOnline(this.#client, this.#noteId)) {
      const record = this.#record();
      if (!record || this.#saving || this.#conflict !== undefined) return undefined;
      if (this.#dirty) {
        // Only the front-matter moved (a field edit): the typing still applies, on the record's new text.
        if (record.rev > this.#base.rev && bodyOf(record.raw) === bodyOf(this.#base.raw)) this.#base = record;
        this.flush();
        return undefined;
      }
      if (record.rev < this.#base.rev) return undefined; // this tab's own save, not pushed back yet
    }
    // A normal note's typing joins the client's queue first; its view then merges it over the record's text.
    else this.flush();
    const record = this.#record();
    if (!record) return undefined;
    this.#base = record;
    this.#body = bodyOf(record.raw);
    return this.#body;
  }

  /** After a conflict: send the person's text again on the same base (a real conflict answers the same). */
  retry(): void {
    this.#conflict = undefined;
    this.#approval = undefined;
    this.#dirty = true;
    this.flush();
  }

  /** After a conflict: drop the person's text for the record's. Returns the body to show. */
  takeRecord(): string | undefined {
    this.#conflict = undefined;
    this.#approval = undefined;
    this.#dirty = false;
    return this.fromRecord();
  }
}
