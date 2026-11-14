# Retrieval

One pipeline in the cloud (SQLite in the DO) and on a laptop (SQLite through Bun), from one package. Deterministic lookups are exact by construction. Answers are written by your own model, and any answer can be checked against the record with one call.

## Authorization comes first: one projection for every read

A single function, `project(note, principal)`, decides which fields, body and files a caller may see. `query`, `search`, `get`, `related`, `describe`, history, MCP resources, file URLs, `ask` context and every cache use it. The index is built so it can't leak:

- **Chunks never mix privacy classes**: normal fields and body go in one chunk family; sensitive fields in another, in a separate FTS table and vector set. A note marked sensitive puts its body in the sensitive family. Searches run only over the families the caller may see, before ranking.
- **Field scopes** on tokens (for example "Education and Roles only") filter the note list before search.
- **Secrets and vault documents are never indexed**, and local-only material never enters the cloud index.
- **Restrictions apply at once**: deleting a note, making it sensitive or local-only, or narrowing a token deletes or moves the affected chunks and vectors in the same transaction, before any re-index job runs. Every search hit is also re-checked against the note's current class and the caller's current scopes before ranking. A short gap in search results during the re-index is accepted; a leak isn't.
- **Tested with canaries**: fixture values planted in sensitive fields must never appear in any tool output, snippet, embedding neighbor or cache entry for a principal without access.

## Ingest

`mutation commits` → `job in outbox` → `extract` → `normalize` → `chunk by class` → `embed` → `install if rev matches`

- **Extract**: `toMarkdown`. A page that fails a confidence check (garbled text, a table with no numbers) is marked "needs reading", and the next agent that files it reads the page image through `get`, but only for files cleared as not vault documents. Every value keeps its page.
- **Normalize**: front-matter is flattened into readable text ("IELTS Academic overall 8.0, writing 7.0, expires 2028-11-02") so fields are searchable as text too.
- **Chunk**: a short note is one chunk; a long one, one chunk per H2; a file, one per page. A template header names the note and type ("[TestScore · IELTS Academic, Nov 2026]"), with no model call.
- **Embed**: multilingual bge-m3 (Workers AI), stored as int8 with the model name. Changing models re-embeds in the background while FTS carries search.
- **Local copies** receive the cloud's vectors for the notes they hold. Online, the question is embedded by the cloud, so local and cloud rankings match. Sensitive notes a device doesn't hold (the default) are answered by `brainiac mcp serve` forwarding to the DO when online, and marked "cloud-only on this device" when offline; their chunks and vectors never sync to a device that hasn't opted in. Offline, and for local-only notes, search is keyword-only, and results say so. The parity test covers both device settings.
- **Language check**: FTS5's `unicode61` tokenizer is tested on Bangla, Hindi and Arabic before launch; if it fails, those fields also get a trigram index.

## Retrieve and answer

| Route      | When                                   | How                                                                                          | Model call |
| ---------- | -------------------------------------- | -------------------------------------------------------------------------------------------- | ---------- |
| **field**  | "my IELTS writing score"               | `query` on fields                                                                            | none       |
| **list**   | "all my published papers"              | Filter + sort                                                                                | none       |
| **graph**  | "what's missing for TUM"               | Requirement checks + edges                                                                   | none       |
| **search** | "my work on transit apps"              | FTS5 + exact vector top-k, merged by reciprocal rank fusion, plus one hop of graph neighbors | none       |
| **open**   | "which of my projects fit an NLP PhD?" | search, then whole notes to the model                                                        | yours      |

- **Routing is plain rules**: field names and glossary terms in the question, list words, application names. No model is needed to route.
- **Context**: whole notes rather than fragments, capped at about 20k tokens, with `me.md`, decisions and the schema first. Loading a whole small record instead of retrieving is an option the evals must prove, not a default.
- **Citations name the exact field**: `ielts-2026-11#sections.writing@2` or `transcript-bsc.pdf#p1`. Answers use the current revision unless you asked about history. Values from fields nobody verified are labeled _unverified_.
- **What `verify` guarantees, exactly**: the agent sends its text plus a list of claims, each `{note, field, value}`. Every claim must equal that field at the **current** revision (or the named revision when you asked about history), so "writing 8.5" claimed against `sections.writing` fails when the field holds 7.0. As a cheap safety net, numbers and dates in the text not covered by any claim come back as "uncited". Everything else in the prose ("I was accepted", "a strong background in NLP") is not verified, and Brainiac doesn't claim it is. The checks confirm claims match the record; they don't certify the record.

## Who writes the answer

| Where                                                     | Model                                                                                                                                                                | How exactness is kept                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **In your Claude** (MCP: Claude Code, claude.ai, T3 Code) | Yours, on your subscription                                                                                                                                          | `ask` returns the context, the canonical field values and the citation list, not prose. The skill tells the agent to quote values as given and cite them. `ask {mode: "verify", text, claims}` checks a draft's explicit claims against current field values, flags uncited numbers and dates, and returns mismatches to fix |
| **On the site**                                           | The command palette answers field, list and graph questions itself (no model). Open questions get "Open in Claude", which hands them off with the connector attached | Deterministic routes are exact by construction                                                                                                                                                                                                                                                                               |

Rerankers are added only if the retrieval eval shows a real gain.

Measured by the `retrieval` and `answers` evals (see "Quality bar"): recall@8, citation precision, exact-field accuracy (must be 100% of shown values), and refusal correctness, local and cloud.
