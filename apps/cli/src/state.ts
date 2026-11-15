// `.brainiac/state.db`: the local copy's authoritative state, on SQLite's write-ahead log. It holds the sync
// client's layers (pending changes with their base text), what the daemon last wrote or read in each file,
// every version a sync write took off disk (7 days, for `brainiac restore`), the owning device and any pause.
import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";

import { bunSql } from "@brainiac/base/bun";
import type { Sql } from "@brainiac/base";
import { isUlid } from "@brainiac/core";
import { sqlStore, type Store } from "@brainiac/sync";

/** Versions a sync write displaced are kept this long. */
export const DISPLACED_MS = 7 * 24 * 60 * 60_000;

/** A file as the daemon last wrote or read it: the note it holds and its text, the base of the next save. */
export interface Known {
  readonly path: string;
  readonly noteId: string;
  readonly text: string;
}

export interface Displaced {
  readonly id: number;
  readonly path: string;
  readonly text: string;
  readonly at: number;
  /** The note whose file it was, so its history follows the note (a move, a delete, turning sensitive). */
  readonly noteId: string | null;
  /** The name of the displaced file kept aside until late writes into it are ruled out; null once checked. */
  readonly file: string | null;
}

/** Why the daemon stopped taking changes from disk; it waits for `brainiac resume`. */
export interface Pause {
  readonly reason: string;
  readonly at: number;
}

export interface State {
  readonly sql: Sql;
  readonly store: Store;
  known(path: string): Known | undefined;
  /** Where the note's file is on this disk, if it has one. */
  pathOf(noteId: string): string | undefined;
  allKnown(): Known[];
  /** How many files the daemon knows, cheaply (for the mass-change rule). */
  knownCount(): number;
  setKnown(known: Known): void;
  forget(path: string): void;
  displace(path: string, text: string, now: number, noteId?: string, file?: string): void;
  /** The file's versions, and the note's from before a move or from a crash (`noteId`), newest first. */
  displaced(path: string, now: number, noteId?: string): Displaced[];
  /** Displaced versions whose file is still kept aside, oldest first. */
  asides(): Displaced[];
  /** The kept-aside file has been checked and removed. */
  checked(id: number): void;
  /** Forgets one displaced version outright (a sensitive note's, once its short watch is over). */
  drop(id: number): void;
  /** Forgets every displaced version of the note or the file (it became sensitive); returns their kept files. */
  purgeDisplaced(path: string, noteId: string, except?: readonly number[]): string[];
  /** The device whose pending queue this is; another device's copy of the vault must not replay it. */
  owner(): string | undefined;
  setOwner(deviceId: string): void;
  pause(): Pause | undefined;
  setPause(pause: Pause | undefined): void;
  /** Forgets the sync layers and every known file, keeping displaced versions: a copied vault starts over. */
  reset(): void;
  close(): void;
}

/**
 * Refuses a database (or its write-ahead log) that is a symlink: SQLite would write wherever it leads. These
 * files sit in the vault, so anyone who can write the vault could have put one there.
 */
export function refuseSymlinks(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    let link = false;
    try {
      link = lstatSync(`${path}${suffix}`).isSymbolicLink();
    } catch {}
    if (link) throw new Error(`${path}${suffix} is a symlink; Brainiac won't open it.`);
  }
}

/**
 * Opens state.db. It sits in the vault, so its paths are input like any other: with `safe`, rows whose path
 * fails it (outside the vault, a hidden file) are never handed out, so nothing reads or writes through them.
 */
export function openState(path: string, safePath: (path: string) => boolean = () => true): State {
  refuseSymlinks(path);
  const safe = (p: string, noteId = "") => safePath(p) && (noteId === "" || isUlid(noteId));
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA secure_delete = ON"); // a purged sensitive note's text is overwritten, not left in free pages
  const sql = bunSql(db);
  sql.transaction(() => {
    sql.all(
      "CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, noteId TEXT NOT NULL, text TEXT NOT NULL)",
    );
    sql.all("CREATE INDEX IF NOT EXISTS files_note ON files (noteId)");
    sql.all(
      "CREATE TABLE IF NOT EXISTS displaced (id INTEGER PRIMARY KEY, path TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, noteId TEXT, file TEXT)",
    );
    sql.all("CREATE INDEX IF NOT EXISTS displaced_path ON displaced (path, at)");
    sql.all("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  });
  const store = sqlStore(sql);
  const meta = (key: string) =>
    sql.all<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)[0]?.value;
  const setMeta = (key: string, value: string | undefined) =>
    void (value === undefined
      ? sql.all("DELETE FROM meta WHERE key = ?", key)
      : sql.all("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value));
  return {
    sql,
    store,
    known: (p) => {
      const row = safe(p) ? sql.all<Known>("SELECT * FROM files WHERE path = ?", p)[0] : undefined;
      return row && safe(row.path, row.noteId) ? row : undefined;
    },
    pathOf: (noteId) =>
      sql
        .all<{ path: string }>("SELECT path FROM files WHERE noteId = ?", noteId)
        .find((row) => safe(row.path))?.path,
    allKnown: () =>
      sql.all<Known>("SELECT * FROM files ORDER BY path").filter((row) => safe(row.path, row.noteId)),
    knownCount: () => sql.all<{ n: number }>("SELECT count(*) AS n FROM files")[0]?.n ?? 0,
    setKnown: ({ path: p, noteId, text }) =>
      void sql.all("INSERT OR REPLACE INTO files (path, noteId, text) VALUES (?, ?, ?)", p, noteId, text),
    forget: (p) => void sql.all("DELETE FROM files WHERE path = ?", p),
    displace(p, text, now, noteId, file) {
      sql.transaction(() => {
        sql.all("DELETE FROM displaced WHERE at <= ? AND file IS NULL", now - DISPLACED_MS);
        sql.all(
          "INSERT INTO displaced (path, text, at, noteId, file) VALUES (?, ?, ?, ?, ?)",
          p,
          text,
          now,
          noteId ?? null,
          file ?? null,
        );
      });
    },
    asides: () => sql.all<Displaced>("SELECT * FROM displaced WHERE file IS NOT NULL ORDER BY id"),
    checked: (id) => void sql.all("UPDATE displaced SET file = NULL WHERE id = ?", id),
    drop: (id) => void sql.all("DELETE FROM displaced WHERE id = ?", id),
    purgeDisplaced: (p, noteId, except = []) =>
      sql
        .all<{ file: string | null }>(
          "DELETE FROM displaced WHERE (path = ? OR noteId = ?) AND id NOT IN (SELECT value FROM json_each(?)) RETURNING file",
          p,
          noteId,
          JSON.stringify(except),
        )
        .flatMap((row) => (row.file ? [row.file] : [])),
    displaced: (p, now, noteId) =>
      sql.all<Displaced>(
        "SELECT * FROM displaced WHERE (path = ? OR noteId = ?) AND at > ? ORDER BY at DESC, id DESC",
        p,
        noteId ?? null,
        now - DISPLACED_MS,
      ),
    owner: () => meta("owner"),
    setOwner: (deviceId) => setMeta("owner", deviceId),
    pause() {
      const value = meta("pause");
      return value === undefined ? undefined : (JSON.parse(value) as Pause);
    },
    setPause: (pause) => setMeta("pause", pause && JSON.stringify(pause)),
    reset() {
      sql.transaction(() => {
        for (const table of ["sync_client", "sync_remote", "files"]) sql.all(`DELETE FROM ${table}`);
        sql.all("UPDATE displaced SET file = NULL"); // a copied vault's kept files are never read here
      });
    },
    close: () => db.close(),
  };
}
