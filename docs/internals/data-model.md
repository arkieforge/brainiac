# Data model

## Neon (shared across users)

```
user, session, account, verification, passkey                  // Better Auth core + passkey plugin
oauthClient, oauthAccessToken, oauthRefreshToken, oauthConsent  // Better Auth MCP / OAuth provider
bases        { id, ownerId, doName, jurisdiction, createdAt, deletedAt? }
billing      { userId, polarCustomerId, plan, periodEnd }
usage_daily  { baseId, day, toolCalls, ingestPages, storageBytes, tregCents }
```

## Base DO SQLite (the record)

`packages/base` owns this schema, its migrations and its queries; the DO and the CLI's bun:sqlite run the
same code, and its tests run every case on both engines. Columns are camelCase, so rows read as TypeScript
objects. Migrations are additive for one release, so the previous Worker still runs on a migrated record;
each DO migrates itself the first time it wakes after a deploy.

```
meta         { key PK, value }                                      // schemaVersion (the SQL schema's), seq (the last one assigned)
notes        { id ULID, path, raw TEXT, fm JSON (parsed), rev, hash, seq, class, deletedAt?,
               type, title, kind, status, date, deadline, expires }  // the last row generated from fm
revisions    { noteId, rev, raw, patch, actor, runId, at }         // patch: each field's before and after; undo applies it in reverse
changes      { seq PK, noteId, rev, op, actor, at }                 // sync feed, 90 days; op: create | update | delete | restore
clients      { clientId PK, highWater, ackedUpTo, lastHash, lastSeenAt, appVersion }   // strict in-order apply; ackedUpTo: the highest it sent
results      { clientId, clientSeq, digest, result JSON }             // dropped once ackedUpTo passes it
proposals    { id, noteId?, patch, actor, autoApplyAt?, status, kind: change | conflict | schema }
approvals    { id, planHash, items JSON [(noteId, baseRev, patch)], assertion, credentialId, at, usedAt? }
review_runs  { nonce, items JSON, assertion, credentialId, expiresAt }   // one signature, only for the items shown
passkey_keys { credentialId PK, publicKey, counter }                // cached from Better Auth's passkey table
connections  { id PK, kind: oauth | cli, oauthClientId?, level, scopes JSON, sensitive, holdDays, createdAt }
inbox_leases { itemId, agent, expiresAt }                            // one filer per item
questions    { id, noteId?, field?, input JSON, suggested JSON?, why, priority, status, class }
checks       { id, noteId, field?, detector, evidence JSON, suggestion JSON, status }
jobs         { id, kind, noteId, rev, status, attempts, dispatchedAt }   // transactional outbox; status: pending | dispatched | failed
files        { sha256 PK, r2Key, mime, bytes, pages?, class: unclassified | vault | normal | sensitive, encrypted, pipelineVersion }
chunks       { id, noteId, rev, family: normal | sensitive, fileSha?, page?, header, text }
chunks_fts_normal, chunks_fts_sensitive  USING fts5(header, text)
vectors      { chunkId PK, model, q BLOB }                          // int8, exact cosine in memory
edges        { fromId, toId, rel }
schema       { version, manifest TEXT }                             // the OKF manifest, not the SQL schema
tokens       { id, connectionId, hash, expiresAt, revokedAt? }       // CLI tokens; OAuth tokens resolve to a connection through their consent record, so refresh rotation keeps the grant
secrets      { name PK, ciphertext, policy, domain }
audit        { id, at, actor, tool, noteIds, secretName?, approvalId? }
```

## R2

```
blobs/{baseId}/{sha256}                     // originals; sensitive ones envelope-encrypted
blobs/{baseId}/derived/{sha256}/{variant}   // thumbnails, page images, rendered PDFs
```

Typed tables like `applications` or `links` are not stored separately: they're queries over `notes.fm` (with generated columns and indexes for hot fields). Dedupe is per record, never global, so no one can probe whether someone else uploaded a file.
