// Answers MCP reads from the vault's local copy while the record can't be reached (`brainiac mcp serve`). The copy
// is the sync client's remote layer in state.db: each note as the record last sent it, with its rev, so a rev
// read offline is one `update` takes online, and a search offline finds what the record's keywords would. It is
// not index.db, which indexes the files as they are now, edits the record hasn't taken included. It runs `callTool` from packages/base as the connection the daemon
// last synced with, and only for that connection's token: a narrower token gets nothing from a wider copy.
// Everything here comes from the vault folder, so it is input: none of it shows more than the files beside it.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { bunSql } from "@brainiac/base/bun";
import {
  callTool,
  chunkNote,
  getNote,
  migrate,
  putChunks,
  putNote,
  type Answer,
  type Connection,
  type Sql,
} from "@brainiac/base";
import { NoteParseError } from "@brainiac/core";

import { META, refuseSymlinks, type Access } from "./state.ts";

/** What state.db keeps to say which token the copy was synced with, without keeping the token. */
export const tokenKey = (token: string) =>
  createHash("sha256").update(`brainiac-token:${token}`).digest("hex");

export interface LocalCopyOptions {
  /** The vault folder, if this computer keeps one. */
  readonly vault: string | undefined;
  readonly deviceId: string;
  /** The token the caller holds; the copy answers only if the daemon synced with it. */
  readonly token: string;
  readonly keepSensitive: boolean;
  /** Nobody is there (the daemon's filer): narrowed as the record narrows it. */
  readonly background?: boolean;
  readonly now?: () => number;
}

interface Loaded {
  readonly sql: Sql;
  readonly db: Database;
  readonly access: Access;
  readonly syncedAt: number;
}

const unreachable = "Your Brainiac record can't be reached";

/** The copy as of state.db now, in memory in the record's schema, or why it can't answer for `options`. */
function load(state: Database, options: LocalCopyOptions): Loaded | string {
  const meta = (key: string) =>
    state.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value;
  if (meta(META.owner) !== options.deviceId)
    return `${unreachable}, and the vault's copy is another computer's, so it can't answer for this one. Nothing was read or changed.`;
  const saved = meta(META.access);
  const access: Access | undefined = saved === undefined ? undefined : JSON.parse(saved);
  const syncedAt = Number(meta(META.syncedAt));
  if (access?.token !== tokenKey(options.token) || !Number.isFinite(syncedAt))
    return `${unreachable}, and this laptop's copy hasn't synced as this connection yet, so it can't answer for it. Nothing was read or changed.`;
  const db = new Database(":memory:", { strict: true });
  const sql = bunSql(db);
  migrate(sql);
  const remote = state
    .query<{ noteId: string; rev: number; path: string; raw: string; class: "normal" | "sensitive" }, []>(
      "SELECT noteId, rev, path, raw, class FROM sync_remote",
    )
    .all();
  sql.transaction(() => {
    if (access.manifest !== null)
      sql.all("INSERT INTO schema (version, manifest) VALUES (1, ?)", access.manifest);
    for (const { noteId: id, path, raw, rev, class: cls } of remote) {
      const hash = createHash("sha256").update(raw).digest("hex");
      try {
        putNote(sql, { id, path, raw, rev, seq: 0, hash, class: cls });
        // Chunked from the text the record sent, as the record chunks it, so offline search ranks as its keywords do.
        putChunks(sql, id, rev, chunkNote(getNote(sql, id)!));
      } catch (error) {
        if (!(error instanceof NoteParseError)) throw error;
      }
    }
  });
  return { sql, db, access, syncedAt };
}

/**
 * The vault's local copy, opened on the first call. Each call sees what the daemon last stored: the copy is
 * rebuilt in memory whenever state.db changed since the call before.
 */
export function localCopy(options: LocalCopyOptions) {
  const file = options.vault && join(options.vault, ".brainiac", "state.db");
  let state: Database | undefined;
  let seen = -1;
  let copy: Loaded | string | undefined;

  const answer = (path: string, name: string, args: unknown): Answer => {
    if (!state) {
      refuseSymlinks(path);
      state = new Database(path, { readonly: true, strict: true });
    }
    // Moves whenever another connection (the daemon) commits to state.db.
    const version = state.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version;
    if (copy === undefined || version !== seen) {
      if (typeof copy === "object") copy.db.close();
      copy = load(state, options);
      seen = version ?? -1;
    }
    if (typeof copy === "string") return { ok: false, error: copy };
    const connection: Connection = {
      id: "local",
      kind: "cli",
      oauthClientId: null,
      ...copy.access.grants,
      rev: 0,
      createdAt: 0,
    };
    return callTool(copy.sql, name, args, {
      actor: `connection:${connection.id}`,
      connection,
      now: (options.now ?? Date.now)(),
      offline: { syncedAt: copy.syncedAt, holdsSensitive: options.keepSensitive },
      ...(options.background && { background: true }),
    });
  };

  return {
    call(name: string, args: unknown): Answer {
      if (!file || !existsSync(file))
        return {
          ok: false,
          error: `${unreachable}, and this computer keeps no local copy to answer from. Nothing was read or changed.`,
        };
      try {
        return answer(file, name, args);
      } catch (error) {
        console.error("brainiac: the local copy couldn't answer:", error);
        return {
          ok: false,
          error: `${unreachable}, and this laptop's copy couldn't be read. Nothing was changed.`,
        };
      }
    },
    close(): void {
      if (typeof copy === "object") copy.db.close();
      state?.close();
    },
  };
}
