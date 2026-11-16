# retrieval

Whether search finds what the record holds (#151): each golden question over the fixture student's record names
the notes that answer it, and the eval asks it through every route an agent uses and scores the first 8 notes each
answer shows. No model answers, so a run is exact and the same every time.

## What it measures

| Route    | The call                                              | What counts, best first          |
| -------- | ----------------------------------------------------- | -------------------------------- |
| `query`  | the case's `query` (where fields can ask it), limit 8 | the rows                         |
| `search` | the words an agent would search for, limit 8          | the hits, then the related notes |
| `ask`    | `ask` context with the person's own question, limit 8 | the context's notes              |

- **Recall@8**: of all the answering notes a route was asked for, the share in its first 8.
- **Citation precision**: of the notes in those first 8, which an answer may cite, the share that answer. It is
  reported, not gated: on a 10-note record, meaning ranks every note, so a hybrid route always shows 8.

A `control` case shares words with the notes that answer it. A `guard` is a paraphrase ("my English language exam"
for an IELTS score) that shares none of the words that matter: the unit tests hold that keyword search misses every
guard, so the set never holds only what keyword search already finds, and that `query` finds every case's answers
and keyword `ask` every control's.

The connection is the person's own Claude's: read, with the sensitive scope.

## Running it

```sh
vp run eval:retrieval --out evals/runs/retrieval                 # keyword-only, as a laptop's copy offline
doppler run --project braniac --config dev -- vp run eval:retrieval --out evals/runs/retrieval --hybrid
vp run eval:retrieval --out evals/runs/retrieval --case english-exam
```

Keyword-only calls nothing and is what CI runs; it reports what offline search loses (most guards) and has no gate,
since offline answers say they are keyword-only. `--hybrid` is the cloud's ranking: it embeds every chunk and
question with `@cf/baai/bge-m3` on Workers AI (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`) exactly as the
record's jobs and `ask` do, then runs the same `packages/base` search the Durable Object runs. A hybrid run fails
when any route's recall@8 is under 0.95 (`shared/gates.ts`). It costs well under a cent of Workers AI neurons.
`--out` gets `results.ndjson` (one row per case and route, with the ids shown) and `summary.md`.

## Adding a case

A case goes in `CASES` with its source, kind, the question, the notes that answer it (fixture ids), the words to
search and a `query` when fields can ask it. Add a guard for every kind of thing a person might ask in other words.
Only the fixture student.
