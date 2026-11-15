import { merge, type Change, type ClientMessage, type NoteState, type ServerMessage } from "@brainiac/core";

import { toSaved, type Store, type Write } from "./store.ts";

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
  readonly changeId: string;
  readonly noteId: string;
  readonly baseRev: number;
  readonly change: Change;
}

/**
 * A saved local change the record kept out (conflict, invalid), with the reason. A refused one clears when an
 * edit made on its text lands (the person fixed it); a conflict clears once the record moves past `rev`
 * (someone picked a side, or changed the note again).
 */
export interface Blocked {
  readonly change: Change;
  readonly reason: string;
  readonly proposalId?: string;
  /** The note's revision when the record kept this edit out as a conflict. */
  readonly rev?: number;
}

/** Everything a client must keep across restarts, kept in a `Store`. */
export interface State {
  clientId: string;
  lastAssigned: number;
  ackedUpTo: number;
  cursor: number | null;
  readonly remote: Map<string, Remote>;
  pending: Pending[];
  /** Per note, oldest first: a second refused edit never replaces the first. */
  readonly blocked: Map<string, Blocked[]>;
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
  /**
   * Where the state is kept across restarts; without one it lives only in memory. Each change is written as
   * soon as it is made, without holding back the send: a send that outruns a write lost in a crash makes the
   * record's counters run ahead of the stored ones, and the next `welcome` repairs (see `receive`).
   */
  readonly store?: Store;
  /**
   * The person chose "keep sensitive notes on this device" for a device they marked as theirs (contract §5).
   * Otherwise sensitive notes are never written to the store, and a restart takes a snapshot to get them
   * back. Pending and blocked edits to them are still written, since they are the person's unsent work.
   * shortcut: every restart with sensitive notes re-downloads the record; load them on demand instead once
   * the record serves single notes on demand (`get`, #17).
   */
  readonly keepSensitive?: boolean;
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
  #attempt = 0;
  /** Notes whose remote, pending or blocked layer changed since the last commit. */
  readonly #touched = new Set<string>();
  readonly #remoteChanged = new Set<string>();
  #dirty = false;
  /** The next write replaces every stored remote note. */
  #clear = false;
  #saved: Promise<void> = Promise.resolve();
  /** A write failed and no full rewrite has landed since: the store may lack remote notes. */
  #broken = false;
  readonly #listeners = new Set<(noteIds: ReadonlySet<string>) => void>();
  /**
   * Changes the record accepted whose new revision hasn't reached the remote layer yet: a result arrives just
   * before its push, and without these the view would fall back to the older text (or none, for a create) in
   * between. Each goes once the remote layer has its revision. Not stored: a restart catches up first.
   */
  #landed: (Pending & { readonly rev: number })[] = [];
  /**
   * Notes the record withholds from this client's principal. Not stored: while there are any, the stored cursor
   * is null, so a restart takes a snapshot, which names them again.
   */
  readonly #withheld = new Set<string>();

  constructor(state: State, options: Options) {
    this.state = state;
    this.#options = options;
    // Kept by an earlier run that had "keep sensitive notes" on: turning it off takes them off the device.
    if (!options.keepSensitive && [...state.remote.values()].some((note) => note.class === "sensitive")) {
      this.#clear = this.#dirty = true;
      this.#commit();
    }
  }

  /** The client kept in `store`, or a new one if it holds nothing yet. */
  static async open(options: Options & { readonly store: Store }): Promise<SyncClient> {
    const state = (await options.store.load()) ?? emptyState(options.newClientId());
    return new SyncClient(state, options);
  }

  /**
   * The text a person sees (remote + pending); undefined if gone. Each pending edit, in order, is merged over
   * the text so far from its own base, the way the record will merge it, with the edit kept where both sides
   * changed the same thing: the record then keeps it as a conflict, so it is never hidden here.
   */
  working(noteId: string): string | undefined {
    let text = this.state.remote.get(noteId)?.raw;
    for (const { noteId: id, change } of [...this.#landed, ...this.state.pending]) {
      if (id !== noteId) continue;
      if (change.kind === "delete") text = undefined;
      else if (change.kind === "create" || text === undefined) text = change.raw;
      else {
        try {
          text = merge(change.base, text, change.raw).raw;
        } catch {
          text = change.raw; // unreadable front-matter: shown as written; the record will say why it refuses it
        }
      }
    }
    return text;
  }

  /** The record withholds this note from this client (it turned sensitive, say): no copy of it may stay. */
  withheld(noteId: string): boolean {
    return this.#withheld.has(noteId);
  }

  /** Calls `listener` with the notes that changed after every change to the state, local or remote. */
  subscribe(listener: (noteIds: ReadonlySet<string>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Writes the whole state to the store again, as for a new store that must start with all of it. */
  saveAll(): void {
    this.#clear = this.#dirty = true;
    this.#commit();
  }

  /** Settles once every change so far is in the store; rejects if the latest write failed. */
  saved(): Promise<void> {
    return this.#saved;
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
      attempt: ++this.#attempt,
    });
  }

  disconnect(): void {
    this.#welcomed = false;
  }

  create(noteId: string, path: string, raw: string, cls: Remote["class"]): void {
    this.#queue(noteId, { kind: "create", path, raw, class: cls });
    this.#commit();
  }

  /**
   * Queues `raw` as an edit of the note. `base` is the text it was made on: by default what the person sees,
   * but a save found on disk was made on the file's earlier text, and the record merges from the base.
   */
  edit(noteId: string, raw: string, base = this.working(noteId)): void {
    if (base === undefined) throw new Error(`No note ${noteId} to edit.`);
    this.#queue(noteId, { kind: "put", raw, base });
    this.#commit();
  }

  /** Queues a delete of the note; `base` is the text it was deleted from, as for `edit`. */
  delete(noteId: string, base = this.working(noteId)): void {
    if (base === undefined) throw new Error(`No note ${noteId} to delete.`);
    this.#queue(noteId, { kind: "delete", base });
    this.#commit();
  }

  /** Forgets the note's blocked edits: the person keeps the record's version, or picked in the proposal. */
  dismiss(noteId: string): void {
    if (!this.state.blocked.delete(noteId)) return;
    this.#touch(noteId);
    this.#commit();
  }

  #touch(noteId: string): void {
    this.#touched.add(noteId);
    this.#dirty = true;
  }

  /**
   * Writes what changed to the store, then tells the listeners. The write starts now, not after the one
   * before it, so an edit is on its way to disk before a closing tab can stop it (both stores keep order).
   */
  #commit(): void {
    if (!this.#dirty) return;
    this.#dirty = false;
    const { store } = this.#options;
    if (store) {
      const write = this.#write();
      const done = store.write(write);
      this.#saved = done;
      const settle = (failed: boolean) => {
        if (failed) this.#broken = this.#clear = this.#dirty = true;
        else if (write.clear) this.#broken = false;
        // Only the latest write repairs, with one full rewrite; if that fails too, the next change tries again,
        // so a full disk is never retried in a loop. Writes finish in order, so earlier failures are known here.
        if (this.#broken && this.#saved === done && !write.clear) this.#commit();
      };
      done.then(
        () => settle(false),
        () => settle(true),
      );
    }
    if (this.#touched.size === 0) return;
    const touched = new Set(this.#touched);
    this.#touched.clear();
    for (const listener of this.#listeners) listener(touched);
  }

  /** The write for what changed since the last one. */
  #write(): Write {
    const { remote } = this.state;
    const clear = this.#clear;
    const kept = (note: Remote | undefined) =>
      note && (note.class === "normal" || this.#options.keepSensitive) ? note : null;
    const saved = toSaved(this.state);
    const withheld = this.#withheld.size > 0 || [...remote.values()].some((note) => !kept(note));
    const write = {
      // Without its sensitive or withheld notes the stored remote layer is incomplete, so a restart starts
      // over, and the snapshot it gets names every note to keep off the device again.
      saved: withheld ? { ...saved, cursor: null } : saved,
      clear,
      remote: [...(clear ? remote.keys() : this.#remoteChanged)].map(
        (id) => [id, kept(remote.get(id))] as const,
      ),
    };
    this.#clear = false;
    this.#remoteChanged.clear();
    return write;
  }

  #queue(noteId: string, change: Change, changeId: string = crypto.randomUUID()): void {
    const pending = {
      clientSeq: ++this.state.lastAssigned,
      changeId,
      noteId,
      baseRev: this.state.remote.get(noteId)?.rev ?? 0,
      change,
    };
    this.state.pending.push(pending);
    this.#touch(noteId);
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
      this.#touch(item.noteId);
      this.#remoteChanged.add(item.noteId);
      this.#landed = this.#landed.filter(
        (l) => l.noteId !== item.noteId || (!item.deleted && l.rev > item.rev),
      );
      if (item.deleted && item.withheld) this.#withheld.add(item.noteId);
      else this.#withheld.delete(item.noteId);
      if (item.deleted) this.state.remote.delete(item.noteId);
      else {
        const rev = item.rev;
        this.#unblock(item.noteId, (b) => b.rev !== undefined && b.rev < rev);
        this.state.remote.set(item.noteId, {
          rev: item.rev,
          path: item.path,
          raw: item.raw,
          class: item.class,
        });
      }
    }
  }

  /** Drops the landed changes `drop` picks; their notes' view changes, so listeners hear of them. */
  #dropLanded(drop: (landed: Pending & { readonly rev: number }) => boolean): void {
    for (const landed of this.#landed) if (drop(landed)) this.#touch(landed.noteId);
    this.#landed = this.#landed.filter((landed) => !drop(landed));
  }

  /** Drops the note's blocked edits that `drop` picks. */
  #unblock(noteId: string, drop: (blocked: Blocked) => boolean): void {
    const list = this.state.blocked.get(noteId);
    const kept = list?.filter((b) => !drop(b));
    if (!list || !kept || kept.length === list.length) return;
    if (kept.length > 0) this.state.blocked.set(noteId, kept);
    else this.state.blocked.delete(noteId);
    this.#touch(noteId);
  }

  receive(message: ServerMessage): void {
    this.#receive(message);
    this.#commit();
  }

  #receive(message: ServerMessage): void {
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
        // Only the answer to this client's latest hello counts; an older one has been overtaken.
        if (message.attempt !== this.#attempt) return;
        for (const noteId of state.remote.keys()) this.#touch(noteId);
        state.remote.clear();
        this.#withheld.clear(); // the snapshot names every withheld note again
        this.#dropLanded(() => true); // the snapshot is the record as a whole
        this.#remoteChanged.clear();
        this.#clear = true;
        this.#dirty = true;
        this.#take(message.notes);
        state.cursor = message.seq;
        return;
      case "changes":
        // A push that starts after our cursor means we missed one: catch up through hello.
        if (state.cursor === null || message.from > state.cursor) return this.connect();
        if (message.to <= state.cursor) return;
        // The record pushes an applied change right after its result. A landed change whose note isn't in the
        // next push was never applied (a no-op, say against a deleted note), so it stops showing.
        this.#dropLanded((l) => !message.items.some((item) => item.noteId === l.noteId));
        this.#take(message.items);
        state.cursor = message.to;
        return;
      case "result": {
        if (message.clientSeq <= state.ackedUpTo || state.answered.has(message.clientSeq)) return;
        const pending = state.pending.find((p) => p.clientSeq === message.clientSeq);
        // Another machine's change under this id and number (a copied vault): repair, don't take its result.
        if (pending ? pending.changeId !== message.changeId : message.clientSeq > state.lastAssigned) {
          return this.#repair();
        }
        state.pending = state.pending.filter((p) => p.clientSeq !== message.clientSeq);
        this.#dirty = true;
        if (pending) this.#touch(pending.noteId);
        const { rev } = message;
        if (pending && message.ok && !message.conflict && rev !== undefined) {
          if ((state.remote.get(pending.noteId)?.rev ?? 0) < rev) this.#landed.push({ ...pending, rev });
        }
        // An edit made on refused text landed whole: the person fixed it, and every refused edit it grew from.
        if (pending && message.ok && !message.conflict && pending.change.kind === "put") {
          const refused = (b: Blocked) => !b.proposalId && b.change.kind !== "delete";
          const fixed = new Set([pending.change.base]);
          // Newest first: each refused edit's base is the text of the one refused before it.
          for (const b of (state.blocked.get(pending.noteId) ?? []).toReversed()) {
            if (refused(b) && b.change.kind === "put" && fixed.has(b.change.raw)) fixed.add(b.change.base);
          }
          this.#unblock(
            pending.noteId,
            (b) => refused(b) && b.change.kind !== "delete" && fixed.has(b.change.raw),
          );
        }
        // A create landed: a refused create of the same note (sent again once fixed) no longer stands.
        if (pending && message.ok && !message.conflict && pending.change.kind === "create") {
          this.#unblock(pending.noteId, (b) => !b.proposalId && b.change.kind === "create");
        }
        if (pending && (!message.ok || message.conflict)) {
          const blocked = state.blocked.get(pending.noteId) ?? [];
          state.blocked.set(pending.noteId, [
            ...blocked,
            {
              change: pending.change,
              reason: message.error ?? (message.conflict ? "conflict" : "refused"),
              ...(message.conflict && { proposalId: message.conflict.proposalId }),
              ...(message.conflict && message.rev !== undefined && { rev: message.rev }),
            },
          ]);
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
   * Under a new id, sends every pending change again, in order, exactly as it was made (same changeId,
   * same base text). The record answers a changeId it has seen with its first answer and merges only the rest.
   */
  #repair(): void {
    const { state } = this;
    const pending = state.pending;
    state.clientId = this.#options.newClientId();
    state.lastAssigned = 0;
    state.ackedUpTo = 0;
    state.answered.clear();
    state.pending = [];
    this.#welcomed = false;
    this.#dirty = true;
    // Same changeIds: the record knows which of these already landed under the old id.
    for (const p of pending) this.#queue(p.noteId, p.change, p.changeId);
    this.connect();
  }
}
