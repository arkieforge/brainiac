// The drafts eval's cases and checks: what the fictional fixture student (fixtures/README.md) asks their own Claude
// to write, and what the draft must hold. Each sample asks for one draft in a fresh headless run.
import { noInvented, type Answered } from "../answers/cases.ts";
import { noFailing } from "../shared/gates.ts";
import type { Call } from "../shared/runners.ts";

/** The person's house rules in the eval's record (settings/agents.md), which every draft must follow. */
export const HOUSE_RULES = "Never mention my CGPA in a statement, letter or essay: it is on my transcript.\n";

/** What a run left behind, for a case's check. */
export interface Drafted extends Answered {
  /** Every tool call the run made, with what each answered. */
  readonly calls: readonly Call[];
}

export interface Case {
  readonly id: string;
  /** Where it comes from: the issue or the mistake. */
  readonly source: string;
  readonly kind: "bad" | "guard" | "control";
  readonly prompt: string;
  /** Why it failed, or undefined when it passed. */
  readonly check: (run: Drafted) => string | undefined;
}

/** The answer to the last call of `ask {mode: "verify"}`, the check the draft must pass before it's shown. */
const lastVerify = (calls: readonly Call[]) =>
  calls.findLast(
    (call) =>
      call.tool === "mcp__brainiac__ask" &&
      typeof call.input === "object" &&
      call.input !== null &&
      "mode" in call.input &&
      call.input.mode === "verify",
  );

/** What every draft must do: start from `draft`, end on a clean verify, invent no value, follow the house rules. */
function drafted(run: Drafted): string | undefined {
  if (!run.calls.some((call) => call.tool === "mcp__brainiac__draft")) return "never called draft";
  const verify = lastVerify(run.calls);
  if (!verify) return "never verified the draft";
  const status =
    typeof verify.result === "object" && verify.result !== null && "status" in verify.result
      ? verify.result.status
      : undefined;
  if (status !== "ok") return `its last verify was ${String(status ?? "refused")}, not ok`;
  if (/\bc?gpa\b|3\.82/i.test(run.said)) return "mentions the CGPA, which the house rules forbid";
  return noInvented(run);
}

const all =
  (...checks: ((run: Drafted) => string | undefined)[]) =>
  (run: Drafted) =>
    checks.reduce<string | undefined>((failed, check) => failed ?? check(run), undefined);

const says = (pattern: RegExp, what: string) => (run: Drafted) =>
  pattern.test(run.said) ? undefined : `doesn't mention ${what}`;

export const CASES: readonly Case[] = [
  {
    id: "sop-tum",
    source: "#42: a statement of purpose written from the record, every value claimed and verified",
    kind: "guard",
    prompt:
      "Write my statement of purpose for my TUM application. Reply with only the statement, no notes around it.",
    check: all(drafted, says(/\bTUM\b|Technical University of Munich/i, "TUM")),
  },
  {
    id: "cover-letter-internship",
    source: "#42: a cover letter for a job the record has no application for, from the person's own facts",
    kind: "guard",
    prompt:
      "Write me a cover letter for a backend software internship at a robotics startup. Reply with only the letter, no notes around it.",
    check: all(drafted, says(/Acme Robotics/i, "the Acme Robotics internship")),
  },
  {
    id: "essay-proud",
    source: "#42: an essay answers the person's prompt from a fact",
    kind: "control",
    prompt:
      "Write a short essay for my application on a piece of work I'm proud of. Reply with only the essay, no notes around it.",
    check: drafted,
  },
];

/**
 * The release gate a drafts run checks: no sample of any case invents a value, skips verify or breaks a house
 * rule (docs/operations/quality-bar.md), so every case is strict.
 */
export const draftsGates = (rows: readonly { readonly ok: boolean }[]) =>
  rows.length === 0 ? [] : [noFailing("drafts", rows.filter((row) => !row.ok).length, rows.length)];
