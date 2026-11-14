import type { Change, ClientMessage, NoteState, ServerMessage } from "@brainiac/core";

/** The last server-acknowledged version of a note. */
export interface Remote {
  readonly rev: number;
  readonly path: string;
  readonly raw: string;
  readonly class: "normal" | "sensitive";
}

/** A local change not yet answered, in order. Its base is the text it was made on, for the three-way merge. */
export interface Pending {
  readonly clientSeq: number;
  readonly noteId: string;
  readonly baseRev: number;
  readonly change: Change;
}

/** A saved local change the record kept out (conflict, invalid), with the reason. */
export interface Blocked {
  readonly change: Change;
  readonly reason: string;
  readonly proposalId?: string;
}

/** Everything a client must keep across restarts. #7 stores it in IndexedDB and `state.db`. */
export interface State {
  clientId: string;
  lastAssigned: number;
  ackedUpTo: number;
  cursor: number | null;
  readonly remote: Map<string, Remote>;
  pending: Pending[];
  readonly blocked: Map<string, Blocked>;
  /** Results received beyond `ackedUpTo` (they can arrive after a gap is refilled). */
  readonly answered: Set<number>;
}

export const emptyState = (clientId: string): State => ({
  clientId,
  lastAssigned: 0,
  ackedUpTo: 0,
  cursor: null,
  remote: new Map(),
  pending: [],
  blocked: new Map(),
  answered: new Set(),
});

export interface Options {
  readonly send: (message: ClientMessage) => void;
  /** A fresh client id, for repairing after a reset. */
  readonly newClientId: () => string;
  readonly schemaVersion: number;
  readonly appVersion: string;
}

/**
 * One client of the sync protocol: a tab, a phone or the daemon. It keeps the remote and pending layers,
 * sends its changes strictly in `clientSeq` order, acknowledges results implicitly on every message, and
 * repairs under a new id when the record resets it. Rejected edits move to blocked; nothing is dropped.
 */
export class SyncClient {
  readonly state: State;
  readonly #options: Options;
  #welcomed = false;

  constructor(state: State, options: Options) {
    this.state = state;
    this.#options = options;
  }

  /** The text a person sees: their newest pending change over the remote version; undefined if gone. */
  working(noteId: string): string | undefined {
    const last = this.state.pending.findLast((p) => p.noteId === noteId);
    if (!last) return this.state.remote.get(noteId)?.raw;
    return last.change.kind === "delete" ? undefined : last.change.raw;
  }

  connect(): void {
    this.#welcomed = false;
    const { clientId, cursor, lastAssigned, ackedUpTo } = this.state;
    this.#options.send({
      type: "hello",
      clientId,
      cursor,
      lastAssigned,
      ackedUpTo,
      schemaVersion: this.#options.schemaVersion,
      appVersion: this.#options.appVersion,
    });
  }

  disconnect(): void {
    this.#welcomed = false;
  }

  create(noteId: string, path: string, raw: string, cls: Remote["class"]): void {
    this.#queue(noteId, { kind: "create", path, raw, class: cls });
  }

  edit(noteId: string, raw: string): void {
    const base = this.working(noteId);
    if (base === undefined) throw new Error(`No note ${noteId} to edit.`);
    this.#queue(noteId, { kind: "put", raw, base });
  }

  delete(noteId: string): void {
    const base = this.working(noteId);
    if (base === undefined) throw new Error(`No note ${noteId} to delete.`);
    this.#queue(noteId, { kind: "delete", base });
  }

  #queue(noteId: string, change: Change): void {
    const pending = {
      clientSeq: ++this.state.lastAssigned,
      noteId,
      baseRev: this.state.remote.get(noteId)?.rev ?? 0,
      change,
    };
    this.state.pending.push(pending);
    if (this.#welcomed) this.#send(pending);
  }

  #send(pending: Pending): void {
    this.#options.send({
      type: "mutate",
      clientId: this.state.clientId,
      ackedUpTo: this.state.ackedUpTo,
      ...pending,
    });
  }

  /** Sends every pending change after `highWater`, in order. */
  #resend(highWater: number): void {
    for (const pending of this.state.pending) if (pending.clientSeq > highWater) this.#send(pending);
  }

  #take(items: readonly NoteState[]): void {
    for (const item of items) {
      if (item.deleted) this.state.remote.delete(item.noteId);
      else
        this.state.remote.set(item.noteId, {
          rev: item.rev,
          path: item.path,
          raw: item.raw,
          class: item.class,
        });
    }
  }

  receive(message: ServerMessage): void {
    const { state } = this;
    if ("clientId" in message && message.clientId !== state.clientId) return; // meant for an id we left
    switch (message.type) {
      case "welcome":
        // The record has seen more from this id than this copy did: it is a restored backup or a copy.
        if (message.highWater > state.lastAssigned || message.ackedUpTo > state.ackedUpTo)
          return this.#repair();
        this.#welcomed = true;
        this.#resend(message.highWater);
        return;
      case "gap":
        this.#resend(message.highWater);
        return;
      case "snapshot":
        state.remote.clear();
        this.#take(message.notes);
        state.cursor = message.seq;
        return;
      case "changes":
        // A push that starts after our cursor means we missed one: catch up through hello.
        if (state.cursor === null || message.from > state.cursor) return this.connect();
        if (message.to <= state.cursor) return;
        this.#take(message.items);
        state.cursor = message.to;
        return;
      case "result": {
        if (message.clientSeq <= state.ackedUpTo || state.answered.has(message.clientSeq)) return;
        const pending = state.pending.find((p) => p.clientSeq === message.clientSeq);
        state.pending = state.pending.filter((p) => p.clientSeq !== message.clientSeq);
        if (pending && (!message.ok || message.conflict)) {
          state.blocked.set(pending.noteId, {
            change: pending.change,
            reason: message.error ?? (message.conflict ? "conflict" : "refused"),
            ...(message.conflict && { proposalId: message.conflict.proposalId }),
          });
        }
        state.answered.add(message.clientSeq);
        while (state.answered.delete(state.ackedUpTo + 1)) state.ackedUpTo++;
        return;
      }
      case "reset":
        // Only the copy that still holds the change repairs; a late duplicate of a finished one is ignored.
        if (state.pending.some((p) => p.clientSeq === message.clientSeq)) this.#repair();
        return;
      case "error":
        return;
    }
  }

  /**
   * Under a new id, turns every difference between what this copy shows and the last remote version into a
   * fresh pending change against that remote version, so the record's three-way merge decides each one:
   * nothing is replayed blindly, and nothing local is lost.
   */
  #repair(): void {
    const { state } = this;
    const notes = new Set(state.pending.map((p) => p.noteId));
    const changes = [...notes].flatMap((noteId): [string, Change][] => {
      const working = this.working(noteId);
      const first = state.pending.find((p) => p.noteId === noteId)?.change;
      // What this copy's changes to the note were made on: the text its first pending change started from
      // (the remote layer may have moved on since, or lost the note), or the remote version.
      const base = (first && "base" in first ? first.base : undefined) ?? state.remote.get(noteId)?.raw;
      if (working === base) return [];
      if (working === undefined) return base === undefined ? [] : [[noteId, { kind: "delete", base }]];
      if (base !== undefined) return [[noteId, { kind: "put", raw: working, base }]];
      return first?.kind === "create" ? [[noteId, { ...first, raw: working }]] : [];
    });
    state.clientId = this.#options.newClientId();
    state.lastAssigned = 0;
    state.ackedUpTo = 0;
    state.answered.clear();
    state.pending = [];
    for (const [noteId, change] of changes) this.#queue(noteId, change);
    this.connect();
  }
}
