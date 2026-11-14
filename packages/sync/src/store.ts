import type { Sql } from "@brainiac/base";

import type { Blocked, Pending, Remote, State } from "./client.ts";

/** Everything in a client's state except the remote layer, which is written note by note. */
export interface Saved {
  readonly clientId: string;
  readonly lastAssigned: number;
  readonly ackedUpTo: number;
  readonly cursor: number | null;
  readonly answered: readonly number[];
  readonly pending: readonly Pending[];
  readonly blocked: readonly (readonly [string, readonly Blocked[]])[];
}

/** One atomic write: the whole saved part, and the remote notes that changed (null: gone). */
export interface Write {
  readonly saved: Saved;
  /** Drop every stored remote note first: a snapshot replaced them, or an earlier write failed. */
  readonly clear: boolean;
  readonly remote: readonly (readonly [string, Remote | null])[];
}

/**
 * Where a client keeps its state across restarts: IndexedDB in a browser, `.brainiac/state.db` on a laptop.
 * A write starts before the one before it has finished, so writes must land in the order they started (an
 * IndexedDB or SQLite transaction does), and `load` must see every write started before it.
 */
export interface Store {
  /** The stored state, or undefined for a client that has never written one. */
  load(): Promise<State | undefined>;
  write(write: Write): Promise<void>;
}

export const toSaved = (state: State): Saved => ({
  clientId: state.clientId,
  lastAssigned: state.lastAssigned,
  ackedUpTo: state.ackedUpTo,
  cursor: state.cursor,
  answered: [...state.answered],
  pending: [...state.pending], // a later put (IndexedDB) must not see edits queued after this write
  blocked: [...state.blocked],
});

export const fromSaved = (saved: Saved, remote: Iterable<readonly [string, Remote]>): State => ({
  clientId: saved.clientId,
  lastAssigned: saved.lastAssigned,
  ackedUpTo: saved.ackedUpTo,
  cursor: saved.cursor,
  answered: new Set(saved.answered),
  pending: [...saved.pending],
  blocked: new Map(saved.blocked.map(([noteId, list]) => [noteId, [...list]])),
  remote: new Map(remote),
});

/**
 * A store in SQLite, for the CLI and daemon (`.brainiac/state.db`, opened with the write-ahead log). The
 * saved part is one JSON row; remote notes are rows of their own, so a live change rewrites only its note.
 */
export function sqlStore(sql: Sql): Store {
  sql.transaction(() => {
    sql.all(
      "CREATE TABLE IF NOT EXISTS sync_client (id INTEGER PRIMARY KEY CHECK (id = 1), saved TEXT NOT NULL)",
    );
    sql.all(
      `CREATE TABLE IF NOT EXISTS sync_remote (
        noteId TEXT PRIMARY KEY, rev INTEGER NOT NULL, path TEXT NOT NULL, raw TEXT NOT NULL, class TEXT NOT NULL
      ) WITHOUT ROWID`,
    );
  });
  return {
    async load() {
      return sql.transaction(() => {
        const [row] = sql.all<{ saved: string }>("SELECT saved FROM sync_client");
        if (!row) return undefined;
        const notes = sql.all<Remote & { noteId: string }>("SELECT * FROM sync_remote");
        return fromSaved(
          JSON.parse(row.saved),
          notes.map(({ noteId, ...note }) => [noteId, note]),
        );
      });
    },
    async write({ saved, clear, remote }) {
      sql.transaction(() => {
        sql.all(
          "INSERT INTO sync_client (id, saved) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET saved = excluded.saved",
          JSON.stringify(saved),
        );
        if (clear) sql.all("DELETE FROM sync_remote");
        for (const [noteId, note] of remote) {
          if (!note) sql.all("DELETE FROM sync_remote WHERE noteId = ?", noteId);
          else
            sql.all(
              "INSERT OR REPLACE INTO sync_remote (noteId, rev, path, raw, class) VALUES (?, ?, ?, ?, ?)",
              noteId,
              note.rev,
              note.path,
              note.raw,
              note.class,
            );
        }
      });
    },
  };
}
