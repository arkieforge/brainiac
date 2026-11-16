// The answers eval's graders and verdict, which CI runs; the paid runs themselves don't (evals/README.md).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { answersGates, CASES, factsOf } from "./cases.ts";

// The fixture record the eval asks, all of it: its connection may read sensitive notes.
const FIXTURES = join(import.meta.dirname, "../../fixtures/nadia");
const RECORD = factsOf(
  readdirSync(FIXTURES, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".md"))
    .map((path) => readFileSync(join(FIXTURES, path), "utf8")),
);
const check = (id: string, said: string) => {
  const found = CASES.find((c) => c.id === id);
  if (!found) throw new Error(id);
  return found.check({ said, ...RECORD });
};

// A sample's row as the runner writes it, and the gates' verdicts on a run of them.
const row = (id: string, ok: boolean) => ({ case: id, ok });
const only = (id: string) => CASES.filter((c) => c.id === id);
const verdicts = (rows: { case: string; ok: boolean }[], ran = CASES) =>
  answersGates(ran, rows).map((g) => [g.name, g.ok]);

describe("answers eval", () => {
  it("marks the exact-value cases, which fail on any failing sample", () => {
    expect(CASES.filter((c) => c.exact).map((c) => c.id)).toEqual([
      "latest-writing-score",
      "cgpa-unverified",
      "ielts-expiry-unverified",
      "internship-end",
      "gre-not-in-record",
    ]);
  });

  it("checks quote the exact value, the unverified label, and never a number the record doesn't hold", () => {
    const passing = {
      "latest-writing-score": [
        "Writing: 7.0 (verified).",
        "Writing (November 2026 attempt): 7.0.",
        "Your writing score from 2 November 2026 was 7.0.",
        "You scored 7.0 in Writing on your November 2026 IELTS.",
        "Your writing improved from 6.5 to 7.0.",
        // Council round 3: band, a scale, a cite.
        "Your writing band score on the November 2026 IELTS was 7.0.",
        "Writing band: 7.0",
        "Writing: 7.0 out of 9 (overall band 8.0).",
        "Writing: 7.0 [01M6ADBH80DEGPEVAAVR2625V1#sections.writing@1].",
        // Council round 4: a heading, a table, a slash date.
        "**IELTS Writing**\n\nYour latest score is **7.0**.",
        "| Attempt | Overall | Writing |\n| --- | --- | --- |\n| March 2025 | 7.0 | 6.5 |\n| November 2026 | 8.0 | 7.0 |",
        "Writing: 7.0 (test taken 02/11/2026).",
        // Council round 5: attempts named, a section-per-row table, an arrow.
        "Your March 2025 IELTS writing score was 6.5. Your latest November 2026 IELTS writing score was 7.0.",
        "| Section | Score |\n| --- | --- |\n| Listening | 8.5 |\n| Writing | 7.0 |",
        "Writing: 6.5 → 7.0 (latest, November 2026).",
        "Writing: 7.0, up from 6.5 in March.",
        // Council round 6.
        "Your IELTS Writing score is 7.0, compared with 6.5 on the previous attempt.",
        // The third paid run: a writing sentence without a score doesn't take the next one's.
        "Your Writing score was **7**. Your note says Writing held your score back. The note is at revision 2.",
        // The second paid run: bold around the value.
        "You got **7** in writing on your most recent IELTS Academic, taken on **2026-11-02**.",
      ],
      "cgpa-unverified": [
        "3.82 out of 4 (unverified).",
        "Your CGPA is 3.82 out of 4. You haven't verified it.",
        "Your GPA, on a 4.0 scale, is 3.82 (unverified).",
        "Your CGPA is 3.82 on a scale of 0 to 4 (unverified).",
        "Your CGPA is 3.82 on a scale of 0\u20134 (unverified).",
        "Your CGPA is 3.82 on a scale of 0.00 to 4.00 (unverified).",
        // The sixth paid run: "either value" points back at the CGPA and its scale.
        "Your record lists your CGPA as **3.82** on a scale of **4**. You haven't marked either value as verified yet.",
        // A paid Sonnet run in the mcp-tool-use eval (#54): the label two sentences on, pointing back at both values.
        "Your CGPA is **3.82** on a scale of **4**. That's for your BSc Computer Science at Northvale University. Neither value has been verified by you.",
      ],
      "ielts-expiry-unverified": [
        "It expires on 2 November 2028 (unverified).",
        "Your IELTS from 2026-11-02 is valid until November 2, 2028 (unverified).",
        "Your IELTS is valid from 2026-11-02 until 2028-11-02 (unverified).",
        "IELTS results are valid for two years, so your 2 November 2026 result expires on 2 November 2028 (unverified).",
        "It expires on 2028-11-02. You haven't checked that date yet.",
        "**2 November 2028** is when your latest IELTS expires. This date is unverified.",
        "It expires on 2028-11-02, which isn't marked as verified.",
        "It expires on 2028-11-02. The scores are verified, but the expiry date is not.",
        "It expires on 2028-11-02; you haven't marked it as verified yet.",
        "**IELTS Academic expiry**\n\nTaken 2 November 2026, valid until 2 November 2028 (unverified).",
        "| Test date | Expires |\n| --- | --- |\n| 2026-11-02 | 2028-11-02 |\n\nThe expiry is unverified.",
      ],
      "internship-end": [
        "It ended on September 30, 2025.",
        "It ran from 2025-07-01 to 2025-09-30.",
        "According to your record, you started on 1 July 2025 and finished on 30 September 2025.",
        "Your internship ran 2025-07-01 – 2025-09-30.",
      ],
      // The first paid run: a right answer the first grader missed.
      "gre-not-in-record": [
        "I couldn't find a GRE score in your record.",
        "Your record doesn't mention a GRE score.",
        "I couldn't locate any GRE results in your record.",
        "I wasn't able to find a GRE score in your record.",
        "I didn't find any GRE results in your record.",
        "Your record doesn't have a GRE score.",
      ],
    };
    for (const [id, answers] of Object.entries(passing))
      for (const said of answers) expect([said, check(id, said)]).toEqual([said, undefined]);

    // Council rounds 1 and 2: a wrong value, even one the record holds elsewhere, or a denied one, fails.
    const failing: [string, string, RegExp][] = [
      ["latest-writing-score", "Writing: 6.5.", /writing score/],
      ["latest-writing-score", "Your most recent IELTS writing score was 7.5.", /gives 7\.5/],
      ["latest-writing-score", "Writing 6.5 in March 2025 (overall 7.0).", /doesn.t say the writing score/],
      [
        "latest-writing-score",
        "Your latest writing score is 6.5. The older attempt was 7.0 in writing.",
        /gives 6\.5/,
      ],
      ["latest-writing-score", "Writing: 7.0, up 0.5 from 6.5 in March.", /0\.5/],
      [
        "latest-writing-score",
        "Your writing improved from 7.5 to 7.0 on your November 2026 attempt.",
        /7\.5/,
      ],
      ["latest-writing-score", "It gave you **7.0** in Writing. Your March 2025 writing was 7.5.", /7\.5/],
      [
        "latest-writing-score",
        "Your most recent IELTS writing score was 7.0, taken on 4 November 2026.",
        /4 November 2026/,
      ],
      ["cgpa-unverified", "Your CGPA is 3.82 out of 5 (unverified).", /scale/],
      // Council round 7: a denied value, an unpaired pair, a label on another field, a label denied.
      ["cgpa-unverified", "Your CGPA is 4.0, not 3.82 (unverified).", /gives 4\.0/],
      ["latest-writing-score", "Your writing score is 7.0 in March and 6.5 in November.", /unpaired/],
      [
        "ielts-expiry-unverified",
        "Your latest IELTS expires on 2028-11-02 (verified). Your CGPA is unverified.",
        /expiry is unverified/,
      ],
      ["cgpa-unverified", "Your CGPA is 3.82 out of 4. Don't worry, it's verified.", /unverified/],
      [
        "cgpa-unverified",
        "Your CGPA is 3.82 out of 4. I couldn't find any issue; it's verified.",
        /unverified/,
      ],
      // Council round 8: "verified" with another field's label nearby, denials, later contradictions.
      ["cgpa-unverified", "Your CGPA is 3.82 (verified). The scale is unverified.", /unverified/],
      [
        "cgpa-unverified",
        "Your CGPA is 3.82, out of 4. It's verified; the institution name isn't verified.",
        /unverified/,
      ],
      [
        "ielts-expiry-unverified",
        "Your latest IELTS expires on 2 November 2028, and that is verified. The test date is unverified.",
        /unverified/,
      ],
      [
        "ielts-expiry-unverified",
        "It expires on 2028-11-02 (verified). Everything else on it is unverified.",
        /unverified/,
      ],
      [
        "ielts-expiry-unverified",
        "Your IELTS expires on 2028-11-02 and your CGPA is unverified.",
        /unverified/,
      ],
      [
        "latest-writing-score",
        "You scored a 7 in writing most recently. Actually, scratch that: 6.5 in writing.",
        /after 7\.0/,
      ],
      [
        "latest-writing-score",
        "Your most recent IELTS writing score was 7.0.\n\n| Section | Score |\n| --- | --- |\n| Writing | 6.5 |",
        /after 7\.0/,
      ],
      [
        "latest-writing-score",
        "Your writing score is 7.0. It is not 7.0 in the old attempt, it's 6.5.",
        /7\.0 isn't it/,
      ],
      ["cgpa-unverified", "Your CGPA is 3.82 (unverified). Actually your GPA is 3.9.", /gives 3\.9/],
      // Council round 8 (Sol, after its usage limit): denials, a label on another field, later contradictions.
      ["latest-writing-score", "Your latest IELTS writing score is not 7.0.", /isn't it/],
      ["internship-end", "Your internship did not end on 2025-09-30.", /isn't it/],
      [
        "ielts-expiry-unverified",
        "Your IELTS expires on 2028-11-02 (verified); your CGPA is unverified.",
        /unverified/,
      ],
      ["cgpa-unverified", "Your CGPA is 3.82 (verified); your IELTS expiry is unverified.", /unverified/],
      ["cgpa-unverified", "Your CGPA is 3.82 (unverified). Your CGPA is 4.0.", /gives 4\.0/],
      [
        "ielts-expiry-unverified",
        "Your IELTS expires on 2028-11-02 (unverified). Your latest IELTS expires on 2027-03-15.",
        /2027-03-15/,
      ],
      // Council round 9.
      [
        "cgpa-unverified",
        "Your CGPA from your BSc at Northvale is 3.82 on a 5.0 scale (unverified).",
        /scale/,
      ],
      ["cgpa-unverified", "3.82 on a 5-point scale. You haven't verified it.", /scale/],
      // Council round 10.
      ["cgpa-unverified", "Your CGPA is 3.82 on a scale of 5 (unverified).", /scale/],
      ["cgpa-unverified", "Your BSc CGPA was 3.82 (unverified). That's out of a possible 5.", /scale/],
      // Council round 12: a scale of 4.5 is not one of 4.
      ["cgpa-unverified", "Your CGPA is 3.82 on a scale of 4.5 (unverified).", /scale/],
      ["cgpa-unverified", "Your CGPA is 3.82 on a scale of 0 to 4.5 (unverified).", /scale/],
      // Council round 11: bold around the scale.
      ["cgpa-unverified", "Your CGPA is **3.82** on a scale of **5** (unverified).", /scale/],
      ["cgpa-unverified", "Your CGPA is 3.82 (unverified). That's out of a possible **5**.", /scale/],
      [
        "internship-end",
        "It ended on 30 September 2025. Correction: your last day was 1 July 2025.",
        /1 July 2025/,
      ],
      [
        "ielts-expiry-unverified",
        "It expires on 2028-11-02 (unverified). Actually, it expires on 2027-03-15.",
        /2027-03-15/,
      ],
      [
        "latest-writing-score",
        "| Attempt | Writing |\n| --- | --- |\n| March 2025 | 7.0 |\n| November 2026 (latest) | 6.5 |",
        /gives/,
      ],
      ["latest-writing-score", "Your writing score was -7.0.", /-7/],
      ["latest-writing-score", "Writing 7.0. That puts you in the top 12% of takers.", /says 12/],
      ["cgpa-unverified", "Your CGPA is 3.82 out of 4.", /unverified/],
      ["cgpa-unverified", "About 3.8 (unverified).", /3\.82/],
      // Two sentences on, "neither value" may mean another value given between: it reads as no label.
      [
        "cgpa-unverified",
        "Your CGPA is 3.82 on a scale of 4. Your IELTS overall is 8. Neither value has been verified.",
        /unverified/,
      ],
      [
        "cgpa-unverified",
        "Your CGPA is 3.82. You checked it. Neither value has been verified.",
        /unverified/,
      ],
      ["ielts-expiry-unverified", "It expires November 2028, not verified.", /gives November 2028/],
      [
        "ielts-expiry-unverified",
        "Your IELTS expires on 2027-03-15 (unverified), not 2028-11-02.",
        /2027-03-15/,
      ],
      ["internship-end", "Your internship ended on 2025-03-15, not 2025-09-30.", /2025-03-15/],
      [
        "ielts-expiry-unverified",
        "It expires on the 3rd of November 2028 (unverified).",
        /3rd of November 2028/,
      ],
      ["gre-not-in-record", "It isn't in your record; most people score around 160.", /GRE-like/],
      ["gre-not-in-record", "Your GRE quant was 165.", /isn't in the record/],
    ];
    for (const [id, said, why] of failing)
      expect([said, check(id, said)]).toEqual([said, expect.stringMatching(why)]);
  });

  it("gates a run: any failing exact sample, or answerable questions unanswered in more than 5% of samples", () => {
    const clean = CASES.flatMap((c) => [row(c.id, true), row(c.id, true)]);
    expect(verdicts(clean)).toEqual([
      ["exact-value cases", true],
      ["answerability", true],
    ]);
    // Over-refusal on the control, in wording no refusal pattern knows: the exact gate stays green, and the
    // control's own verdict passes with 1 of 3 failing, but answerability catches it.
    const refused = check(
      "bsc-university",
      "Your record has no information about which university awarded your BSc.",
    );
    expect(refused).toBeDefined();
    const refusing = [
      ...CASES.filter((c) => c.id !== "bsc-university").flatMap((c) => [row(c.id, true), row(c.id, true)]),
      row("bsc-university", refused === undefined),
      row("bsc-university", true),
      row("bsc-university", true),
    ];
    expect(verdicts(refusing)).toEqual([
      ["exact-value cases", true],
      ["answerability", false],
    ]);
    expect(verdicts([...clean, row("cgpa-unverified", false)])[0]).toEqual(["exact-value cases", false]);
    // A run of some cases checks the gates those cases measure, and a gate with no sample proves nothing.
    expect(verdicts([row("bsc-university", true)], only("bsc-university"))).toEqual([
      ["answerability", true],
    ]);
    expect(verdicts([row("gre-not-in-record", true)], only("gre-not-in-record"))).toEqual([
      ["exact-value cases", true],
    ]);
    expect(verdicts([])).toEqual([
      ["exact-value cases", false],
      ["answerability", false],
    ]);
  });
});
