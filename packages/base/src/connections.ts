// Connections (contract §3): each agent or CLI reaches the record through one, with a level, the sensitive scope
// and a hold window. Connecting gives the floor (propose, no sensitive notes, a 3-day hold); anything looser
// needs the person's passkey over the exact grant (contract §4). Tightening never does.
import { createHash, randomBytes } from "node:crypto";

import { ulid } from "@brainiac/core";

import { advance, canonical, type Signature } from "./approvals.ts";
import { DAY_MS } from "./hold.ts";
import type { NoteRow } from "./notes.ts";
import { PERSON, project, type Principal } from "./project.ts";
import type { Sql } from "./sql.ts";

export type Level = "read" | "propose" | "write";
const LEVELS: readonly Level[] = ["read", "propose", "write"];

/** The default hold window (contract §3; the owner's call in #47). */
export const HOLD_DAYS = 3;
const MAX_HOLD_DAYS = 365;

export interface Connection {
  readonly id: string;
  /** `connector`: a built-in connector acting at the floor (github.ts); never stored, so never granted more. */
  readonly kind: "oauth" | "cli" | "connector";
  /** The MCP client's metadata URL; null for a CLI connection. */
  readonly oauthClientId: string | null;
  readonly level: Level;
  /** Whether it may see sensitive notes. Off until the person grants it. */
  readonly sensitive: boolean;
  /** Days a write-level change to an existing held value waits; 0 applies it at once. */
  readonly holdDays: number;
  /** Bumped by every change to its grants; a grant signature names the `rev` it was signed at. */
  readonly rev: number;
  readonly createdAt: number;
}

interface ConnectionRow extends Omit<Connection, "sensitive"> {
  readonly sensitive: number;
}

const fromRow = (row: ConnectionRow): Connection => ({
  id: row.id,
  kind: row.kind,
  oauthClientId: row.oauthClientId,
  level: row.level,
  sensitive: row.sensitive === 1,
  holdDays: row.holdDays,
  rev: row.rev,
  createdAt: row.createdAt,
});

const COLUMNS = "id, kind, oauthClientId, level, sensitive, holdDays, rev, createdAt";

export function getConnection(sql: Sql, id: string): Connection | undefined {
  const [row] = sql.all<ConnectionRow>(`SELECT ${COLUMNS} FROM connections WHERE id = ?`, id);
  return row && fromRow(row);
}

/** An MCP client's connection, if it has one: the way to end it when the person disconnects the app. */
export function oauthConnection(sql: Sql, oauthClientId: string): Connection | undefined {
  const [row] = sql.all<ConnectionRow>(
    `SELECT ${COLUMNS} FROM connections WHERE oauthClientId = ?`,
    oauthClientId,
  );
  return row && fromRow(row);
}

/** The connection a change's actor names (`connection:<id>`), if it still exists. */
export const connectionOf = (sql: Sql, actor: string): Connection | undefined =>
  actor.startsWith("connection:") ? getConnection(sql, actor.slice("connection:".length)) : undefined;

/** What a connection may read, for `project`. The person (no connection) reads everything. */
export const principalOf = (connection: Connection | undefined): Principal =>
  connection === undefined ? PERSON : { sensitive: connection.sensitive };

/**
 * A connection as a background run uses it, with nobody there (docs/internals/security.md, "Filer access"): at
 * most propose, so every change it makes waits for the person, and never the sensitive scope. A client asks for
 * this itself with `BACKGROUND_HEADER` on `/mcp`, which is safe to trust because it only ever narrows.
 */
export const inBackground = (connection: Connection): Connection => ({
  ...connection,
  level: connection.level === "read" ? "read" : "propose",
  sensitive: false,
});

/** Sent as `1` by `brainiac mcp serve --background`, the bridge the daemon's headless filer runs. */
export const BACKGROUND_HEADER = "brainiac-background";

/** Whether `connection` may see `note`: `project`, the one read check, for a connection. */
export const canSee = (connection: Connection | undefined, note: Pick<NoteRow, "class" | "type">): boolean =>
  project(note, principalOf(connection)) !== undefined;

/**
 * A new connection at the floor: propose, no sensitive notes, the default hold. An MCP client that connects again
 * gets its existing connection back, grants and all.
 */
export function connect(
  sql: Sql,
  input: { readonly kind: "cli" } | { readonly kind: "oauth"; readonly oauthClientId: string },
  now: number,
): Connection {
  return sql.transaction(() => {
    const oauthClientId = input.kind === "oauth" ? input.oauthClientId : null;
    if (oauthClientId !== null) {
      const [row] = sql.all<ConnectionRow>(
        `SELECT ${COLUMNS} FROM connections WHERE oauthClientId = ?`,
        oauthClientId,
      );
      if (row) return fromRow(row);
    }
    const id = randomBytes(16).toString("base64url");
    sql.all(
      `INSERT INTO connections (id, kind, oauthClientId, level, scopes, sensitive, holdDays, createdAt)
       VALUES (?, ?, ?, 'propose', '[]', 0, ?, ?)`,
      id,
      input.kind,
      oauthClientId,
      HOLD_DAYS,
      now,
    );
    const connection = getConnection(sql, id);
    if (!connection) throw new Error("INSERT into connections stored no row");
    return connection;
  });
}

/** Ends a connection and every token it has. Its open proposals stay for the person, and no longer apply on their own. */
export function disconnect(sql: Sql, id: string): void {
  sql.transaction(() => {
    sql.all("DELETE FROM tokens WHERE connectionId = ?", id);
    sql.all("DELETE FROM connections WHERE id = ?", id);
  });
}

// A CLI token names its record, so the Worker can route it without a lookup: `brn_<base id>_<secret>`. The record
// keeps only a hash of the whole token, so a token naming another record's id matches nothing there.
const TOKEN = /^brn_([0-9a-f]{1,128})_([\w-]{43})$/;

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** The record a CLI token names, for routing only (`/sync`, `/cli/logout`): the record itself decides whether the token is good. */
export const tokenBase = (token: string): string | undefined => TOKEN.exec(token)?.[1];

/** A new token for a CLI connection of the record `baseId`. Shown once; the record keeps only its hash. */
export function mintToken(sql: Sql, baseId: string, connectionId: string, now: number): string {
  const connection = getConnection(sql, connectionId);
  if (connection?.kind !== "cli") throw new Error("Only a CLI connection has tokens.");
  if (!/^[0-9a-f]{1,128}$/.test(baseId)) throw new Error(`Not a record id: ${baseId}`);
  const token = `brn_${baseId}_${randomBytes(32).toString("base64url")}`;
  sql.all(
    "INSERT INTO tokens (id, connectionId, hash) VALUES (?, ?, ?)",
    ulid(now),
    connectionId,
    tokenHash(token),
  );
  return token;
}

/** The connection a CLI token belongs to, if the token is this record's, unrevoked and unexpired. */
export function authenticate(sql: Sql, token: string, now: number): Connection | undefined {
  if (!TOKEN.test(token)) return undefined;
  const [row] = sql.all<ConnectionRow>(
    `SELECT ${COLUMNS.split(", ")
      .map((column) => `connections.${column}`)
      .join(", ")}
     FROM tokens JOIN connections ON connections.id = tokens.connectionId
     WHERE tokens.hash = ? AND tokens.revokedAt IS NULL AND (tokens.expiresAt IS NULL OR tokens.expiresAt > ?)`,
    tokenHash(token),
    now,
  );
  return row && fromRow(row);
}

/** The grants a connection would have, and the `rev` they were decided at: what the person's passkey signs. */
export interface GrantPlan {
  readonly connectionId: string;
  readonly rev: number;
  readonly level: Level;
  readonly sensitive: boolean;
  readonly holdDays: number;
}

/**
 * The WebAuthn challenge for a grant: exactly the plan's fields, whatever else the object carries. Tagged, so it
 * can never equal a note plan's hash.
 */
export const grantHash = ({ connectionId, rev, level, sensitive, holdDays }: GrantPlan): string =>
  createHash("sha256")
    .update(canonical({ grant: { connectionId, rev, level, sensitive, holdDays } }))
    .digest("base64url");

export type Granted = { readonly connection: Connection } | { readonly error: string };

function invalidGrant(plan: Omit<GrantPlan, "connectionId" | "rev">): string | undefined {
  if (!LEVELS.includes(plan.level)) return `level must be one of ${LEVELS.join(", ")}.`;
  if (typeof plan.sensitive !== "boolean") return "sensitive must be true or false.";
  if (!Number.isInteger(plan.holdDays) || plan.holdDays < 0 || plan.holdDays > MAX_HOLD_DAYS)
    return `holdDays must be a whole number from 0 to ${MAX_HOLD_DAYS}.`;
  return undefined;
}

/**
 * Sets a connection's grants, and what that means for its waiting held changes: below write they no longer apply
 * on their own (the person decides them), and a longer hold pushes them back by the added days.
 */
function setGrants(sql: Sql, id: string, grants: Omit<GrantPlan, "connectionId" | "rev">): Connection {
  const before = getConnection(sql, id);
  if (!before) throw new Error(`no connection ${id}`);
  sql.all(
    `UPDATE proposals SET autoApplyAt = CASE WHEN ? THEN NULL ELSE autoApplyAt + ? END
     WHERE actor = ? AND status = 'open' AND autoApplyAt IS NOT NULL`,
    grants.level === "write" ? 0 : 1,
    Math.max(0, grants.holdDays - before.holdDays) * DAY_MS,
    `connection:${id}`,
  );
  sql.all(
    "UPDATE connections SET level = ?, sensitive = ?, holdDays = ?, rev = rev + 1 WHERE id = ?",
    grants.level,
    grants.sensitive ? 1 : 0,
    grants.holdDays,
    id,
  );
  const connection = getConnection(sql, id);
  if (!connection) throw new Error(`connection ${id} vanished inside its own transaction`);
  return connection;
}

/**
 * Applies grants the person signed (`grantHash(plan)`, checked by the DO). Refused if the connection changed
 * since the plan was made, or if the passkey signature was used before.
 */
export function grant(sql: Sql, plan: GrantPlan, signature: Signature): Granted {
  return sql.transaction((): Granted => {
    const connection = getConnection(sql, plan.connectionId);
    if (!connection) return { error: "That connection is gone." };
    if (connection.rev !== plan.rev)
      return { error: "This connection changed since you signed. Sign again." };
    const invalid = invalidGrant(plan);
    if (invalid !== undefined) return { error: invalid };
    if (!advance(sql, signature)) return { error: "This passkey signature was already used." };
    return { connection: setGrants(sql, connection.id, plan) };
  });
}

/** Tightens a connection: a lower level, no sensitive scope, a longer hold. Anything looser needs `grant`. */
export function restrict(
  sql: Sql,
  id: string,
  change: Partial<Pick<GrantPlan, "level" | "sensitive" | "holdDays">>,
): Granted {
  return sql.transaction((): Granted => {
    const connection = getConnection(sql, id);
    if (!connection) return { error: "That connection is gone." };
    const next = {
      level: change.level ?? connection.level,
      sensitive: change.sensitive ?? connection.sensitive,
      holdDays: change.holdDays ?? connection.holdDays,
    };
    const invalid = invalidGrant(next);
    if (invalid !== undefined) return { error: invalid };
    const looser =
      LEVELS.indexOf(next.level) > LEVELS.indexOf(connection.level) ||
      (next.sensitive && !connection.sensitive) ||
      next.holdDays < connection.holdDays;
    if (looser) return { error: "Loosening a connection needs your passkey." };
    return { connection: setGrants(sql, id, next) };
  });
}
