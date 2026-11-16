# Architecture

Each person's record lives in **its own Durable Object with its own SQLite database**: the record, its change feed, its search index and its live connections. Neon holds what is shared across users (accounts, billing, the base registry). R2 holds files. One Worker serves every hostname. All of it is declared in one `alchemy.run.ts`.

![Clients connect to one Worker serving <domain> (site and MCP) and usercontent.<domain>. The Worker routes to each person's Base Durable Object, which holds raw notes, the change feed, approvals, a jobs outbox, FTS5, vectors and graph edges, and keeps live WebSockets. A DO alarm dispatches jobs to a Queue and Workflows, which call Workers AI and install results back into the DO only if the note revision still matches. Neon via Hyperdrive holds accounts and the registry; R2 holds files.](../assets/architecture.svg)

## Why one Durable Object per person

- **Isolation by construction**: each record is a separate database. A query bug can't return another person's rows, because they aren't in the database being queried.
- **Parity by construction**: the DO and the CLI both run SQLite with FTS5 through one package (`packages/base`), so cloud and local run the same queries.
- **Ordering**: every mutation is one SQL transaction that assigns the next `seq`. Because a DO only interleaves requests while one is awaiting I/O, a mutation never awaits anything external between reading the revision and committing.
- **Live and cheap**: hibernating WebSockets cost nothing while idle.
- **Fits the size**: a record is about 5 to 50 MB of SQLite; the cap per DO is 10 GB, and files go to R2.

## Background work that survives crashes

- **Transactional outbox**: any mutation that needs follow-up work (extract, embed, reindex, render) writes a `jobs` row in the same transaction. A DO alarm dispatches pending jobs to the Queue and sends a job again if nobody acknowledges it within its lease, up to 5 times, after which it is marked failed. After a restart, pending jobs are dispatched again.
- **Inbox filing is a job too**: the item waits in the DO until an agent (your Claude) claims it with a lease, so two agents never file the same item.
- **Revision-checked results**: a job carries the note revision it was made for. Its result is installed only if the note is still at that revision; otherwise it's dropped and a job for the new revision runs.
- **Connector lookups are jobs too**: the alarm enqueues one for each paper whose DOI has no `synced:` block yet,
  whose block is a week old, or whose block is older than the last change to the linked ORCID iD, and the result is written through the mutation path as `connector:doi`. A result the
  record refuses (it would change a value the person verified) leaves the job failed, and a failed lookup waits a
  week like a successful one, so a DOI is never fetched in a loop.
- **Profile reads are paid, so the person starts them**: the alarm enqueues a `drift` job only for a Profile never
  read at its current link; after that, only the site's Check now (`checkProfiles`) enqueues one, and not for a
  profile read less than a day ago. A failed one waits for the person to ask again.
- **Link checks are free, so they run weekly**: the alarm enqueues a `link` job for each Link never read at its
  current address, or checked a week ago, written as `connector:links`. Only the first read at an address pays for
  text (treg) and takes a snapshot (Browser Rendering); a snapshot is sealed into R2 before the install, its only
  await, and recorded with its sidecar in the install's transaction.
- **Expiry reminders are a job too**: the alarm wakes at the start (UTC) of the days 60, 30 and 7 before an item
  expires and of the day itself (`packages/base/src/reminders.ts`). Each item that reached a reminder it hasn't had
  waits in `reminders` (an item saved already inside a window gets that window's once; a changed expiry starts
  again), and one `remind` job carries all of them out in one email that names normal notes and only counts
  sensitive ones. The Worker finds the owner's verified address in Neon and sends it; a send that fails every
  attempt waits a day. A laptop copy sends nothing: its review shows the same `expiring` flags. The person can turn
  reminders off on `/emails` without touching the weekly questions email; a reminder reached while they're off
  counts as had, so turning them back on brings the next one, not a backlog.
- **No retrieval holes, no stale text**: until new chunks replace them, old chunks are used only to find candidate notes; what's returned (snippets, context) always comes from the note's current revision. A stale snippet is never shown.

## Caching and file delivery

| Layer             | What                                                                      | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Browser**       | IndexedDB: snapshot, cursor, pending mutations; service worker: app shell | Kept per account and cleared on sign-out (every open tab lets go of it first). The sensitive class is cached only on a device you marked as yours with a passkey; elsewhere it loads on demand, and the site saves its edits straight to the record, online only, so none waits in the queue                                                                                                                                                                                                                                                                   |
| **DO memory**     | Parsed schema, the vector matrix, hot notes                               | Rebuilt on write inside the object; reloaded lazily after hibernation (budgeted in the latency targets)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Edge cache**    | The app shell and static assets only                                      | Versioned per deploy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Private files** | Originals, thumbnails, extracted text                                     | Never in a shared cache. Every read is authorized first. Every upload starts unclassified, so the Base DO seals each one with the record's data key before it reaches R2 (`packages/base/src/vault.ts`); files are streamed back from `usercontent.<domain>` with a short single-use token (`private, no-store`), never by signed URL; the site's own origin never serves a file's bytes. An unclassified or vault file's original needs the session to have proved a passkey in the last 10 minutes. This is not end-to-end encryption, and the plan says so. |

## Alternatives considered

- **Convex**: built-in live sync, but every query must filter by base, and its engine differs from local SQLite. It's the fallback if the DO sync layer ever costs more than it saves.
- **Neon Realtime** (beta since 2026-10-15): live SQL queries over WebSockets. Revisit when it is GA and documents resuming an offline client from a cursor. Not used now.

## Repo layout and infrastructure

```
brainiac/
├── alchemy.run.ts           every Cloudflare + Neon resource, per stage
├── packages/
│   ├── core/                schema (ArkType), OKF parse/patch (yaml Document API), merge rules, filter compiler, chunker, masking
│   ├── base/                SQL schema, migrations, queries: runs in the DO and in bun:sqlite
│   ├── sync/                sync client: browser + CLI daemon
│   └── render/              markdown pipeline and viewers (from T3 Code, MIT)
├── apps/
│   ├── worker/              the one Worker: API, MCP, files, queue consumer, Workflows; serves web's build; exports the Base DO
│   ├── ocr/                 OCR for the vault's checks: its own Worker, reached only over RPC, so Tesseract's memory stays out of the main one
│   ├── typst/               Drafts' PDFs: its own Worker, reached only over RPC, so the compiler's 28 MB of wasm stays out of the main one's cold starts
│   ├── web/                 the site: TanStack Start in SPA mode, built to static files
│   ├── marketing/           the public Astro site
│   ├── cli/                 brainiac CLI, daemon, stdio MCP, Claude Code hook (bun build --compile)
│   └── extension/           browser extension (Chrome MV3): fills a form an agent asked for; save link later
├── evals/                   model evals, T3 Code's layout
└── fixtures/                the fictional student's record + golden questions
```

```
// alchemy.run.ts (sketch of where it is heading; Alchemy 2.0, inside the Stack's Effect.gen)
const { stage } = yield* Alchemy.Stack;                                  // dev_<you> | pr-123 | prod
// brainiac-dev (dev and PR stages) and brainiac-prod are made once by hand; a branch per stage
const db     = yield* Neon.Branch("db", { project: { projectId }, name: stage });
const pg     = yield* Cloudflare.Hyperdrive.Connection("hyperdrive", { origin: db.origin });
const blobs  = yield* Cloudflare.R2.Bucket("blobs");
const jobs   = yield* Cloudflare.Queues.Queue("jobs");                  // + dead-letter queue
const worker = yield* Cloudflare.Worker("worker", {
  main: "apps/worker/src/index.ts",
  env: { BASE: Cloudflare.DurableObject("Base"), HYPERDRIVE: pg, BLOBS: blobs, JOBS: jobs /* + AI, Images, Browser Rendering, Secrets Store */ },
  // + routes for <domain> (site and /mcp), usercontent.<domain>, and a Queues.Consumer for jobs
});
// all of it under RemovalPolicy.protect() in prod
```

The Worker's top-level code (everything its entry imports statically, the `Base` DO included) must finish in
1 s of CPU, or Cloudflare refuses the deploy with `ScriptStartupError`. Cloudflare's own `startup_time_ms` for a
deploy swings by up to 2x, so the median must stay well under half of that. Libraries only some requests use
(Better Auth, the MCP SDK, SimpleWebAuthn) load with `import()` on first use. That cut the median from about
405 ms to 311 ms (#162). Most of what's left is ArkType building its scope on import (about 180 ms by itself),
which the `Base` DO needs at load. A chunk that is uploaded but not imported at startup costs nothing. Measure a
bundle with `wrangler check startup`, or read a deployed version's `startup_time_ms` from the Workers versions API.

In prod a plan that would replace or delete any resource fails before it applies, and every CI deploy shows
its plan. [infra/README.md](../../infra/README.md) has the stages, secrets and guards.
