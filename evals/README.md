# Evals

An eval runs a real model against Brainiac's real model-facing text and scores what it does. Use one where
a unit test can't help: model output changes from run to run, and a small wording change can move it.

Write or run an eval when a change affects what a model sees: MCP tool descriptions and schemas, tool
results, the agent skill, or prompts. The planned evals and their release gates are in
[docs/operations/quality-bar.md](../docs/operations/quality-bar.md).

The evals so far are [`filing`](filing/README.md), [`answers`](answers/README.md),
[`photos`](photos/README.md), [`mcp-tool-use`](mcp-tool-use/README.md), [`drafts`](drafts/README.md),
[`review-detectors`](review-detectors/README.md) and [`retrieval`](retrieval/README.md); every eval follows this shape
(retrieval runs no model, so it takes only `--out`, `--case` and `--hybrid`):

- `evals/<eval>/run.ts` is the entry point, with a script of the same name in `package.json`.
- `evals/<eval>/README.md` says what it measures, how to run it, how to add a case, and what a run costs.
- Cases are data (`cases/*.ndjson` or `cases.ts`). Each has an `id`, its source (an issue, a PR, a real
  mistake), a `kind` (`bad`, `guard`, `control`) and its checks.
- The eval imports tool descriptions, prompts and schemas from source. Never copy them into an eval.
- The world is the fixture record running in `packages/base` on SQLite, so tools return real results.
- Flags: `--out <dir>` (required), `--model`, `--case`, `--samples` (default 2, a 3rd on disagreement),
  `--baseline <results>`, `--dry-run`, `--context`.
- A run writes result rows and a `summary.md` with its cost to `--out` (`evals/runs/` is gitignored).
- Graders are plain functions with a `cases.test.ts` beside them. CI runs those tests and each eval's
  `--dry-run`; paid runs stay on the team's own subscriptions. `review-detectors` calls no model, so
  its whole run is a test and CI holds its gates.

## The shared harness

Every eval builds on [`shared/`](shared/), so a new one writes only its cases and graders:

- `world.ts`: the fixture record in `packages/base` on node:sqlite, a connection at any level, inbox items, and
  the record's `/mcp` on a local port, served by the Worker's own tool server.
- `runners.ts`: the models users bring, on the runner's own sign-in. `--model gpt-*` runs `codex exec`, anything
  else (or none) `claude -p`. Each run has Brainiac's `/mcp` as its only MCP server and the agent skill, and none
  of the machine's settings, instructions, hooks, plugins or skills: Claude Code through `--restricted
  --strict-mcp-config`, Codex through a throwaway `CODEX_HOME` that shares only the sign-in, with its plugins,
  apps, web search and shell turned off. Both report tool calls under Claude Code's names (`mcp__brainiac__ask`,
  `Bash`, `Edit` for Codex's `apply_patch`). A run whose harness reports a model other than the one asked for
  throws rather than grading a cheaper model's answer.
- `sampling.ts`: the verdict rule and the 3rd sample on disagreement.
- `cli.ts`: the flags, `--dry-run` (prints the exact command, the token left out, and calls no model),
  `--context` (the size of every tool's description and schema, the skill and the prompts, estimated at 4
  characters a token), and the report: `results.ndjson` and `summary.md` with the model that answered, token use,
  cost when the harness reports one (Codex doesn't), the gates, and with `--baseline <results.ndjson>` each
  case's earlier pass rate, marking a case that passed every earlier sample and now fails as a regression.
- `gates.ts`: the release gates below.

## Release gates

A run checks the [release gates](../docs/operations/quality-bar.md#release-gates) its eval measures, through
[`shared/gates.ts`](shared/gates.ts), and fails when one misses its floor, as a failing case does. Its
`summary.md` has a gate table. Gates so far:

| Eval               | Gate                                                                           | Floor              |
| ------------------ | ------------------------------------------------------------------------------ | ------------------ |
| `answers`          | Exact-value cases                                                              | no failing sample  |
| `answers`          | Answerability: questions the record answers get their answer (the case passes) | >= 0.95 of samples |
| `filing`           | Guards (the injection corpus never gets past the approval list)                | no failing sample  |
| `photos`           | Guards (a photo the person didn't share never reaches the agent)               | no failing sample  |
| `mcp-tool-use`     | Tasks completed correctly                                                      | >= 0.90 of samples |
| `mcp-tool-use`     | Exact-value canaries                                                           | no failing sample  |
| `mcp-tool-use`     | No regression on any case (with `--baseline`)                                  | none               |
| `drafts`           | Drafts: started from `draft`, verify ok, no invented value, house rules kept   | no failing sample  |
| `review-detectors` | Recall: seeded errors flagged                                                  | >= 0.90            |
| `review-detectors` | Precision: new flags that name a seeded error                                  | >= 0.90            |
| `retrieval`        | Recall@8 per route (query, search, ask context), on a `--hybrid` run           | >= 0.95            |

Answerability exists because over-refusal invents no number: an answer that says "not in your record" to
every question would pass a check that only looks for wrong values. It counts a sample as answered only when its
case passed, so a refusal in any wording counts against it. A run of some cases (`--case`) checks only the gates
those cases measure.

## Rules for cases

- A case reproduces a real bad experience or guards a good one, and names its source.
- Add a `bad` case before the fix. It must fail on the old text and pass on the new. `guard` and `control` cases pass on both.
- Add controls: ordinary work where the right action is simple. They catch over-correction.
- Model output varies: a case fails when half or more of its samples fail, except exact-value and canary
  cases, which fail on any failing sample.
- Only the fictional fixture student. No real personal data, ever.
- Run the cases your change touches; a full run per supported model before each release.
