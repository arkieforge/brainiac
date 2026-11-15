# Evals

An eval runs a real model against Brainiac's real model-facing text and scores what it does. Use one where
a unit test can't help: model output changes from run to run, and a small wording change can move it.

Write or run an eval when a change affects what a model sees: MCP tool descriptions and schemas, tool
results, the agent skill, or prompts. The planned evals and their release gates are in
[docs/operations/quality-bar.md](../docs/operations/quality-bar.md).

The shared harness is issue #27 (M1). The evals so far are [`filing`](filing/README.md) and
[`answers`](answers/README.md); every eval follows this shape:

- `evals/<eval>/run.ts` is the entry point, with a script of the same name in `package.json`.
- `evals/<eval>/README.md` says what it measures, how to run it, how to add a case, and what a run costs.
- Cases are data (`cases/*.ndjson` or `cases.ts`). Each has an `id`, its source (an issue, a PR, a real
  mistake), a `kind` (`bad`, `guard`, `control`) and its checks.
- The eval imports tool descriptions, prompts and schemas from source. Never copy them into an eval.
- The world is the fixture record running in `packages/base` on SQLite, so tools return real results.
- Flags: `--out <dir>` (required), `--model`, `--case`, `--samples` (default 2, a 3rd on disagreement),
  `--baseline <results>`, `--dry-run`, `--context`.
- A run writes result rows and a `summary.md` with its cost to `--out` (`evals/runs/` is gitignored).

## Rules for cases

- A case reproduces a real bad experience or guards a good one, and names its source.
- Add a `bad` case before the fix. It must fail on the old text and pass on the new. `guard` and `control` cases pass on both.
- Add controls: ordinary work where the right action is simple. They catch over-correction.
- Model output varies: a case fails when half or more of its samples fail, except exact-value and canary
  cases, which fail on any failing sample.
- Only the fictional fixture student. No real personal data, ever.
- Run the cases your change touches; a full run per supported model before each release.
