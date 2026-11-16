// The review detectors' eval, whole: the detectors are deterministic, so CI runs every case and holds the release
// gates (docs/operations/quality-bar.md#release-gates) here, not in a paid run.
import { describe, expect, it } from "vite-plus/test";

import { CASES, DETECT, measure, type Detect } from "./cases.ts";

/** Detectors gone quiet: nothing flags a value that can't be. */
const blind: Detect = (notes) => DETECT(notes).filter((c) => c.detector !== "impossible");
/** Detectors flagging what isn't wrong: every note's title read as a misspelling. */
const noisy: Detect = (notes) => [
  ...DETECT(notes),
  ...notes.map((n) => ({
    noteId: n.id,
    detector: "spelling" as const,
    field: "title",
    evidence: "",
    related: [],
  })),
];

/** Detectors flagging what isn't wrong on the fixture itself, so on every copy: the internship checked long ago. */
const noisyEverywhere: Detect = (notes) => [
  ...DETECT(notes),
  ...notes
    .filter((n) => n.path === "facts/roles/acme-intern-2025.md")
    .map((n) => ({ noteId: n.id, detector: "stale" as const, evidence: "", related: [] })),
];

describe("review detectors eval", () => {
  const { results, gates } = measure(CASES);

  it("holds recall and precision at the quality bar's floors", () => {
    expect(gates.map((g) => [g.name, g.measured, g.ok])).toEqual([
      ["Recall: seeded errors flagged", "0.92 (23/25)", true],
      ["Precision: new flags that name a seeded error", "0.95 (39/41)", true],
    ]);
  });

  it("gets wrong only the cases the README lists as gaps", () => {
    // A detector that closes a gap takes it out of this list and the README's; one that loses a case adds it.
    // The fixture's own flags (its role and paper have no document) are no case's false alarm.
    expect(results.filter((r) => !r.ok).map((r) => [r.id, r.missed, r.falseAlarms])).toEqual([
      ["test-date-in-the-future", ["facts/tests/ielts-2026-11.md impossible date"], []],
      ["toefl-total-off-its-sections", ["facts/tests/toefl-2026-09.md impossible overall"], []],
      ["stamford-and-stanford", [], ["people/r-haque.md spelling org", "people/l-chen.md spelling org"]],
    ]);
  });

  it("fails under the recall floor when the detectors go quiet", () => {
    const [recall, precision] = measure(CASES, blind).gates;
    expect(recall).toMatchObject({ ok: false, measured: "0.52 (13/25)" });
    expect(precision?.ok).toBe(true);
  });

  it("fails under the precision floor when the detectors flag what isn't wrong", () => {
    const [recall, precision] = measure(CASES, noisy).gates;
    expect(recall?.ok).toBe(true);
    expect(precision?.ok).toBe(false);
    // A false alarm the unchanged fixture raises too is no less false.
    expect(measure(CASES, noisyEverywhere).gates[1]?.ok).toBe(false);
  });
});
