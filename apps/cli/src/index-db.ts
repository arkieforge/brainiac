// `.brainiac/index.db`: the local copy's search index, in the record's own schema (packages/base), so local
// answers run the same queries as the cloud. Derived from the files, so it is never repaired, only rebuilt.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";

import { bunSql } from "@brainiac/base/bun";
import {
  chunkNote,
  CHUNKS,
  getNote,
  migrate,
  putChunks,
  putNote,
  type NoteClass,
  type Sql,
} from "@brainiac/base";
import { NoteParseError } from "@brainiac/core";

import { refuseSymlinks } from "./state.ts";

export interface Index {
  readonly sql: Sql;
  put(note: {
    readonly id: string;
    readonly path: string;
    readonly raw: string;
    readonly class: NoteClass;
  }): void;
  drop(id: string): void;
  /** Records that every file is indexed with this release's chunking, after a fresh index is filled. */
  built(): void;
  close(): void;
}

function open(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA secure_delete = ON");
    const [check] = db.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
    if (check?.quick_check !== "ok") throw new Error(`index check: ${check?.quick_check}`);
    migrate(bunSql(db));
    // A dropped note's text is overwritten in the full-text index too, not left in its old segments.
    for (const table of ["chunks_fts_normal", "chunks_fts_sensitive"]) {
      db.run(`INSERT INTO ${table} (${table}, rank) VALUES ('secure-delete', 1)`);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Opens the index at `path`. One that is missing, or fails its integrity check or its migration, is made again
 * empty; `fresh` is then true and the caller re-indexes every file. So it is when the index was built with
 * another chunking (`CHUNKS`), so local keyword search finds what the cloud's does; it holds no vectors.
 */
export function openIndex(path: string): { readonly index: Index; readonly fresh: boolean } {
  // Derived, so a symlink in its place (SQLite would write where it leads) is just removed, the link itself.
  try {
    refuseSymlinks(path);
  } catch {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${path}${suffix}`, { force: true });
  }
  let db: Database;
  let fresh = !existsSync(path);
  try {
    db = open(path);
  } catch {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    db = open(path);
    fresh = true;
  }
  const sql = bunSql(db);
  // Recorded only once a rebuild is done (`built`), so one cut short starts over.
  const [built] = sql.all<{ value: string }>("SELECT value FROM meta WHERE key = 'chunks'");
  if (built?.value !== CHUNKS) fresh = true;
  return {
    fresh,
    index: {
      sql,
      put({ id, path: notePath, raw, class: cls }) {
        const hash = createHash("sha256").update(raw).digest("hex");
        try {
          sql.transaction(() => {
            putNote(sql, { id, path: notePath, raw, rev: 0, seq: 0, hash, class: cls });
            putChunks(sql, id, 0, chunkNote(getNote(sql, id)!));
          });
        } catch (error) {
          // Front-matter that doesn't parse keeps its last good entry; the record says what is wrong with it.
          if (!(error instanceof NoteParseError)) throw error;
        }
      },
      drop(id) {
        sql.transaction(() => {
          putChunks(sql, id, 0, []);
          sql.all("DELETE FROM notes WHERE id = ?", id);
        });
        try {
          sql.all("PRAGMA wal_checkpoint(TRUNCATE)"); // and out of the write-ahead log
        } catch {} // a reader holds it: the next drop or close clears it
      },
      built() {
        sql.all(
          "INSERT INTO meta (key, value) VALUES ('chunks', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          CHUNKS,
        );
      },
      close: () => db.close(),
    },
  };
}
