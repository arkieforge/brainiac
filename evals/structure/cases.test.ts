// The structure eval's grader, which CI runs; the paid runs themselves don't (evals/README.md). Each case passes the
// note the schema asks for and fails each way new info lands wrong.
import { describe, expect, it } from "vite-plus/test";

import type { Call } from "../shared/runners.ts";
import { CASES, check, type Filed } from "./cases.ts";

const call = (tool: string, input: unknown = {}): Call => ({ tool: `mcp__brainiac__${tool}`, input });
const note = (type: string, path: string, fields: Record<string, unknown>): Filed => ({
  id: "new",
  type,
  path,
  fields: { type, ...fields },
});

/** For each case, the note a run that did it right leaves. */
const RIGHT: Record<string, Filed> = {
  "new-role": note("Role", "facts/roles/research-assistant.md", {
    title: "Research Assistant, Northvale NLP Lab",
    org: "Northvale NLP Lab",
    kind: "research",
    start: "2026-10-01",
  }),
  "new-score": note("TestScore", "facts/tests/gre-general-october-2026.md", {
    title: "GRE General, October 2026",
    test: "gre",
    overall: 325,
    sections: { verbal: 158, quantitative: 167, analytical_writing: 4.5 },
    date: "2026-10-20",
  }),
  "new-paper": note("Paper", "facts/papers/cross-lingual-transfer-for-swahili-speech-recognition.md", {
    title: "Cross-Lingual Transfer for Swahili Speech Recognition",
    doi: "10.5555/brainiac.swahili-asr.2026",
    position: 2,
  }),
  "job-is-a-role": note("Role", "facts/roles/backend-developer-fleetwise-robotics.md", {
    title: "Backend Developer, Fleetwise Robotics",
    org: "Fleetwise Robotics",
    kind: "job",
    start: "2026-11-02",
  }),
  "toefl-is-a-score": note("TestScore", "facts/tests/toefl-ibt-september-2026.md", {
    title: "TOEFL iBT, September 2026",
    test: "toefl-ibt",
    overall: 110,
    date: "2026-09-12",
  }),
  "preprint-is-a-paper": note("Paper", "facts/papers/tokenizer-choices-for-swahili-morphology.md", {
    title: "Tokenizer Choices for Swahili Morphology",
    doi: "10.5555/brainiac.swahili-tok.2026",
    position: 1,
  }),
};

const graded = (id: string, filed: readonly Filed[], calls: readonly Call[] = []) => {
  const found = CASES.find((c) => c.id === id);
  if (!found) throw new Error(id);
  return check(found, { calls, filed });
};

describe("structure eval", () => {
  it("passes each case on the note the schema asks for, with or without a question beside it", () => {
    expect(Object.keys(RIGHT).toSorted()).toEqual(CASES.map((c) => c.id).toSorted());
    for (const [id, right] of Object.entries(RIGHT)) {
      const created = call("create", { type: right.type, fields: right.fields });
      expect([id, graded(id, [right], [call("describe"), created])]).toEqual([id, undefined]);
      const question = note("Question", "questions/end.md", { field: "end", status: "open" });
      expect([id, graded(id, [right, question], [created, call("request_info")])]).toEqual([id, undefined]);
    }
  });

  it("fails a type the schema doesn't have, even one the record refused, or organize adding one", () => {
    const right = RIGHT["job-is-a-role"]!;
    const invented = { ...call("create", { type: "Job", fields: {} }), failed: true };
    expect(graded("job-is-a-role", [right], [invented, call("create", { type: "Role" })])).toBe(
      "tried to create a Job, a type the schema doesn't have",
    );
    // An object built-in is no type either.
    expect(graded("new-role", [RIGHT["new-role"]!], [call("create", { type: "constructor" })])).toMatch(
      /constructor, a type the schema doesn't have/,
    );
    expect(
      graded(
        "toefl-is-a-score",
        [],
        [call("organize", { types: [{ name: "Toefl", folder: "facts/toefl" }] })],
      ),
    ).toMatch(/called organize to add .*Toefl/);
    // organize that only moves notes adds no type.
    expect(graded("new-score", [RIGHT["new-score"]!], [call("organize", { types: [], moves: [] })])).toBe(
      undefined,
    );
  });

  it("fails the news filed as another type, or as the right one in another folder", () => {
    const role = RIGHT["new-role"]!;
    const fact = note("Fact", "facts/research-assistant.md", { title: "Research assistant", tags: ["lab"] });
    expect(graded("new-role", [fact])).toBe("filed a Fact at facts/research-assistant.md");
    expect(graded("new-role", [role, fact])).toBe("filed a Fact at facts/research-assistant.md");
    expect(graded("new-role", [{ ...role, path: "roles/research-assistant.md" }])).toBe(
      "filed the Role at roles/research-assistant.md, outside facts/roles/",
    );
    // A second copy elsewhere fails too, in either order.
    const copy = { ...role, id: "copy", path: "roles/research-assistant.md" };
    expect(graded("new-role", [role, copy])).toMatch(/outside facts\/roles\//);
    expect(graded("new-role", [copy, role])).toMatch(/outside facts\/roles\//);
    // A folder whose name starts like the type's isn't it.
    expect(graded("new-role", [{ ...role, path: "facts/roles-old/research-assistant.md" }])).toMatch(
      /outside facts\/roles\//,
    );
  });

  it("fails a run that only asked, or filed the type with the wrong values", () => {
    expect(graded("new-paper", [], [call("request_info", { about: "new paper" })])).toBe(
      "asked instead of filing a Paper",
    );
    // A question the record refused is no question, and nothing was filed.
    expect(graded("new-paper", [], [{ ...call("request_info"), failed: true }])).toMatch(/^filed no Paper/);
    const paper = RIGHT["new-paper"]!;
    expect(graded("new-paper", [{ ...paper, fields: { ...paper.fields, position: 1 } }])).toMatch(
      /^filed no Paper/,
    );
    const score = RIGHT["new-score"]!;
    // A GRE filed as an IELTS, or with the section sum it wasn't given, isn't the score they reported.
    expect(graded("new-score", [{ ...score, fields: { ...score.fields, test: "ielts-academic" } }])).toMatch(
      /^filed no TestScore/,
    );
    expect(graded("new-score", [{ ...score, fields: { ...score.fields, overall: 329.5 } }])).toMatch(
      /^filed no TestScore/,
    );
    expect(
      graded("job-is-a-role", [
        { ...RIGHT["job-is-a-role"]!, fields: { org: "Fleetwise", start: "2026-11-01" } },
      ]),
    ).toMatch(/^filed no Role/);
  });
});
