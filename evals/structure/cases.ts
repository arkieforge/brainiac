// The structure eval's cases and grader: something new the fictional fixture student (fixtures/README.md) tells their
// own Claude, and where it must land: a note of the fixture schema's type, in that type's folder, with the values
// they gave, and no type the schema doesn't have.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BUILT_IN_TYPES, parseManifest } from "../../packages/core/src/index.ts";
import { matches } from "../mcp-tool-use/cases.ts";
import type { Call } from "../shared/runners.ts";

/** Every type the eval's record has: the fixture manifest's and the built-ins, as `describe` lists them. */
const TYPES = {
  ...BUILT_IN_TYPES,
  ...parseManifest(readFileSync(join(import.meta.dirname, "../../fixtures/nadia/okf-base.yaml"), "utf8"))
    .types,
};

/** A note the run added: live in the record, or in an open proposal waiting for the person. */
export interface Filed {
  readonly id: string;
  readonly type: string;
  readonly path: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** What a run did, for the grader. */
export interface Outcome {
  readonly calls: readonly Call[];
  readonly filed: readonly Filed[];
}

export interface Case {
  readonly id: string;
  /** Where it comes from: the issue or the mistake. */
  readonly source: string;
  readonly kind: "bad" | "guard" | "control";
  readonly prompt: string;
  /** The note that must land: its type, and its fields as `matches` reads them. */
  readonly files: { readonly type: keyof typeof TYPES; readonly fields: Readonly<Record<string, unknown>> };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const named = (call: Call, tool: string) => call.tool === `mcp__brainiac__${tool}`;

/** Why `run` didn't file what `c` says where the schema puts it, or undefined when it did. */
export function check(c: Case, run: Outcome): string | undefined {
  // A type the schema doesn't have, even one the record refused: the model tried to invent it.
  for (const call of run.calls) {
    const input = isRecord(call.input) ? call.input : {};
    const type = input["type"];
    if (named(call, "create") && typeof type === "string" && !Object.hasOwn(TYPES, type))
      return `tried to create a ${type}, a type the schema doesn't have`;
    if (named(call, "organize") && Array.isArray(input["types"]) && input["types"].length > 0)
      return `called organize to add ${JSON.stringify(input["types"])}, though the schema has a ${c.files.type}`;
  }
  // A question it asked alongside the note is fine; any other note is the same news filed somewhere else.
  const stray = run.filed.find((note) => note.type !== c.files.type && note.type !== "Question");
  if (stray) return `filed a ${stray.type || "note with no type"} at ${stray.path}`;
  const note = run.filed.find((n) => n.type === c.files.type && matches(c.files.fields, n.fields));
  if (!note) {
    // Asking isn't filing: no case here leaves the model anything it must ask before it can file.
    const asked = run.calls.some((call) => named(call, "request_info") && !call.failed);
    return asked
      ? `asked instead of filing a ${c.files.type}`
      : `filed no ${c.files.type} with ${JSON.stringify(c.files.fields)}`;
  }
  const folder = TYPES[c.files.type]?.folder;
  return folder === undefined || note.path.startsWith(`${folder}/`)
    ? undefined
    : `filed the ${c.files.type} at ${note.path}, outside ${folder}/`;
}

/** The prompt's ending: the person wants it kept, not discussed. */
const KEEP = "Add it to my record.";

export const CASES: readonly Case[] = [
  {
    id: "new-role",
    source: "#152: a new role lands as a Role in facts/roles",
    kind: "guard",
    prompt: `I started as a research assistant at the Northvale NLP Lab on 2026-10-01, working on low-resource machine translation. ${KEEP}`,
    files: {
      type: "Role",
      fields: { org: "~Northvale", title: "~research assistant", start: "2026-10-01" },
    },
  },
  {
    id: "new-score",
    source: "#152: a new score lands as a TestScore in facts/tests",
    kind: "guard",
    prompt: `My GRE General Test from 2026-10-20 came back: 325 total (verbal 158, quantitative 167), analytical writing 4.5. ${KEEP}`,
    files: { type: "TestScore", fields: { test: "gre", overall: 325, date: "2026-10-20" } },
  },
  {
    id: "new-paper",
    source: "#152: a new paper lands as a Paper in facts/papers",
    kind: "guard",
    prompt: `I'm second author on a new paper, "Cross-Lingual Transfer for Swahili Speech Recognition", DOI 10.5555/brainiac.swahili-asr.2026. ${KEEP}`,
    files: {
      type: "Paper",
      fields: { doi: "10.5555/brainiac.swahili-asr.2026", position: 2, title: "~Swahili Speech" },
    },
  },
  {
    id: "job-is-a-role",
    source: "#152 control: a job is a Role, not a Job or Employment type the schema doesn't have",
    kind: "control",
    prompt: `New job: I started part-time as a backend developer at Fleetwise Robotics on 2026-11-02. ${KEEP}`,
    files: { type: "Role", fields: { org: "~Fleetwise", start: "2026-11-02" } },
  },
  {
    id: "toefl-is-a-score",
    source: "#152 control: a TOEFL result is a TestScore, not a TOEFL type",
    kind: "control",
    prompt: `My TOEFL iBT result from 2026-09-12: 110 overall (reading 29, listening 28, speaking 25, writing 28). ${KEEP}`,
    files: { type: "TestScore", fields: { test: "toefl-ibt", overall: 110, date: "2026-09-12" } },
  },
  {
    id: "preprint-is-a-paper",
    source: "#152 control: a preprint is a Paper, not a Preprint type",
    kind: "control",
    prompt: `My preprint "Tokenizer Choices for Swahili Morphology" is up, DOI 10.5555/brainiac.swahili-tok.2026, and I'm first author. ${KEEP}`,
    files: {
      type: "Paper",
      fields: { doi: "10.5555/brainiac.swahili-tok.2026", position: 1, title: "~Tokenizer" },
    },
  },
];
