import { type } from "arktype";

// The sync protocol between a client (tab, phone, daemon) and the record's DO. See docs/internals/sync-engine.md.

/** A client's change to one note. Edits and deletes carry the text they started from, for the three-way merge. */
const Change = type({ kind: "'create'", path: "string", raw: "string", class: "'normal' | 'sensitive'" })
  .or({ kind: "'put'", raw: "string", base: "string" })
  .or({ kind: "'delete'", base: "string" });
export type Change = typeof Change.infer;

const seq = "number.integer >= 0";

/** What a client may send. Checked on arrival: it comes from outside the record. */
export const ClientMessage = type({
  type: "'hello'",
  clientId: "string > 0",
  /** The last `seq` this client has, or null for none. */
  cursor: type("number.integer >= 0").or("null"),
  /** The last `clientSeq` it assigned. */
  lastAssigned: seq,
  /** Every result up to here is processed and stored; the DO may forget them. */
  ackedUpTo: seq,
  schemaVersion: seq,
  appVersion: "string",
}).or({
  type: "'mutate'",
  clientId: "string > 0",
  /** This client's own counter, from 1, with no gaps: the DO applies only `highWater + 1`. */
  clientSeq: "number.integer >= 1",
  ackedUpTo: seq,
  noteId: "string > 0",
  baseRev: seq,
  change: Change,
});
export type ClientMessage = typeof ClientMessage.infer;
export type Hello = Extract<ClientMessage, { type: "hello" }>;
export type Mutate = Extract<ClientMessage, { type: "mutate" }>;

/** A note as of `seq`: its text, or that it is gone. */
export type NoteState =
  | {
      readonly noteId: string;
      readonly seq: number;
      readonly deleted: false;
      readonly rev: number;
      readonly path: string;
      readonly raw: string;
      readonly class: "normal" | "sensitive";
    }
  | { readonly noteId: string; readonly seq: number; readonly deleted: true };

export interface Result {
  readonly type: "result";
  readonly clientId: string;
  readonly clientSeq: number;
  /** The edit, or the part of it that merged, is in the record. */
  readonly ok: boolean;
  readonly rev?: number;
  /** What the record kept instead of this edit; the person picks in the proposal. */
  readonly conflict?: {
    readonly proposalId: string;
    readonly fields: readonly string[];
    readonly body: boolean;
    /** The note was deleted on one side and edited on the other. */
    readonly deleted: boolean;
  };
  /** An approval the person must give before this edit can land (#12). */
  readonly needsApproval?: { readonly planHash: string };
  /** Why the edit was refused, for the person to fix. */
  readonly error?: string;
}

export type ServerMessage =
  /**
   * Answer to hello: send everything after `highWater`, in order. A client whose own counters are behind
   * these (it assigned fewer numbers, or acknowledged less) is a restored backup or a copy: it repairs.
   */
  | {
      readonly type: "welcome";
      readonly clientId: string;
      readonly highWater: number;
      readonly ackedUpTo: number;
    }
  /**
   * `clientSeq` was already used by a different change, or already acknowledged: two machines share this id.
   * The client that still holds that change as pending repairs under a new id; any other ignores it.
   */
  | { readonly type: "reset"; readonly clientId: string; readonly clientSeq: number; readonly reason: string }
  /** Every live note, for a client with no cursor or one older than the change feed. */
  | { readonly type: "snapshot"; readonly seq: number; readonly notes: readonly NoteState[] }
  /** Each note changed after `from`, as it is at `to`. */
  | {
      readonly type: "changes";
      readonly from: number;
      readonly to: number;
      readonly items: readonly NoteState[];
    }
  | Result
  /** `clientSeq` skipped a number: resend from `highWater + 1`. */
  | { readonly type: "gap"; readonly clientId: string; readonly highWater: number }
  | { readonly type: "error"; readonly message: string };

/** Decodes one message from a client socket, or says what is wrong with it. */
export function decodeClientMessage(text: string): ClientMessage | { readonly error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "Not JSON." };
  }
  const message = ClientMessage(data);
  return message instanceof type.errors ? { error: message.summary } : message;
}
