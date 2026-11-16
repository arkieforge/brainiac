# structure

Whether something new the person tells their own Claude lands as the right type in the right folder (#152): a new
role, score or paper becomes a note of the fixture schema's type, in that type's folder, with the values they gave,
and the model never invents a type the schema doesn't have.

## How it runs

Each sample is a fresh fixture record on node:sqlite (every case adds to it) and a fresh headless run of the shared
harness's runner ([the harness](../README.md#the-shared-harness)) with the record's `/mcp` as its only MCP server and
the agent skill. The connection is the person's own Claude's: write, the sensitive scope, no hold. After the run the
eval reads every note the run added, live or waiting in an open proposal, and checks it with the case.

| Case                  | Kind    | Fails when the run                                                                     |
| --------------------- | ------- | -------------------------------------------------------------------------------------- |
| `new-role`            | guard   | files no Role at Northvale with the research assistant title and the 2026-10-01 start  |
| `new-score`           | guard   | files no TestScore with test `gre`, overall 325 and the 2026-10-20 date                |
| `new-paper`           | guard   | files no Paper with the DOI it was given and author position 2                         |
| `job-is-a-role`       | control | files no Role at Fleetwise Robotics starting 2026-11-02 (not a Job or Employment type) |
| `toefl-is-a-score`    | control | files no TestScore with test `toefl-ibt`, overall 110 and the 2026-09-12 date          |
| `preprint-is-a-paper` | control | files no Paper with the DOI it was given and author position 1 (not a Preprint type)   |

Every case also fails when the run:

- calls `create` with a type the schema doesn't have, even one the record refused, or `organize` with types to add;
- adds a note of another type (a `Fact`, say), except the questions it asks alongside;
- files the note outside its type's folder (`facts/roles/` for a Role);
- only asks: every prompt gives what its note needs, so asking is never a pass here, and `request_info` without the
  note fails.

The controls are ordinary news that fits a type the schema has, worded so a model reaching for a new type would
make one up; they catch the skill's "New kinds of info" rule being over-applied. Its other side, news that fits no
type going through `organize`, is `mcp-tool-use`'s `new-kind-through-organize`.

A case fails when half or more of its samples fail, with a 3rd sample when two disagree. The quality bar sets no
release gate for this eval. The grader has tests (`cases.test.ts`), which CI runs.

## Running it

```sh
vp run eval:structure --out evals/runs/structure                  # 2 samples a case, Claude Code's default model
vp run eval:structure --out evals/runs/structure-sol --model gpt-6.1-sol
vp run eval:structure --out evals/runs/structure --dry-run        # no model: prints each case's command
vp run eval:structure --out evals/runs/structure --context        # no model: the size of what the model sees
```

## Adding a case

Add it to `CASES` in `cases.ts` with its source, kind, prompt and the note it must file (`files`: a type and its
fields, matched as `mcp-tool-use` matches args, `"~text"` a case-insensitive substring), and the note a right run
leaves to `RIGHT` in `cases.test.ts`. Use only the fixture student.

## Cost

A sample is one headless run that calls `describe` and `create` and maybe `query`; see a run's `summary.md` for its
tokens and, on Claude Code, its cost.
