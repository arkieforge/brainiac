import type { Sql } from "./sql.ts";

/**
 * Every migration, in order; migration `i` takes a record from version `i` to `i + 1`. Version 0 is the
 * shape before this package: only the `meta` table.
 *
 * Migrations are additive for one release (new tables, new columns, new indexes, or rebuilding a derived table
 * with the same name and columns), so the previous Worker still runs on a record the new one has migrated, and a
 * rollback never needs a down migration. Removing
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
  // Every sync change the record has answered, by its changeId, with the answer: a change replayed under
  // another client id (after a repair) gets the same answer, whatever has happened to the note since.
  [
    `CREATE TABLE landed (
      changeId TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      at INTEGER NOT NULL
    ) WITHOUT ROWID`,
    "CREATE INDEX landed_at ON landed (at)",
  ],
  // Who opened a review session: only they may use it.
  ["ALTER TABLE review_runs ADD COLUMN actor TEXT NOT NULL DEFAULT ''"],
  // Connections and held proposals. A grant's signature covers the connection's `rev`, which every change to
  // its grants bumps, so a signature can't raise a connection again after it was lowered. A proposal keeps the
  // change it holds (`action`), to run when it's released.
  [
    "ALTER TABLE connections ADD COLUMN rev INTEGER NOT NULL DEFAULT 0",
    "CREATE UNIQUE INDEX connections_oauth ON connections (oauthClientId) WHERE oauthClientId IS NOT NULL",
    "CREATE INDEX tokens_connection ON tokens (connectionId)",
    "ALTER TABLE proposals ADD COLUMN action TEXT",
    "ALTER TABLE proposals ADD COLUMN runId TEXT",
  ],
  // The principal a client's cursor was earned under, so a hello under another one gets a snapshot; the note
  // each stored answer is about, so a replay shows it only while the client may still see that note; and which
  // change a landed answer answers, so a change id reused for another change never gets it. Rows from before
  // this have none of it; there are none, since no deployed route forwarded a sync socket before it shipped.
  [
    "ALTER TABLE clients ADD COLUMN reader TEXT",
    "ALTER TABLE results ADD COLUMN noteId TEXT",
    "ALTER TABLE landed ADD COLUMN noteId TEXT",
    "ALTER TABLE landed ADD COLUMN digest TEXT",
  ],
  // The vault: what the checks made of each upload, what the person confirmed it is, and the note its parse
  // wrote. A file the checks never read is `unreadable`, so it can't be cleared.
  [
    `ALTER TABLE files ADD COLUMN checks TEXT NOT NULL DEFAULT 'unreadable'
      CHECK (checks IN ('clean', 'found', 'unreadable'))`,
    "ALTER TABLE files ADD COLUMN findings TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE files ADD COLUMN kind TEXT",
    "ALTER TABLE files ADD COLUMN confirmedAt INTEGER",
    "ALTER TABLE files ADD COLUMN noteId TEXT",
    // Bumped by every confirmation; a passkey signature over a kind change names the rev it was signed at.
    "ALTER TABLE files ADD COLUMN rev INTEGER NOT NULL DEFAULT 0",
  ],
  // Single-use file tokens for the usercontent origin: only a hash of each token, the file it opens, the site
  // origin that asked (the only one its bytes may be read from) and when it stops working.
  [
    `CREATE TABLE file_tokens (
      hash TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      origin TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    ) WITHOUT ROWID`,
  ],
  // The account page reads each connection's calls, newest first.
  ["CREATE INDEX audit_actor ON audit (actor, id)"],
  // Who uploaded each file, so a passport its extraction parses later is written as them.
  ["ALTER TABLE files ADD COLUMN uploadedBy TEXT"],
  // The repos the GitHub connector proposed a project for, by GitHub's node id (stable across renames), so a
  // project the person rejected or deleted is never proposed again; and the latest `synced:` block GitHub gave
  // for each, which a project accepted after it changed catches up to.
  [
    `CREATE TABLE github_repos (
      repoId TEXT PRIMARY KEY,
      proposalId TEXT NOT NULL,
      snapshot TEXT NOT NULL
    ) WITHOUT ROWID`,
  ],
  // unicode61 splits words at combining marks by default, so a Bangla or Hindi word became fragments (and a
  // fragment matched inside other words): marks are word characters now. Same names and columns, so the
  // previous Worker still reads and writes them; refilled from the chunks, which carry search until the
  // re-index (`CHUNKS`) stores them folded.
  (["normal", "sensitive"] as const).flatMap((family) => [
    `DROP TABLE chunks_fts_${family}`,
    `CREATE VIRTUAL TABLE chunks_fts_${family} USING fts5(header, text,
      tokenize = "unicode61 remove_diacritics 2 categories 'L* N* Co M*'")`,
    `INSERT INTO chunks_fts_${family} (rowid, header, text)
      SELECT id, header, text FROM chunks WHERE family = '${family}'`,
  ]),
  // The revision of the item a lease handed out, so `done` deletes only what the agent read.
  ["ALTER TABLE inbox_leases ADD COLUMN rev INTEGER NOT NULL DEFAULT 0"],
  // The fill path (secrets.ts): each fill an agent asked for waits here, holding field names, the agent's own values
  // and secrets' names, never a secret's value.
  [
    `CREATE TABLE fills (
      id TEXT PRIMARY KEY,
      connectionId TEXT,
      url TEXT NOT NULL,
      host TEXT NOT NULL,
      fields TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    ) WITHOUT ROWID`,
  ],
  // The actor that registered each sync client id; only it may use the id. Rows from before have none and go
  // to the next actor that uses them.
  ["ALTER TABLE clients ADD COLUMN actor TEXT"],
  // The proposal that brought each secret in (a passport's number, waiting with its note's proposal), so turning
  // the proposal down takes the secret with it. The person's own saves have none.
  ["ALTER TABLE secrets ADD COLUMN proposalId TEXT"],
  // Each upload's place in the record (`documents/files/<name>`, which its sidecar note's `file:` resolves to in
  // the cloud and on a laptop alike) and the person's own name for it, which only they ever see. Uploads from
  // before have neither until they are uploaded again.
  [
    "ALTER TABLE files ADD COLUMN path TEXT",
    "ALTER TABLE files ADD COLUMN name TEXT",
    "CREATE UNIQUE INDEX files_path ON files (path)",
  ],
  // Which calls a background run made (the daemon's headless filer), since it shares the device's connection
  // with the person's own sessions. Rows from before say foreground.
  ["ALTER TABLE audit ADD COLUMN background INTEGER NOT NULL DEFAULT 0"],
  // Each ORCID work the connector proposed as a paper (orcid.ts), by ORCID's put-code and its DOI, so one the person
  // turned down is never proposed again. The linked iD itself is in `meta`.
  [
    `CREATE TABLE orcid_works (
      key TEXT PRIMARY KEY,
      proposalId TEXT NOT NULL
    ) WITHOUT ROWID`,
  ],
  // When each file was uploaded, and whether the person lets their agents see a photo itself (vault.ts,
  // `shareFile`): when they turned that on, and how many times they turned it on or off, which a passkey
  // signature names so it can't be used twice. Uploads from before have no upload time.
  [
    "ALTER TABLE files ADD COLUMN uploadedAt INTEGER",
    "ALTER TABLE files ADD COLUMN sharedAt INTEGER",
    "ALTER TABLE files ADD COLUMN shares INTEGER NOT NULL DEFAULT 0",
  ],
  // The expiry reminder each note last reached (reminders.ts): for which expiry, which of 60, 30, 7 or 0 days, and
  // whether its email went out, so each one is sent once and a changed expiry starts again.
  [
    `CREATE TABLE reminders (
      noteId TEXT PRIMARY KEY,
      expires TEXT NOT NULL,
      stage INTEGER NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID`,
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
