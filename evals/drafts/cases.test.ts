// The drafts eval's graders and gate, which CI runs; the paid runs themselves don't (evals/README.md).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { factsOf } from "../answers/cases.ts";
import type { Call } from "../shared/runners.ts";
import { CASES, draftsGates } from "./cases.ts";

// The fixture record the eval asks, all of it: its connection may read sensitive notes.
const FIXTURES = join(import.meta.dirname, "../../fixtures/nadia");
const RECORD = factsOf(
  readdirSync(FIXTURES, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".md"))
    .map((path) => readFileSync(join(FIXTURES, path), "utf8")),
);
const DRAFT: Call = { tool: "mcp__brainiac__draft", input: { kind: "cover-letter" }, result: { notes: [] } };
const verified = (status: string): Call => ({
  tool: "mcp__brainiac__ask",
  input: { mode: "verify", text: "…", claims: [] },
  result: { status },
});
const check = (id: string, said: string, calls: readonly Call[] = [DRAFT, verified("ok")]) => {
  const found = CASES.find((c) => c.id === id);
  if (!found) throw new Error(id);
  return found.check({ said, calls, ...RECORD });
};

const LETTER =
  "Dear hiring team, as a Software Engineering Intern at Acme Robotics from July to September 2025, I built the fleet telemetry dashboard.";

describe("drafts eval", () => {
  it("passes a draft that started from draft, ends on a clean verify and holds only the record's values", () => {
    expect(check("cover-letter-internship", LETTER)).toBeUndefined();
    expect(check("sop-tum", `I am applying to TUM. ${LETTER}`)).toBeUndefined();
  });

  it("fails a draft that skipped draft or verify, or whose last verify wasn't ok", () => {
    expect(check("cover-letter-internship", LETTER, [verified("ok")])).toBe("never called draft");
    expect(check("cover-letter-internship", LETTER, [DRAFT])).toBe("never verified the draft");
    expect(check("cover-letter-internship", LETTER, [DRAFT, verified("ok"), verified("fix")])).toBe(
      "its last verify was fix, not ok",
    );
    expect(check("cover-letter-internship", LETTER, [DRAFT, { ...verified("ok"), result: "refused" }])).toBe(
      "its last verify was refused, not ok",
    );
  });

  it("fails an invented value, a broken house rule, and a draft that misses its subject", () => {
    expect(check("cover-letter-internship", `${LETTER} I led a team of 12.`)).toMatch(/12/);
    expect(check("cover-letter-internship", `${LETTER} My GPA is strong.`)).toMatch(/house rules/);
    expect(check("essay-proud", "I graduated with a 3.82.")).toMatch(/house rules/);
    expect(check("essay-proud", "I can't write this essay.")).toBe(
      "doesn't mention any fact from the record",
    );
    expect(check("essay-proud", LETTER, [{ ...DRAFT, failed: true }, verified("ok")])).toBe(
      "never called draft",
    );
    expect(check("sop-tum", LETTER)).toBe("doesn't mention TUM");
  });

  it("fails the run on any failing sample", () => {
    expect(draftsGates([{ ok: true }, { ok: true }]).map((g) => g.ok)).toEqual([true]);
    expect(draftsGates([{ ok: true }, { ok: false }]).map((g) => g.ok)).toEqual([false]);
  });
});
