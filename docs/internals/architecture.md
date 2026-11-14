# Architecture

Each person's record lives in **its own Durable Object with its own SQLite database**: the record, its change feed, its search index and its live connections. Neon holds what is shared across users (accounts, billing, the base registry). R2 holds files. One Worker serves every hostname. All of it is declared in one `alchemy.run.ts`.

![Clients connect to one Worker serving <domain>, mcp.<domain> and usercontent.<domain>. The Worker routes to each person's Base Durable Object, which holds raw notes, the change feed, approvals, a jobs outbox, FTS5, vectors and graph edges, and keeps live WebSockets. A DO alarm dispatches jobs to a Queue and Workflows, which call Workers AI and install results back into the DO only if the note revision still matches. Neon via Hyperdrive holds accounts and the registry; R2 holds files.](../assets/architecture.svg)

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
- **No retrieval holes, no stale text**: until new chunks replace them, old chunks are used only to find candidate notes; what's returned (snippets, context) always comes from the note's current revision. A stale snippet is never shown.

## Caching and file delivery

| Layer             | What                                                                      | Rule                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Browser**       | IndexedDB: snapshot, cursor, pending mutations; service worker: app shell | Cleared on sign-out. The sensitive class is cached only on a device you marked as yours with a passkey; elsewhere it loads on demand                                                                                                                                                                                                                                  |
| **DO memory**     | Parsed schema, the vector matrix, hot notes                               | Rebuilt on write inside the object; reloaded lazily after hibernation (budgeted in the latency targets)                                                                                                                                                                                                                                                               |
| **Edge cache**    | The app shell and static assets only                                      | Versioned per deploy                                                                                                                                                                                                                                                                                                                                                  |
| **Private files** | Originals, thumbnails, extracted text                                     | Never in a shared cache. Every read is authorized first. Normal files are served as a 5-minute signed R2 URL. Sensitive files are envelope-encrypted by the Worker on upload, so they're streamed back from `usercontent.<domain>` with a short single-use token (`private, no-store`), never by signed URL. This is not end-to-end encryption, and the plan says so. |

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
│   ├── worker/              the one Worker: UI, API, MCP, files, queue consumer, Workflows; exports the Base DO
│   ├── cli/                 brainiac CLI, daemon, stdio MCP, Claude Code hook (bun build --compile)
│   └── extension/           browser extension: fill + save link
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
  // + routes for <domain>, mcp.<domain>, usercontent.<domain>, and a Queues.Consumer for jobs
});
// all of it under RemovalPolicy.protect() in prod
```

In prod a plan that would replace or delete any resource fails before it applies, and every CI deploy shows
its plan. [infra/README.md](../../infra/README.md) has the stages, secrets and guards.
