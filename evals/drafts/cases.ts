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

/** Where the prompt asks for notes to the person: after the draft, below a line of only `---`. */
const NOTES_BELOW =
  "Give me the draft first, and put anything you want to tell me after it, below a line with only ---.";

/** The draft itself, without the notes to the person below it: what the graders read. */
const draftOf = (said: string) => said.split(/^\s*-{3,}\s*$/m)[0] ?? said;

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
  if (!run.calls.some((call) => call.tool === "mcp__brainiac__draft" && !call.failed))
    return "never called draft";
  const verify = lastVerify(run.calls);
  if (!verify) return "never verified the draft";
  const status =
    typeof verify.result === "object" && verify.result !== null && "status" in verify.result
      ? verify.result.status
      : undefined;
  if (status !== "ok") return `its last verify was ${String(status ?? "refused")}, not ok`;
  const draft = draftOf(run.said);
  if (/\bc?gpa\b|3\.82/i.test(draft)) return "mentions the CGPA, which the house rules forbid";
  return noInvented({ ...run, said: draft });
}

const all =
  (...checks: ((run: Drafted) => string | undefined)[]) =>
  (run: Drafted) =>
    checks.reduce<string | undefined>((failed, check) => failed ?? check(run), undefined);

const says = (pattern: RegExp, what: string) => (run: Drafted) =>
  pattern.test(draftOf(run.said)) ? undefined : `doesn't mention ${what}`;

export const CASES: readonly Case[] = [
  {
    id: "sop-tum",
    source: "#42: a statement of purpose written from the record, every value claimed and verified",
    kind: "guard",
    prompt: `Write my statement of purpose for my TUM application. ${NOTES_BELOW}`,
    check: all(drafted, says(/\bTUM\b|Technical University of Munich/i, "TUM")),
  },
  {
    id: "cover-letter-internship",
    source: "#42: a cover letter for a job the record has no application for, from the person's own facts",
    kind: "guard",
    prompt: `Write me a cover letter for a backend software internship at a robotics startup. ${NOTES_BELOW}`,
    check: all(drafted, says(/Acme Robotics/i, "the Acme Robotics internship")),
  },
  {
    id: "essay-proud",
    source: "#42: an essay answers the person's prompt from a fact",
    kind: "control",
    prompt: `Write a short essay for my application on a piece of work I'm proud of. ${NOTES_BELOW}`,
    check: all(drafted, says(/Swahili|Acme Robotics|Northvale|telemetry/i, "any fact from the record")),
  },
];

/**
 * The release gate a drafts run checks: no sample of any case invents a value, skips verify or breaks a house
 * rule (docs/operations/quality-bar.md), so every case is strict.
 */
export const draftsGates = (rows: readonly { readonly ok: boolean }[]) =>
  rows.length === 0 ? [] : [noFailing("drafts", rows.filter((row) => !row.ok).length, rows.length)];
