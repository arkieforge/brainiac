// The audit log (docs/internals/security.md): one row per tool call, written in the call's own transaction, naming
// the notes it showed or changed and the approval it cited. The person reads it per connection on their account
// page; no tool reads it, so an agent can't learn what another connection did.
import { getConnection, type Connection } from "./connections.ts";
import type { Sql } from "./sql.ts";

export interface AuditEntry {
  readonly actor: string;
  readonly tool: string;
  readonly noteIds: readonly string[];
  readonly approvalId?: string;
  readonly secretName?: string;
  /** The call came from a background run (the daemon's headless filer), not a session the person is in. */
  readonly background?: boolean;
  readonly at: number;
}

/** Writes one row; the caller's transaction holds it, so a call that rolls back leaves none. */
export function recordAudit(sql: Sql, entry: AuditEntry): void {
  sql.all(
    "INSERT INTO audit (at, actor, tool, noteIds, secretName, approvalId, background) VALUES (?, ?, ?, ?, ?, ?, ?)",
    entry.at,
    entry.actor,
    entry.tool,
    JSON.stringify(entry.noteIds),
    entry.secretName ?? null,
    entry.approvalId ?? null,
    entry.background ? 1 : 0,
  );
}

/** One call as the person sees it: each note by its path now, or null once it's gone. */
export interface AuditCall {
  readonly at: number;
  readonly tool: string;
  readonly notes: readonly { readonly id: string; readonly path: string | null }[];
  readonly approvalId: string | null;
  readonly secretName: string | null;
  /** A background run made it: it shares the device's connection with the person's own sessions. */
  readonly background: boolean;
}

/** How many calls the account page shows per connection. */
const AUDIT_PAGE = 50;

/** A connection's most recent calls, newest first, for the person only. */
export function auditOf(sql: Sql, connectionId: string, limit = AUDIT_PAGE): AuditCall[] {
  const rows = sql.all<{
    at: number;
    tool: string;
    noteIds: string;
    approvalId: string | null;
    secretName: string | null;
    background: number;
  }>(
    "SELECT at, tool, noteIds, approvalId, secretName, background FROM audit WHERE actor = ? ORDER BY id DESC LIMIT ?",
    `connection:${connectionId}`,
    limit,
  );
  return rows.map((row) => {
    const ids: string[] = JSON.parse(row.noteIds);
    return {
      at: row.at,
      tool: row.tool,
      notes: ids.map((id) => ({
        id,
        path:
          sql.all<{ path: string }>("SELECT path FROM notes WHERE id = ? AND deletedAt IS NULL", id)[0]
            ?.path ?? null,
      })),
      approvalId: row.approvalId,
      secretName: row.secretName,
      background: row.background === 1,
    };
  });
}

/** Every connection the record has, newest first, each with its most recent calls. */
export function activity(sql: Sql): { readonly connection: Connection; readonly calls: AuditCall[] }[] {
  return sql
    .all<{ id: string }>("SELECT id FROM connections ORDER BY createdAt DESC, id")
    .flatMap(({ id }) => {
      const connection = getConnection(sql, id);
      return connection ? [{ connection, calls: auditOf(sql, id) }] : [];
    });
}
