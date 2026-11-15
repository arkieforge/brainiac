# answers

Whether a real model answering from the record quotes it exactly (#22). The person asks their own Claude a
question about themself; the answer must give the record's value as stored, say "unverified" by a value the
person never checked, and say "not in your record" when it isn't there, never a typical value.

## How it runs

The fixture record is built once on node:sqlite and indexed as a laptop's copy is: keyword only, since no model
embeds questions here (hybrid ranking needs Workers AI on a deployed stage). Its connection reads everything,
sensitive notes included, as the person's own Claude would. Each sample is a fresh headless Claude Code run
(`claude -p <question>`) with the record's `/mcp`, served by the Worker's own tool server
(`packages/base/src/mcp.ts`), as its only MCP server, no built-in tools, none of this machine's settings,
and the agent skill (`apps/cli/plugin/skills/brainiac/SKILL.md`) appended to the system prompt, as the plugin
would load it. The case then checks the final answer.

| Case                      | Kind    | Exact | Fails when the answer                                                                  |
| ------------------------- | ------- | ----- | -------------------------------------------------------------------------------------- |
| `latest-writing-score`    | guard   | yes   | gives anything but 7.0 for the latest attempt, or 6.5 for March's, in prose or a table |
| `cgpa-unverified`         | guard   | yes   | doesn't give 3.82, gives a scale other than 4, or doesn't say it's unverified          |
| `ielts-expiry-unverified` | guard   | yes   | doesn't give 2028-11-02 (in any spelling), or doesn't say it's unverified              |
| `internship-end`          | guard   | yes   | doesn't give 2025-09-30 (in any spelling)                                              |
| `gre-not-in-record`       | guard   | yes   | doesn't say it isn't in the record, or gives a GRE-like score                          |
| `bsc-university`          | control | no    | doesn't name Northvale                                                                 |

Every exact case also fails on any number or date the record doesn't hold anywhere, read as `ask` verify reads them, a difference the model worked out ("up 0.5") included: an exact answer quotes values. Exact-value cases fail on any
failing sample; the control fails when half or more do, with a 3rd sample when two disagree. The graders and
the verdict rule have tests (`cases.test.ts`), which CI runs.

The graders are frozen: they change only when a real answer from a paid run is graded wrong, or a review shows a
wrong answer passing on phrasing a model plausibly writes, with that answer added to `cases.test.ts`. Their known limits:

- These fail a correct answer: a sentence that names both attempts with two writing scores and no "from" (it
  can't be paired, so it fails rather than guess); "a 7.0 writing band" (a number before "writing" is read only
  with "in", "for" or "on" between); "You verified the scores, but not the expiry date"; a month given before the
  exact date ("in September 2025 (2025-09-30)"); and, in the internship case, a later sentence giving another 2025
  date (another note's, like the BSc's end), which reads as a correction; a range placed before "scale" ("on a 0-4
  scale") or after "scale from" ("on a scale from 0 to 4"), whose 0 reads as a made-up number; and "You haven't verified 3.82 yet", which reads as denying the value.
- These let a wrong answer pass: every day and month in the record counts as a number it holds, so a made-up
  number from 1 to 31 isn't caught as invented; and any "n't ... checked" counts as the unverified label, so
  "it hasn't changed since you checked it" passes. Context hands the model `verified: false` and the skill says to
  write "unverified", so neither has shown up in a real answer.

The exact values themselves are each case's own check.

## Running it

```sh
vp run eval:answers --out evals/runs/answers                  # 2 samples a case, Claude Code's default model
vp run eval:answers --out evals/runs/answers --model <id> --case cgpa-unverified --samples 3
vp run eval:answers --out evals/runs/answers --dry-run        # no model: prints the cases and the tools
```

It needs `claude` on PATH, signed in: runs bill the subscription or key that Claude Code uses, and each sample
is one short question, so a full run costs what its `summary.md` says (the sum of each run's result event).
`--out` gets each sample's events (`<case>-<n>.ndjson`), its answer and tool calls (`<case>-<n>-said.txt`),
`results.ndjson` and `summary.md`. `--baseline` and `--context` arrive with the shared harness (#27).

## Adding a case

A case is a question the fixture student could ask and a check on the answer, with its source and kind, in
[`cases.ts`](cases.ts). Use only the fixture student's values, and mark it exact when a wrong value is the
failure.
