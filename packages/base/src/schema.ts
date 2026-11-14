import type { Sql } from "./sql.ts";

/**
 * Every migration, in order; migration `i` takes a record from version `i` to `i + 1`. Version 0 is the
 * shape before this package: only the `meta` table.
 *
 * Migrations are additive for one release (new tables, new columns, new indexes), so the previous Worker
 * still runs on a record the new one has migrated, and a rollback never needs a down migration. Removing
 * or renaming anything waits until no deployed code reads it. Never edit a migration that has shipped:
 * append a new one.
 *
 * Column names are camelCase, so rows read as TypeScript objects without a mapping layer.
 */
const MIGRATIONS: readonly (readonly string[])[] = [
  [
    // Notes are stored as raw text; `fm` is the front-matter parsed from it, as JSON. `type` and the hot
    // fields queries filter and sort on are generated from `fm`, so they can never disagree with the text.
    `CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      raw TEXT NOT NULL,
      fm TEXT NOT NULL,
      rev INTEGER NOT NULL,
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL,
      class TEXT NOT NULL CHECK (class IN ('normal', 'sensitive')),
      deletedAt INTEGER,
      type TEXT GENERATED ALWAYS AS (fm ->> '$.type') VIRTUAL,
      title TEXT GENERATED ALWAYS AS (fm ->> '$.title') VIRTUAL,
      kind TEXT GENERATED ALWAYS AS (fm ->> '$.kind') VIRTUAL,
      status TEXT GENERATED ALWAYS AS (fm ->> '$.status') VIRTUAL,
      date TEXT GENERATED ALWAYS AS (fm ->> '$.date') VIRTUAL,
      deadline TEXT GENERATED ALWAYS AS (fm ->> '$.deadline') VIRTUAL,
      expires TEXT GENERATED ALWAYS AS (fm ->> '$.expires') VIRTUAL
    )`,
    // A tombstone keeps its path, so a new note may take it.
    "CREATE UNIQUE INDEX notes_path ON notes (path) WHERE deletedAt IS NULL",
    "CREATE INDEX notes_type_date ON notes (type, date)",
    "CREATE INDEX notes_status ON notes (status) WHERE status IS NOT NULL",
    "CREATE INDEX notes_deadline ON notes (deadline) WHERE deadline IS NOT NULL",
    "CREATE INDEX notes_expires ON notes (expires) WHERE expires IS NOT NULL",
    "CREATE INDEX notes_seq ON notes (seq)",

    // `patch` is the inverse patch that undoes this revision.
    `CREATE TABLE revisions (
      noteId TEXT NOT NULL,
      rev INTEGER NOT NULL,
      raw TEXT NOT NULL,
      patch TEXT NOT NULL,
      actor TEXT NOT NULL,
      runId TEXT,
      at INTEGER NOT NULL,
      PRIMARY KEY (noteId, rev)
    ) WITHOUT ROWID`,
    "CREATE INDEX revisions_run ON revisions (runId) WHERE runId IS NOT NULL",

    `CREATE TABLE changes (
      seq INTEGER PRIMARY KEY,
      noteId TEXT NOT NULL,
      rev INTEGER NOT NULL,
      op TEXT NOT NULL,
      actor TEXT NOT NULL,
      at INTEGER NOT NULL
    )`,
    "CREATE INDEX changes_at ON changes (at)",

    `CREATE TABLE clients (
      clientId TEXT PRIMARY KEY,
      highWater INTEGER NOT NULL DEFAULT 0,
      lastHash TEXT,
      lastSeenAt INTEGER,
      appVersion TEXT
    )`,
    `CREATE TABLE results (
      clientId TEXT NOT NULL,
      clientSeq INTEGER NOT NULL,
      digest TEXT NOT NULL,
      result TEXT NOT NULL,
      PRIMARY KEY (clientId, clientSeq)
    ) WITHOUT ROWID`,

    `CREATE TABLE proposals (
      id TEXT PRIMARY KEY,
      noteId TEXT,
      patch TEXT NOT NULL,
      actor TEXT NOT NULL,
      autoApplyAt INTEGER,
      status TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('change', 'conflict', 'schema'))
    )`,
    "CREATE INDEX proposals_note ON proposals (noteId) WHERE noteId IS NOT NULL",
    "CREATE INDEX proposals_due ON proposals (autoApplyAt) WHERE autoApplyAt IS NOT NULL",

    `CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      planHash TEXT NOT NULL,
      items TEXT NOT NULL,
      assertion TEXT NOT NULL,
      credentialId TEXT NOT NULL,
      at INTEGER NOT NULL,
      usedAt INTEGER
    )`,
    `CREATE TABLE review_runs (
      nonce TEXT PRIMARY KEY,
      items TEXT NOT NULL,
      assertion TEXT NOT NULL,
      credentialId TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    )`,
    `CREATE TABLE passkey_keys (
      credentialId TEXT PRIMARY KEY,
      publicKey BLOB NOT NULL,
      counter INTEGER NOT NULL
    )`,

    `CREATE TABLE connections (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('oauth', 'cli')),
      oauthClientId TEXT,
      level TEXT NOT NULL CHECK (level IN ('read', 'propose', 'write')),
      scopes TEXT NOT NULL,
      sensitive INTEGER NOT NULL DEFAULT 0,
      holdDays INTEGER NOT NULL DEFAULT 3,
      createdAt INTEGER NOT NULL
    )`,
    `CREATE TABLE tokens (
      id TEXT PRIMARY KEY,
      connectionId TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      expiresAt INTEGER,
      revokedAt INTEGER
    )`,

    `CREATE TABLE inbox_leases (
      itemId TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    )`,
    `CREATE TABLE questions (
      id TEXT PRIMARY KEY,
      noteId TEXT,
      field TEXT,
      input TEXT NOT NULL,
      suggested TEXT,
      why TEXT NOT NULL,
      priority INTEGER NOT NULL,
      status TEXT NOT NULL,
      class TEXT NOT NULL CHECK (class IN ('normal', 'sensitive'))
    )`,
    `CREATE TABLE checks (
      id TEXT PRIMARY KEY,
      noteId TEXT NOT NULL,
      field TEXT,
      detector TEXT NOT NULL,
      evidence TEXT NOT NULL,
      suggestion TEXT NOT NULL,
      status TEXT NOT NULL
    )`,
    "CREATE INDEX checks_note ON checks (noteId)",

    // The transactional outbox: written in the mutation's transaction, dispatched by the alarm.
    `CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      noteId TEXT NOT NULL,
      rev INTEGER NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      dispatchedAt INTEGER
    )`,
    "CREATE INDEX jobs_status ON jobs (status)",

    `CREATE TABLE files (
      sha256 TEXT PRIMARY KEY,
      r2Key TEXT NOT NULL,
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      pages INTEGER,
      class TEXT NOT NULL DEFAULT 'unclassified'
        CHECK (class IN ('unclassified', 'vault', 'normal', 'sensitive')),
      encrypted INTEGER NOT NULL,
      pipelineVersion INTEGER NOT NULL DEFAULT 0
    )`,

    // Each family has its own FTS table, so a search can only ever reach the families it names.
    // FTS rows share their chunk's rowid.
    `CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      noteId TEXT NOT NULL,
      rev INTEGER NOT NULL,
      family TEXT NOT NULL CHECK (family IN ('normal', 'sensitive')),
      fileSha TEXT,
      page INTEGER,
      header TEXT NOT NULL,
      text TEXT NOT NULL
    )`,
    "CREATE INDEX chunks_note ON chunks (noteId)",
    "CREATE VIRTUAL TABLE chunks_fts_normal USING fts5(header, text, tokenize = 'unicode61 remove_diacritics 2')",
    "CREATE VIRTUAL TABLE chunks_fts_sensitive USING fts5(header, text, tokenize = 'unicode61 remove_diacritics 2')",
    `CREATE TABLE vectors (
      chunkId INTEGER PRIMARY KEY,
      model TEXT NOT NULL,
      q BLOB NOT NULL
    )`,

    // Stored with inverses. `from` and `to` are SQL keywords, hence the Id suffix.
    `CREATE TABLE edges (
      fromId TEXT NOT NULL,
      toId TEXT NOT NULL,
      rel TEXT NOT NULL,
      PRIMARY KEY (fromId, toId, rel)
    ) WITHOUT ROWID`,
    "CREATE INDEX edges_to ON edges (toId)",

    // The OKF manifest (types and fields), not the SQL schema version, which lives in `meta`.
    `CREATE TABLE schema (
      version INTEGER PRIMARY KEY,
      manifest TEXT NOT NULL
    )`,
    `CREATE TABLE secrets (
      name TEXT PRIMARY KEY,
      ciphertext BLOB NOT NULL,
      policy TEXT NOT NULL,
      domain TEXT
    )`,
    `CREATE TABLE audit (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      tool TEXT NOT NULL,
      noteIds TEXT NOT NULL,
      secretName TEXT,
      approvalId TEXT
    )`,
  ],
  // The alarm's purge reads these on every wake.
  [
    "CREATE INDEX revisions_at ON revisions (at)",
    "CREATE INDEX notes_deleted ON notes (deletedAt) WHERE deletedAt IS NOT NULL",
  ],
  // The highest ackedUpTo a client has sent: a hello below it comes from a restored or copied client.
  ["ALTER TABLE clients ADD COLUMN ackedUpTo INTEGER NOT NULL DEFAULT 0"],
  // The sync change that made each feed entry, so a change replayed under another client id (after a
  // repair) is known to have landed, whatever has happened to the note since.
  [
    "ALTER TABLE changes ADD COLUMN changeId TEXT",
    "CREATE INDEX changes_change ON changes (changeId) WHERE changeId IS NOT NULL",
  ],
];

/** The SQL schema version this code writes. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** The record's SQL schema version; 0 for a record that has never been migrated. */
export function schemaVersion(sql: Sql): number {
  const [row] = sql.all<{ value: string }>("SELECT value FROM meta WHERE key = 'schemaVersion'");
  return row ? Number(row.value) : 0;
}

/**
 * Brings a record up to `SCHEMA_VERSION` in one transaction. The DO calls it each time it wakes, so every
 * record migrates lazily the first time it is used after a deploy; an up-to-date record costs one read.
 * A record already newer than this code (a rollback) is left alone, which additive migrations make safe.
 */
export function migrate(sql: Sql): { from: number; to: number } {
  return sql.transaction(() => {
    sql.all("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const from = schemaVersion(sql);
    if (from >= SCHEMA_VERSION) return { from, to: from };
    for (const statements of MIGRATIONS.slice(from)) for (const statement of statements) sql.all(statement);
    sql.all(
      "INSERT INTO meta (key, value) VALUES ('schemaVersion', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      String(SCHEMA_VERSION),
    );
    return { from, to: SCHEMA_VERSION };
  });
}
