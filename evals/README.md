# Evals

An eval runs a real model against Brainiac's real model-facing text and scores what it does. Use one where
a unit test can't help: model output changes from run to run, and a small wording change can move it.

Write or run an eval when a change affects what a model sees: MCP tool descriptions and schemas, tool
results, the agent skill, or prompts. The planned evals and their release gates are in
[docs/operations/quality-bar.md](../docs/operations/quality-bar.md).

The evals so far are [`filing`](filing/README.md), [`answers`](answers/README.md) and
[`photos`](photos/README.md); every eval follows this shape:

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
  `--dry-run`; paid runs stay on the team's own subscriptions.

## Release gates

A run checks the [release gates](../docs/operations/quality-bar.md#release-gates) its eval measures, through
[`shared/gates.ts`](shared/gates.ts), and fails when one misses its floor, as a failing case does. Its
`summary.md` has a gate table. Gates so far:

| Eval      | Gate                                                                       | Floor              |
| --------- | -------------------------------------------------------------------------- | ------------------ |
| `answers` | Exact-value cases                                                          | no failing sample  |
| `answers` | Answerability: questions the record answers don't get "not in your record" | >= 0.95 of samples |
| `filing`  | Guards (the injection corpus never gets past the approval list)            | no failing sample  |

Answerability exists because over-refusal invents no number: an answer that says "not in your record" to
every question would pass a check that only looks for wrong values.

## Rules for cases

- A case reproduces a real bad experience or guards a good one, and names its source.
- Add a `bad` case before the fix. It must fail on the old text and pass on the new. `guard` and `control` cases pass on both.
- Add controls: ordinary work where the right action is simple. They catch over-correction.
- Model output varies: a case fails when half or more of its samples fail, except exact-value and canary
  cases, which fail on any failing sample.
- Only the fictional fixture student. No real personal data, ever.
- Run the cases your change touches; a full run per supported model before each release.
