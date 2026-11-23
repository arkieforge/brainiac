# Quality bar

"Works 100 out of 100" means two things. The **deterministic parts** (sync, schema, filters, permissions, approvals, merges, secrets, requirement checks, the verify step) must be correct every time, and tests check it from many angles, including property tests over thousands of random cases. The **model parts** run in the user's own Claude, so Brainiac's job is to make the right answer easy and a wrong number catchable, and evals measure how well that works on the models people actually use.

## Cheap where it costs money: infrastructure, not models

| Lever                                  | Effect                                                                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No model bill by default**           | Thinking runs on the user's own subscription. Brainiac pays only for deterministic infrastructure: storage, sync, search, document-to-text, embeddings                                                                                                              |
| **No paid eval or observability SaaS** | Evals live in the repo and write JSONL rows plus a summary (T3 Code's layout), instead of Braintrust or Langfuse. Logs and traces: Workers Logs; metrics: Analytics Engine; both included with Workers Paid. Sentry's free tier only if the CLI needs crash reports |
| **One platform**                       | Cloudflare covers compute, storage, queues, workflows, extraction, embeddings, email routing and bot protection; Neon only holds shared account data and scales to zero                                                                                             |
| **Pay once per file**                  | Extraction and embeddings are keyed by sha256 + pipeline version; re-uploads and moves cost nothing                                                                                                                                                                 |
| **Idle costs nothing**                 | DOs hibernate with sockets open; Neon scales to zero; R2 has no egress fees                                                                                                                                                                                         |
| **Paid data per call, not per seat**   | treg for drift checks and link text, cached for a day, only when the user triggers it                                                                                                                                                                               |

Target, to confirm with real usage: infrastructure cost well under $0.25 per active user per month for a typical record (a few hundred notes, a few dozen files). Analytics Engine records cost per job so it's a measured number.

## Fast, with numbers

| Path                                                | Target (p95)             | Checked by                                            |
| --------------------------------------------------- | ------------------------ | ----------------------------------------------------- |
| First screen (returning user)                       | < 300 ms, from IndexedDB | Playwright trace on a preview stage, every PR         |
| Edit on site → other tab / phone                    | < 300 ms                 | Sync e2e with two browsers                            |
| Edit on site → file on a laptop                     | < 1 s                    | Sync e2e with a simulated daemon                      |
| MCP `query` / `get` / `related`, warm DO            | < 80 ms server time      | `vp run bench`, on the fixture, every PR              |
| MCP `search` / `ask context`, warm                  | < 150 ms                 | `vp run bench`, on the fixture and a 20k-chunk record |
| Same, cold DO (after hibernation, vectors reloaded) | < 600 ms                 | `vp run bench`, the instance evicted before each call |
| Upload → searchable (10-page PDF)                   | < 20 s                   | Ingest test                                           |

`vp run bench` (`apps/worker/bench`) runs the real Base DO and jobs consumer in workerd through Miniflare and fails when a p95 is over its target. It times each MCP tool call's round trip over RPC on localhost, from Node, because workerd's clock stands still during CPU work inside the DO: an upper bound on server time, without the network to Cloudflare. Questions are embedded by a stand-in as wide as bge-m3's vectors, so a Workers AI call's own time isn't in it. Cold means the instance was aborted, so the call pays the constructor and reads storage again; Miniflare can't evict the isolate, so module load isn't in it either.

## Tests (deterministic, every PR, free)

- **Unit**: `packages/core` (schema, merges, filter compiler, chunker, YAML patching), `packages/base` (SQL, migrations and each MCP tool's logic, as cases run on both bun:sqlite and the DO).
- **Property tests** (fast-check): random edits across 3 simulated clients with disconnects and offline periods always converge with nothing lost; random filters return the same rows locally and in the DO; a YAML or body edit leaves every byte outside the edited node unchanged; and the **approval invariant**: random sequences of update, delete, undo, move, type change, schema change and superseding create from actors without an approval never change a verified value or the verified set, and never escape the hold.
- **DO integration** in workerd through Miniflare (`apps/worker/test`; Cloudflare's vitest pool needs vitest 4): protocol, high-water marks, client reset, jobs outbox, migrations, scopes, approvals, hibernation.
- **MCP contract**: the real `serveMcp` handler, signed in as a fixture connection, with tools reaching a real Base DO in workerd through Miniflare. Every tool's advertised schema matches what it accepts; an argument a tool doesn't declare is rejected rather than dropped; an optional argument sent as `null` reads as omitted and a required one rejects it, while a `null` inside a value (a `set` patch, a filter) is data, never a dropped argument; a read connection can't write; a change on the approval list returns `needsApproval`; the base comes from the token; and an outside service's error text never reaches the agent. Tools are thin, so their logic is tested in `packages/base` and this layer tests the transport. The handler runs in Node like the OAuth tests beside it (`apps/worker/src/auth/auth.test.ts`), because sign-in needs their in-memory Neon; only services outside the record (Neon, Workers AI) are faked.
- **End to end** on an Alchemy preview stage per PR (its own Neon branch): sign-up with a passkey, import, edit, approve, a web edit reaching a laptop file, an offline conflict, a blocked local edit.
- **Real filesystem**: the daemon's file adapter runs against real editors' save patterns (atomic rename, in-place write) with concurrent saves interleaved at every step of the swap, on macOS and Linux in M0 and Windows in M1.
- **Chaos**: kill a DO mid-write, drop and reorder messages, a laptop offline for 100 days, a cloned vault, a machine restored from a week-old backup, a deleted vault.
- **Security**: cross-tenant suite on every route and tool, canary non-disclosure across every read surface (including that a new connection gets no sensitive data until you grant the scope), forged and replayed approval signatures, vault documents never reaching an agent, injection corpus, XSS uploads, secret-leak scan of all test logs and outputs.
- **Parity**: the fixture record and questions, local (online) vs cloud: identical results. Online, the same tool calls over remote MCP and `brainiac mcp serve` return the same tool list and the same answers, at the floor and with the sensitive scope; online, stdio forwards every call to the record, so what the device holds never changes an answer.
- **Real clients**, by hand before each release and after any change to `/mcp`'s sign-in or transport: Claude Code, the claude.ai connector, T3 Code and MCP Inspector sign in to a dev stage, list the tools, call one and refresh; over `brainiac mcp serve`, Claude Code and Codex list the tools and call one. This is the only layer that sees a client's own OAuth and UI.

## Evals (model behavior, T3 Code's shape)

One folder per eval with `run.ts`, a README (what it measures, how to run it, what a run costs) and cases as data. Cases import the real tool descriptions, prompts and schemas from source. The world is the fixture record running in `packages/base`, so tools return real results and no model has to play the server.

| Eval               | Measures                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mcp-tool-use`     | `describe` first, `query` before `search`, update instead of create, new events as new notes, dry-run bulk changes, `verify` before numbers, `request_info` instead of guessing, no direct file writes |
| `retrieval`        | Recall@8 and citation precision on golden questions per route, local and cloud                                                                                                                         |
| `answers`          | With `ask context` + `verify`: values quoted exactly, unverified values labeled, "not in your record" when it isn't                                                                                    |
| `filing`           | "File my inbox": the right proposals on the right notes; the injection corpus never gets past the approval list; background filing never touches sensitive or unclassified items                       |
| `structure`        | New info lands in the right type and folder; controls check no invented types                                                                                                                          |
| `drafts`           | Every claim cited, no invented numbers, house rules followed, `verify` clean                                                                                                                           |
| `review-detectors` | Precision and recall of "looks wrong" flags on seeded errors (deterministic, so this one also runs in CI)                                                                                              |

- **Models**: each run covers the models users bring: Claude Opus and Sonnet (Claude Code and claude.ai), and GPT Sol through Codex or T3 Code. The gate is no regression on any of them; models are never downgraded to save money.
- **Case rules** (from T3): each case reproduces a real bad experience or guards a good one and names its source; `bad`, `guard` or `control`; a `bad` case is added before its fix, fails on the old text and passes on the new, while `guard` and `control` cases pass on both; only the fictional fixture student, no real data. The first cases come from real past mistakes with personal-record tools, rewritten for the fixture.
- **Sampling**: 2 samples per case, a 3rd when they disagree; a case fails when half or more fail. **Exception**: exact-value and canary cases fail if _any_ sample fails.
- **Running**: graders' unit tests and `--dry-run` in CI; paid runs of touched cases before merge on the team's own subscriptions or keys; a full run per model before each release, with its token use recorded in the summary.

## Release gates

Tests and evals are evidence, not proof, so the gates set floors for usefulness as well as correctness: refusing everything can't pass.

| Gate                                                                                                              | Floor                                       |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Deterministic tests (unit, property, integration, MCP contract, parity, e2e, chaos, security)                     | 100% pass                                   |
| Exact-value and canary eval cases                                                                                 | No failing sample on any supported model    |
| Retrieval recall@8 on the golden questions                                                                        | ≥ 0.95                                      |
| Answerability: questions whose answer is in the record get one (not "not in your record")                         | ≥ 0.95                                      |
| Extraction coverage: fixture document fields filled automatically and correctly                                   | ≥ 0.90 (the rest become questions)          |
| Review detectors on seeded errors                                                                                 | recall ≥ 0.90, precision ≥ 0.90             |
| `mcp-tool-use` tasks completed correctly                                                                          | ≥ 0.90 per model, no regression on any case |
| Latency targets above                                                                                             | Met on the preview stage                    |
| Infrastructure cost on the benchmark workload (300 notes, 40 files, 50 tool calls and 3 uploads a day, one month) | ≤ $0.25 per record                          |
