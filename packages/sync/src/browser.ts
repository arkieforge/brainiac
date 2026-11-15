// Its own entry point (`@brainiac/sync/browser`), so the Worker and the CLI never type-check against the DOM.
import type { Remote } from "./client.ts";
import { fromSaved, type Saved, type Store } from "./store.ts";

const opened = (request: IDBOpenDBRequest) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

const committed = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("abort", () => reject(tx.error ?? new Error("IndexedDB write aborted.")));
  });

/**
 * A store in the IndexedDB database `name`: the saved part under one key, each remote note under its id. `close`
 * ends its connection, which an open one would hold against deleting the database (sign-out does that).
 */
export function indexedDbStore(name: string): Store & { readonly close: () => Promise<void> } {
  const opening = indexedDB.open(name, 1);
  opening.addEventListener("upgradeneeded", () => {
    opening.result.createObjectStore("client");
    opening.result.createObjectStore("remote");
  });
  const db = opened(opening);
  return {
    async load() {
      const tx = (await db).transaction(["client", "remote"], "readonly");
      const saved = tx.objectStore("client").get("saved");
      const ids = tx.objectStore("remote").getAllKeys();
      const notes = tx.objectStore("remote").getAll();
      await committed(tx);
      const value: Saved | undefined = saved.result;
      if (!value) return undefined;
      const remote: Remote[] = notes.result;
      return fromSaved(
        value,
        remote.map((note, i) => [String(ids.result[i]), note]),
      );
    },
    async write({ saved, clear, remote }) {
      // Pending edits are the person's work, so the write is flushed to disk before it counts as done.
      const tx = (await db).transaction(["client", "remote"], "readwrite", { durability: "strict" });
      tx.objectStore("client").put(saved, "saved");
      const notes = tx.objectStore("remote");
      if (clear) notes.clear();
      for (const [noteId, note] of remote) {
        if (note) notes.put(note, noteId);
        else notes.delete(noteId);
      }
      await committed(tx);
    },
    async close() {
      (await db).close();
    },
  };
}

/**
 * Opens this tab's store; `release` closes it and frees the slot. Every tab is its own client with its own queue, so a tab holds its slot with a Web
 * Lock while it is open; a closed tab's slot, pending edits and all, goes to the next tab that opens.
 * shortcut: a closed tab's queue waits for the next tab to open; adopt free slots into a running tab's queue
 * (as repair does, by changeId) if people lose edits by closing one of two tabs and keeping the other.
 */
export async function openTabStore(
  prefix: string,
  locks: LockManager = navigator.locks,
): Promise<{ readonly store: Store; readonly release: () => Promise<void> }> {
  for (let slot = 0; ; slot++) {
    const name = `${prefix}:${slot}`;
    const unlock = await hold(locks, name);
    if (!unlock) continue;
    const store = indexedDbStore(name);
    // Closing the tab's connection first, so a sign-out deleting the database isn't blocked by it.
    const release = async () => {
      await store.close();
      await unlock();
    };
    return { store, release };
  }
}

/** Takes the lock `name` if it is free, and keeps it until the returned function is called. */
function hold(locks: LockManager, name: string): Promise<(() => Promise<void>) | undefined> {
  return new Promise((resolve, reject) => {
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const request = locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) return resolve(undefined);
      // Settles once the lock is free again, so the next tab can take the slot.
      resolve(async () => {
        release();
        await request;
      });
      return released;
    });
    request.catch(reject);
  });
}
