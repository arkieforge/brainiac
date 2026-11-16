# mcp-tool-use

Whether the person's own Claude (or Codex) uses Brainiac's MCP tools the way the agent skill asks (#54): `describe`
first, `query` before `search`, update rather than create a near copy, a new event as a new note, `ask verify`
before giving numbers, the tools rather than the files on disk, `request_info` rather than a guess, and stored values
quoted exactly.

## How it runs

Each sample is a fresh fixture record on node:sqlite (cases change it) and a fresh headless run of the shared
harness's runner ([the harness](../README.md#the-shared-harness)): `claude -p <prompt>`, or `codex exec` for a
`gpt-*` model, with the record's `/mcp` as its only MCP server and the agent skill. The connection is the person's
own Claude's: write, the sensitive scope, no hold. Every tool call reaches the record, so no result is mocked and no
model plays the server.

A `native` case also gives the model its own shell and file tools, working in a throwaway copy of the fixture vault
(`fixtures/nadia`): Claude Code with `Bash, Read, Edit, Write, Glob, Grep`, `--restricted` confining the file tools
to the copy and its sandbox confining commands, and Codex in its `workspace-write` sandbox there. Neither has the
plugin's hook, so the case measures the model's own choice.

## Cases

Cases are [`cases.ndjson`](cases.ndjson), one a line, each naming its source. Tool names are Brainiac's bare names
(`update`) or a harness's native ones (`Edit`, `Bash`); Codex's calls arrive under the same names, its `apply_patch`
as `Edit`. Checks:

- `first`: the first Brainiac call.
- `calls` / `callsMustNot`: `{tool, args}`, where `args` matches by value, `"~text"` as a case-insensitive substring
  of the value, an array by each item, and an object key as a dotted path. A call the record refused did nothing,
  so it never satisfies `calls`; it still counts against `callsMustNot`.
- `before`: `[a, b]`, if `b` was called, `a` was called before it.
- `record`: `{note or type, field, value}`, a value the record holds after the run, in a live note or in an open
  proposal waiting for the person, so a change is graded by what it did, not just that a call was made.
- `finalTextMust` / `finalTextMustNot`: case-insensitive regexes on the final answer.
- `answer`: an [`answers`](../answers/README.md) case whose grader the final answer must pass. The exact-value
  canaries use it, so they are held to those tested checks (the value, its field, its unverified label, and no
  number the record doesn't hold) rather than to a regex.
- `noVaultWrites`: no `Edit` or `Write`, and no shell command that changes files (`rm` or `/bin/mv`, `sed -i`, a
  redirect, a script) or reads `facts/tests`, `documents/files`, `unorganized` or `inbox`.

| Case                               | Kind    | Fails when the run                                                                       |
| ---------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `describe-first`                   | guard   | calls another Brainiac tool before `describe`, or doesn't name the Swahili NER paper     |
| `query-before-search`              | guard   | doesn't `query` Roles, or searches before it does                                        |
| `update-not-create`                | guard   | creates a note, or the Acme note doesn't end up with the new title                       |
| `new-event-new-note`               | guard   | writes the new band into an existing attempt, or creates no TestScore with overall 8.5   |
| `verify-before-numbers`            | guard   | gives the band and expiry without `ask {mode: "verify"}`                                 |
| `no-direct-file-writes`            | guard   | touches the vault's files (above), or the Acme note doesn't end up with the new end date |
| `request-info-instead-of-guessing` | guard   | sets anything on the paper note, or no `request_info` went through                       |
| `cgpa-canary`                      | guard   | fails the answers eval's `cgpa-unverified` check (exact)                                 |
| `ielts-writing-canary`             | guard   | fails the answers eval's `latest-writing-score` check (exact)                            |
| `approval-link`                    | bad     | doesn't `update` the IELTS note, creates a note, or gives no `/approvals/` link          |
| `supervisor-control`               | control | doesn't name Dr Okafor                                                                   |

Exact cases fail on any failing sample; the others when half or more do, with a 3rd sample when two disagree. The
run's gates: at least 0.90 of samples pass (the quality bar's floor for this eval), no exact sample fails, and with
`--baseline`, no case that passed every earlier sample fails one now. The grader has tests (`cases.test.ts`) that
hold each case to the mistake it names, which CI runs.

`approval-link` is the one `bad` case (#131): before, a `needsApproval` result carried no link, so no run could give
one. The others guard rules the skill and the tool descriptions already teach. Run with the skill left out, Opus
still passed 9 of those 10, since the tool descriptions carry most of the same rules; only
`request-info-instead-of-guessing` failed.

## Running it

```sh
vp run eval:mcp-tool-use --out evals/runs/tool-use --case cgpa-canary --samples 1   # check the setup
vp run eval:mcp-tool-use --out evals/runs/opus --model opus
vp run eval:mcp-tool-use --out evals/runs/sol --model gpt-6.1-sol --baseline evals/runs/opus/results.ndjson
vp run eval:mcp-tool-use --out evals/runs/tool-use --dry-run   # no model: each case's command
vp run eval:mcp-tool-use --out evals/runs/tool-use --context   # no model: the size of what the model sees
```

It needs `claude` (or `codex` for a `gpt-*` model) on PATH, signed in: runs bill that harness's subscription or key.
`--out` gets each sample's events (`<case>-<n>.ndjson`), its answer and tool calls (`<case>-<n>-said.txt`),
`results.ndjson` and `summary.md`.

## Full runs

Full runs before this eval shipped, 2 samples a case (a 3rd on disagreement), on 2026-11-16:

| Model             | Tasks completed | Canaries    | Failing samples                                                         | Cost or tokens                     |
| ----------------- | --------------- | ----------- | ----------------------------------------------------------------------- | ---------------------------------- |
| claude-opus-5-5   | 0.95 (20/21)    | 0/4 failing | `request-info-instead-of-guessing` 1/3: asked in chat instead           | $1.66                              |
| claude-sonnet-5-5 | 1.00 (20/20)    | 0/4 failing | none                                                                    | $0.92                              |
| gpt-6.1-sol       | 0.95 (20/21)    | 0/4 failing | `new-event-new-note` 1/3: stopped at the dry run, then asked to approve | 413k input, 7k output, 1.2M cached |

Every case passed on every model. An earlier Sonnet run failed one `cgpa-canary` sample on a correct answer ("3.82
on a scale of 4. That's for your BSc ... Neither value has been verified by you."), which the answers grader read as
unlabeled; that answer is now one of its tests, and the run above is on the fixed grader.

## Adding a case

Add a line to `cases.ndjson` with its source, and a row to the table in `cases.test.ts` with a run that makes the
mistake and one that doesn't. Use only the fixture student. A `bad` case goes in before its fix, failing on the old
text and passing on the new.
