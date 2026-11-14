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

```
notes        { id ULID, path, type, raw TEXT, fm JSON (parsed), rev, hash, seq, class, deletedAt? }
revisions    { noteId, rev, raw, patch, actor, runId?, at }        // undo = inverse patches
changes      { seq PK, noteId, rev, op, actor }                     // sync feed, 90 days
clients      { clientId PK, highWater, lastHash, lastSeenAt, appVersion }   // strict in-order apply
results      { clientId, clientSeq, digest, result JSON }             // dropped once ackedUpTo passes it
proposals    { id, noteId?, patch, actor, autoApplyAt?, status, kind: change | conflict | schema }
approvals    { id, planHash, items JSON [(noteId, baseRev, patch)], assertion, credentialId, at, usedAt? }
review_runs  { nonce, items JSON, assertion, credentialId, expiresAt }   // one signature, only for the items shown
passkey_keys { credentialId PK, publicKey, counter }                // cached from Better Auth's passkey table
connections  { id PK, kind: oauth | cli, oauthClientId?, level, scopes JSON, sensitive, holdDays, createdAt }
inbox_leases { itemId, agent, expiresAt }                            // one filer per item
questions    { id, noteId?, field?, input JSON, suggested JSON?, why, priority, status, class }
checks       { id, noteId, field?, detector, evidence JSON, suggestion JSON, status }
jobs         { id, kind, noteId, rev, status, attempts, dispatchedAt }   // transactional outbox
files        { sha256 PK, r2Key, mime, bytes, pages?, class: unclassified | vault | normal | sensitive, encrypted, pipelineVersion }
chunks       { id, noteId, rev, family: normal | sensitive, fileSha?, page?, header, text }
chunks_fts_normal, chunks_fts_sensitive  USING fts5(header, text)
vectors      { chunkId PK, model, q BLOB }                          // int8, exact cosine in memory
edges        { from, to, rel }
schema       { version, manifest TEXT }
tokens       { id, connectionId, hash, expiresAt, revokedAt? }       // CLI tokens; OAuth tokens resolve to a connection through their consent record, so refresh rotation keeps the grant
secrets      { name PK, ciphertext, policy, domain }
audit        { at, actor, tool, noteIds, secretName?, approvalId? }
```

## R2

```
blobs/{baseId}/{sha256}                     // originals; sensitive ones envelope-encrypted
blobs/{baseId}/derived/{sha256}/{variant}   // thumbnails, page images, rendered PDFs
```

Typed tables like `applications` or `links` are not stored separately: they're queries over `notes.fm` (with generated columns and indexes for hot fields). Dedupe is per record, never global, so no one can probe whether someone else uploaded a file.
