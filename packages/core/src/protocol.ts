import { type } from "arktype";

// The sync protocol between a client (tab, phone, daemon) and the record's DO. See docs/internals/sync-engine.md.

/** A client's change to one note. Edits and deletes carry the text they started from, for the three-way merge. */
const Change = type({ kind: "'create'", path: "string", raw: "string", class: "'normal' | 'sensitive'" })
  .or({ kind: "'put'", raw: "string", base: "string" })
  .or({ kind: "'delete'", base: "string" });
export type Change = typeof Change.infer;

const seq = "number.integer >= 0";

interface BeforeAfter<T> {
  readonly before?: T;
  readonly after?: T;
}

/**
 * What one transaction does to one note: each top-level front-matter field's value before and after (a missing
 * side means the field was absent), the body, whether the note was live, its privacy class when that changed, and
 * its path when it moved. Revisions store it as their inverse patch; approvals sign it.
 */
export interface Diff {
  readonly fields: Readonly<Record<string, BeforeAfter<unknown>>>;
  readonly body?: BeforeAfter<string>;
  readonly live?: BeforeAfter<boolean>;
  readonly class?: { readonly before: "normal" | "sensitive"; readonly after: "normal" | "sensitive" };
  readonly path?: { readonly before: string; readonly after: string };
}

/** One note's part of a plan: the note, the revision the change starts from, and what it does. */
export interface PlanItem {
  readonly noteId: string;
  /** 0 for a note the change creates. */
  readonly baseRev: number;
  readonly path: string;
  readonly class: "normal" | "sensitive";
  readonly patch: Diff;
}

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
  /** Counts this client's hellos; the snapshot names the one it answers, so an overtaken answer is ignored. */
  attempt: seq,
}).or({
  type: "'mutate'",
  clientId: "string > 0",
  /** This client's own counter, from 1, with no gaps: the DO applies only `highWater + 1`. */
  clientSeq: "number.integer >= 1",
  /** Random per change: a result names it, so a copy sharing this id never takes another's result as its own. */
  changeId: "0 < string <= 64",
  ackedUpTo: seq,
  noteId: "string > 0",
  baseRev: seq,
  change: Change,
  /**
   * An approval the person gave for this exact change, after a `needsApproval` result. It is only a reference:
   * the record applies the change only if its effect hashes to the plan the passkey signed. A resend carries a
   * new `changeId`, since the record answers a `changeId` it has seen with the answer it gave.
   */
  "approvalId?": "0 < string <= 64",
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
  | {
      readonly noteId: string;
      readonly seq: number;
      readonly deleted: true;
      /** Still in the record, but not for this reader (it turned sensitive, say): every copy and its history go. */
      readonly withheld?: true;
    };

export interface Result {
  readonly type: "result";
  readonly clientId: string;
  readonly clientSeq: number;
  /** The `changeId` of the mutation this answers. */
  readonly changeId: string;
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
  /** The edit alters a verified value: it lands once the person signs `planHash` with a passkey. */
  readonly needsApproval?: { readonly planHash: string; readonly items: readonly PlanItem[] };
  /** Why the edit was refused, for the person to fix. */
  readonly error?: string;
}

/** What a connection may do, as `describe` reports it: its level, the sensitive scope and its hold window. */
export interface Grants {
  readonly level: "read" | "propose" | "write";
  readonly sensitive: boolean;
  readonly holdDays: number;
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
      /**
       * To a connection's client (a laptop's daemon), what its local copy needs to answer reads offline as that
       * connection: its grants as of now, and the record's manifest. A change to the grants closes the socket, so
       * the next welcome carries them. Absent for the person, whose clients read everything.
       * shortcut: a manifest changed while the socket is open reaches the device on its next connect; nothing
       * changes a record's manifest yet.
       */
      readonly connection?: Grants;
      readonly manifest?: string | null;
    }
  /**
   * `clientSeq` was already used by a different change, or already acknowledged: two machines share this id.
   * The client that still holds that change as pending repairs under a new id; any other ignores it. Without a
   * `clientSeq`, the id belongs to another actor (a connection re-issued since, say): the client repairs.
   */
  | {
      readonly type: "reset";
      readonly clientId: string;
      readonly clientSeq?: number;
      readonly reason: string;
    }
  /** Every live note, for a client with no cursor or one older than the change feed; withheld ones only as such. */
  | {
      readonly type: "snapshot";
      readonly seq: number;
      readonly notes: readonly NoteState[];
      /** The hello it answers; null when not an answer to one. Taken as is, even if older than the cursor
       * (the record may have been restored from a backup). */
      readonly attempt: number | null;
    }
  /** Each note changed after `from`, as it is at `to`. */
  | {
      readonly type: "changes";
      readonly from: number;
      readonly to: number;
      readonly items: readonly NoteState[];
    }
  | Result
  /**
   * The record's open proposals changed: one came in, was decided, became a conflict or applied on its own. Only
   * the person's sockets get it, and it names nothing; the site then asks for the list (`/api/proposals`).
   */
  | { readonly type: "proposals" }
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
