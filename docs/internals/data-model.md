# Data model

## Neon (shared across users)

```
user, session, account, verification, passkey                  // Better Auth core + passkey plugin
oauthClient, oauthAccessToken, oauthRefreshToken, oauthConsent  // Better Auth MCP / OAuth provider; a CIMD
oauthResource, oauthClientResource, oauthClientAssertion        //   client's row is keyed by its metadata URL
bases        { id, ownerId, jurisdiction?, createdAt, deletedAt? }         // id: the Base DO's id (newUniqueId), as in CLI tokens; one per owner
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
changes      { seq PK, noteId, rev, op, actor, at }                 // sync feed, 90 days; op: create | update | delete | restore | classify
landed       { changeId PK, result JSON, at }                       // every sync change answered, 90 days: a replay gets the same answer
clients      { clientId PK, highWater, ackedUpTo, lastHash, lastSeenAt, appVersion, reader }   // strict in-order apply; ackedUpTo: the highest it sent; reader: the principal its cursor was earned under
results      { clientId, clientSeq, digest, result JSON }             // dropped once ackedUpTo passes it
proposals    { id, noteId?, patch, actor, autoApplyAt?, status, kind: change | conflict | schema, action?, runId? }   // status: open | applied | rejected | withdrawn; a held change keeps its plan in patch and what applies it in action
approvals    { id, planHash, items JSON [(noteId, baseRev, path, class, patch)], assertion, credentialId, at, usedAt? }   // used once
review_runs  { nonce, actor, items JSON, assertion, credentialId, expiresAt }   // one signature, only for its opener and the items shown; assertion '' until signed
passkey_keys { credentialId PK, publicKey, counter }                // the last counter each passkey signed with here
connections  { id PK, kind: oauth | cli, oauthClientId?, level, scopes JSON, sensitive, holdDays, rev, createdAt }   // rev: bumped by every grant change; a grant signature names it
inbox_leases { itemId, agent, expiresAt }                            // one filer per item
questions    { id, noteId?, field?, input JSON, suggested JSON?, why, priority, status, class }
checks       { id, noteId, field?, detector, evidence JSON, suggestion JSON, status }   // unused: checks are computed on read from the notes (review.ts), so none goes stale
jobs         { id, kind: index | file, noteId, rev, status, attempts, dispatchedAt }   // transactional outbox; status: pending | dispatched | failed; a file job's noteId is file:<sha256> and its rev the file's
files        { sha256 PK, r2Key, mime, bytes, pages?, class: unclassified | vault | normal | sensitive, encrypted, pipelineVersion,
               checks: clean | found | unreadable, findings JSON, kind?, confirmedAt?, noteId?, rev, uploadedBy? }   // sha256: an HMAC of the bytes under the data key; kind counts only once the person confirms it; rev: bumped by each confirmation; pipelineVersion: the extraction that produced checks (0 while a PDF waits for its first)
chunks       { id, noteId, rev, family: normal | sensitive, fileSha?, page?, header, text }   // a cleared file's pages: noteId file:<sha256>, until files get sidecar notes (#100)
chunks_fts_normal, chunks_fts_sensitive  USING fts5(header, text)
vectors      { chunkId PK, model, q BLOB }                          // int8, exact cosine in memory; meta.index names the chunking and model the index was built with
edges        { fromId, toId, rel }
schema       { version, manifest TEXT }                             // the OKF manifest, not the SQL schema
file_tokens  { hash PK, sha256, origin, expiresAt }                  // single-use, one minute: opens one file's original on usercontent.<domain> for the site origin that asked; brf_<base id>_<secret>, stored as a hash
tokens       { id, connectionId, hash, expiresAt, revokedAt? }       // CLI tokens, brn_<base id>_<secret>, stored as a hash of the whole token; OAuth tokens resolve to a connection through their consent record, so refresh rotation keeps the grant
secrets      { name PK, ciphertext, policy, domain }                // ciphertext: sealed with the data key (meta.dataKey, itself wrapped by the stage's VAULT_KEY), base64
audit        { id, at, actor, tool, noteIds, secretName?, approvalId? }
```

## R2

```
blobs/{baseId}/{sha256}                     // originals, every one sealed with the record's data key, under the file's keyed id
blobs/{baseId}/derived/{sha256}/{variant}   // thumbnails, page images, rendered PDFs
```

Typed tables like `applications` or `links` are not stored separately: they're queries over `notes.fm` (with generated columns and indexes for hot fields). Dedupe is per record, never global, so no one can probe whether someone else uploaded a file.
