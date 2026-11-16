# review-detectors

How often review's "looks wrong" flags ([review](../../docs/product/features/review.md)) catch a real mistake, and
how often they flag something that isn't one. The detectors (`detect` in `packages/core/src/review.ts`) are
deterministic, so this eval calls no model and runs in CI with the other tests.

## How it runs

Each case is a copy of the fixture record (`fixtures/nadia`, the fictional student) with one change: a `bad` case
puts in a mistake a person really makes and names the flags it should raise; a `control` makes an edit that only
looks like a mistake and names none. Only the flags a copy adds to the fixture's own count: those are named in
`FIXTURE_FLAGS` (its role and paper have no document behind them), not read from the detectors, so a false alarm
the unchanged fixture raises too still counts. On a fixed day, 2026-11-15, so a date
means the same thing every run.

- **Recall**: bad cases caught, where caught means every flag the case names was raised.
- **Precision**: new flags a case named, out of every new flag, controls included.

| Gate                                          | Floor  |
| --------------------------------------------- | ------ |
| Recall: seeded errors flagged                 | >= 0.9 |
| Precision: new flags that name a seeded error | >= 0.9 |

Cases cover values that can't be (a CGPA over its scale, an end before a start, an IELTS band that isn't one or
isn't its sections' band, a TOEFL band of 7.5, a GRE on the old scale), a note against its own document, an expired
score still counted for the open application, the same item filed twice, one name spelled two ways, facts with
nothing behind them, a check over a year old, and LinkedIn out of date.

## Known gaps

The cases the detectors get wrong today, which `cases.test.ts` pins so the numbers move only on purpose:

| Case                           | What happens                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `test-date-in-the-future`      | missed: no detector looks for a taken test's date after today                 |
| `toefl-total-off-its-sections` | missed: only IELTS checks its overall against its sections                    |
| `stamford-and-stanford`        | false alarm: two real universities a letter apart are flagged as one misspelt |

## Running it

```sh
vp test run evals/review-detectors                                  # the gates, as CI runs them
vp run eval:review-detectors --out evals/runs/review-detectors      # also writes results.ndjson and summary.md
vp run eval:review-detectors --out evals/runs/review-detectors --case cgpa-over-scale
```

It needs nothing signed in and costs nothing.

## Adding a case

A case goes in `CASES` in `cases.ts` with its source: write it from a mistake people make, before looking at
what the detectors can see. A `bad` case names every flag it should raise as `<path> <detector> <field>`,
including true flags that follow from the change (a copied note has no document behind it either). A new gap
goes in the table above and in `cases.test.ts`; when a detector closes one, take it out of both.
