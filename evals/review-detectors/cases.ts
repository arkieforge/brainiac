// The review detectors' seeded errors and clean controls: each case is a copy of the fictional fixture student's
// record (fixtures/README.md) with one mistake a person really makes put in, or an edit that only looks like one.
// The detectors are deterministic, so a case runs once and the gates below run in CI with the rest of the tests.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  detect,
  ownershipCode,
  parseManifest,
  parseNote,
  type Check,
  type ReviewNote,
} from "../../packages/core/src/index.ts";
import { atLeast, FLOORS, type Gate } from "../shared/gates.ts";

const FIXTURES = join(import.meta.dirname, "../../fixtures/nadia");
const MANIFEST = parseManifest(readFileSync(join(FIXTURES, "okf-base.yaml"), "utf8"));
/** The fixture's notes by bundle-relative path, parsed as the record parses them. */
const FIXTURE: readonly ReviewNote[] = readdirSync(FIXTURES, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".md"))
  .toSorted()
  .map((path) => {
    const { data } = parseNote(readFileSync(join(FIXTURES, path), "utf8"));
    return { id: String(data["id"]), path, data };
  });
/** A fixed day, so a date in a case means the same thing every run: the fixture's application is still open. */
const NOW = Date.UTC(2026, 10, 15);

const BSC = "facts/education/bsc-northvale.md";
const ROLE = "facts/roles/acme-intern-2025.md";
const IELTS = "facts/tests/ielts-2026-11.md";
const OLD_IELTS = "facts/tests/ielts-2025-03.md";
const TRANSCRIPT = "documents/transcript-bsc.md";
const TRF = "documents/ielts-trf-2026.md";
const TUM = "applications/tum-msc-informatics-2027/application.md";
const LINKEDIN = "profiles/linkedin.md";

/** A flag as a case names it: the note's path, the detector, and the field when the flag has one. */
export type Flag = `${string} ${Check["detector"]}` | `${string} ${Check["detector"]} ${string}`;

export interface Case {
  readonly id: string;
  /** The mistake it comes from. */
  readonly source: string;
  /** `bad`: a seeded error the detectors must flag. `control`: a clean copy they must leave alone. */
  readonly kind: "bad" | "control";
  /** The copy of the fixture record, made from its notes. */
  readonly record: (notes: readonly ReviewNote[]) => readonly ReviewNote[];
  /**
   * The flags the mistake should raise, beyond the fixture's own. A bad case is caught when it raises all of them;
   * any other new flag is a false alarm. A control lists none.
   */
  readonly flags: readonly Flag[];
}

const at = (notes: readonly ReviewNote[], path: string) => {
  const note = notes.find((n) => n.path === path);
  if (!note) throw new Error(`No fixture note at ${path}`);
  return note;
};
/** The notes with the one at `path` changed (an undefined field is removed). */
const edit = (path: string, changes: Record<string, unknown>) => (notes: readonly ReviewNote[]) =>
  notes.map((note) =>
    note.path === path
      ? {
          ...note,
          data: Object.fromEntries(
            Object.entries({ ...note.data, ...changes }).filter(([, v]) => v !== undefined),
          ),
        }
      : note,
  );
/** A fictional note added at `path`, with an id made from its path so a run is the same every time. */
const add = (path: string, data: Record<string, unknown>) => (notes: readonly ReviewNote[]) => {
  const id = `eval-${path}`;
  return [...notes, { id, path, data: { ...data, id } }];
};
const without =
  (...paths: string[]) =>
  (notes: readonly ReviewNote[]) =>
    notes.filter((note) => !paths.includes(note.path));
const all =
  (...steps: ((notes: readonly ReviewNote[]) => readonly ReviewNote[])[]) =>
  (notes: readonly ReviewNote[]) =>
    steps.reduce((acc, step) => step(acc), notes);
/** What LinkedIn showed when it was read, for the drift cases. */
const linkedinShows = (says: Record<string, string>) => (notes: readonly ReviewNote[]) => {
  const note = at(notes, LINKEDIN);
  const code = ownershipCode(note.id);
  return edit(LINKEDIN, {
    synced: {
      url: note.data["url"],
      code,
      checked: "2026-11-15T00:00:00Z",
      owned: true,
      says: Object.fromEntries(Object.entries(says).map(([k, v]) => [k, v.replaceAll("{code}", code)])),
    },
  })(notes);
};

export const CASES: readonly Case[] = [
  // Values that can't be.
  {
    id: "cgpa-over-scale",
    source: "A slipped digit: 4.82 typed for 3.82 on a 4-point scale",
    kind: "bad",
    record: edit(BSC, { cgpa: 4.82 }),
    flags: [`${BSC} impossible cgpa`, `${BSC} document cgpa`],
  },
  {
    id: "cgpa-percentage-on-4-scale",
    source: "The transcript's percentage (82) typed as the CGPA, scale left at 4",
    kind: "bad",
    record: edit(BSC, { cgpa: 82 }),
    flags: [`${BSC} impossible cgpa`, `${BSC} document cgpa`],
  },
  {
    id: "role-ends-before-it-starts",
    source: "The wrong year on an internship's end, copied from last year's CV",
    kind: "bad",
    record: edit(ROLE, { end: "2024-09-30" }),
    flags: [`${ROLE} impossible end`],
  },
  {
    id: "degree-dates-swapped",
    source: "A degree's start and end typed into each other's boxes",
    kind: "bad",
    record: edit(BSC, { start: "2025-06-30", end: "2021-09-01" }),
    flags: [`${BSC} impossible end`],
  },
  {
    id: "ielts-band-not-a-half",
    source: "An IELTS overall written 7.75, the sections' mean, not the band it rounds to",
    kind: "bad",
    record: edit(IELTS, { overall: 7.75 }),
    flags: [`${IELTS} impossible overall`],
  },
  {
    id: "ielts-overall-from-one-section",
    source: "The listening band (8.5) copied into the overall",
    kind: "bad",
    record: edit(IELTS, { overall: 8.5 }),
    flags: [`${IELTS} impossible overall`],
  },
  {
    id: "toefl-section-on-an-ielts",
    source: "A TOEFL writing score (27) typed into the IELTS's writing band",
    kind: "bad",
    record: edit(IELTS, { sections: { listening: 8.5, reading: 8.0, writing: 27, speaking: 7.5 } }),
    flags: [`${IELTS} impossible sections`],
  },
  {
    id: "ielts-band-filed-as-toefl",
    source: "An IELTS band (7.5) saved on a note whose test is toefl-ibt",
    kind: "bad",
    record: add("facts/tests/toefl-2026-09.md", {
      type: "TestScore",
      title: "TOEFL iBT, September 2026",
      test: "toefl-ibt",
      overall: 7.5,
      date: "2026-09-12",
      expires: "2028-09-12",
      file: "files/toefl-2026.pdf",
    }),
    flags: ["facts/tests/toefl-2026-09.md impossible overall"],
  },
  {
    id: "gre-on-the-old-scale",
    source: "A GRE total on the pre-2011 scale (1450), above what the test gives now",
    kind: "bad",
    record: add("facts/tests/gre-2026-08.md", {
      type: "TestScore",
      title: "GRE General, August 2026",
      test: "gre",
      overall: 1450,
      date: "2026-08-20",
      expires: "2031-08-20",
      file: "files/gre-2026.pdf",
    }),
    flags: ["facts/tests/gre-2026-08.md impossible overall"],
  },
  {
    id: "score-expires-on-the-day-taken",
    source: "A test's date typed into its expiry, a month before it was even taken",
    kind: "bad",
    record: edit(IELTS, { expires: "2026-10-02" }),
    flags: [
      `${IELTS} impossible expires`,
      `${IELTS} document expires`,
      `${IELTS} expired expires`,
      `${TUM} expired requirements`,
    ],
  },

  {
    id: "test-date-in-the-future",
    source: "A test taken in November 2026 saved as November 2027, a year that hasn't come",
    kind: "bad",
    record: edit(IELTS, { date: "2027-11-02" }),
    flags: [`${IELTS} impossible date`],
  },
  {
    id: "toefl-total-off-its-sections",
    source:
      "A TOEFL total (112) that isn't the sum of its sections (110), one section typed from a practice test",
    kind: "bad",
    record: add("facts/tests/toefl-2026-09.md", {
      type: "TestScore",
      title: "TOEFL iBT, September 2026",
      test: "toefl-ibt",
      overall: 112,
      sections: { reading: 28, listening: 29, speaking: 27, writing: 26 },
      date: "2026-09-12",
      expires: "2028-09-12",
      file: "files/toefl-2026.pdf",
    }),
    flags: ["facts/tests/toefl-2026-09.md impossible overall"],
  },

  // The note against its own document.
  {
    id: "cgpa-digits-transposed",
    source: "3.28 typed for the transcript's 3.82",
    kind: "bad",
    record: edit(BSC, { cgpa: 3.28 }),
    flags: [`${BSC} document cgpa`],
  },
  {
    id: "scale-off-from-transcript",
    source: "A 4-point CGPA saved on a scale of 5, as another university's form asked",
    kind: "bad",
    record: edit(BSC, { scale: 5 }),
    flags: [`${BSC} document scale`],
  },
  {
    id: "expiry-off-from-trf",
    source: "The expiry counted from the results day, not the test day the TRF prints",
    kind: "bad",
    record: edit(IELTS, { expires: "2028-11-15" }),
    flags: [`${IELTS} document expires`],
  },

  // An expired score still counted as current.
  {
    id: "expired-score-still-relied-on",
    source: "An IELTS that ran out in March, still the only one the TUM application can use",
    kind: "bad",
    record: all(
      without(IELTS, TRF),
      edit(OLD_IELTS, { date: "2024-03-15", expires: "2026-03-15", title: "IELTS Academic, March 2024" }),
    ),
    flags: [
      `${OLD_IELTS} expired expires`,
      `${TUM} expired requirements`,
      // With the newer score gone, nothing proves this one either.
      `${OLD_IELTS} proof`,
    ],
  },
  {
    id: "score-runs-out-before-deadline",
    source: "The only IELTS is valid today but expires before the deadline TUM checks it on",
    kind: "bad",
    record: without(IELTS, TRF),
    flags: [`${OLD_IELTS} expired expires`, `${TUM} expired requirements`, `${OLD_IELTS} proof`],
  },

  // The same item twice.
  {
    id: "role-filed-twice",
    source: "The internship added again from a CV import, word for word",
    kind: "bad",
    record: (notes) => add("facts/roles/acme-intern-2025-cv.md", at(notes, ROLE).data)(notes),
    flags: [
      "facts/roles/acme-intern-2025-cv.md duplicate",
      // The copy has no document behind it, as the original doesn't.
      "facts/roles/acme-intern-2025-cv.md proof",
    ],
  },
  {
    id: "degree-with-two-cgpas",
    source: "The degree added again from an old application form, with the CGPA before the final term",
    kind: "bad",
    record: (notes) =>
      add("facts/education/bsc-northvale-form.md", {
        ...at(notes, BSC).data,
        sources: undefined,
        cgpa: 3.74,
      })(notes),
    flags: [
      `${BSC} conflict cgpa`,
      "facts/education/bsc-northvale-form.md conflict cgpa",
      "facts/education/bsc-northvale-form.md proof",
    ],
  },

  {
    id: "role-filed-twice-in-lowercase",
    source: "The internship typed in again by hand, the company in lowercase",
    kind: "bad",
    record: (notes) =>
      add("facts/roles/acme-intern-2025-typed.md", { ...at(notes, ROLE).data, org: "acme robotics" })(notes),
    flags: [
      "facts/roles/acme-intern-2025-typed.md duplicate",
      "facts/roles/acme-intern-2025-typed.md proof",
      `${ROLE} spelling org`,
      "facts/roles/acme-intern-2025-typed.md spelling org",
    ],
  },

  // One name written two ways.
  {
    id: "employer-misspelled-on-referee",
    source: "The internship's manager added as a referee, the company typed Acme Robotcs",
    kind: "bad",
    record: add("people/j-mensah.md", {
      type: "Person",
      title: "Joel Mensah",
      role: "referee",
      org: "Acme Robotcs",
    }),
    flags: [`${ROLE} spelling org`, "people/j-mensah.md spelling org"],
  },

  // Facts with nothing behind them.
  {
    id: "source-renamed-away",
    source: "The transcript note renamed, the degree's source still pointing at the old name",
    kind: "bad",
    record: edit(BSC, {
      sources: [
        {
          id: "transcript",
          resource: "../../documents/transcript-bachelor.md",
          page: 2,
          fields: ["cgpa", "scale"],
        },
      ],
    }),
    flags: [`${BSC} proof sources`],
  },
  {
    id: "score-from-memory",
    source: "A GRE score typed in from memory, no report attached",
    kind: "bad",
    record: add("facts/tests/gre-2026-08.md", {
      type: "TestScore",
      title: "GRE General, August 2026",
      test: "gre",
      overall: 321,
      date: "2026-08-20",
      expires: "2031-08-20",
    }),
    flags: ["facts/tests/gre-2026-08.md proof"],
  },

  // Checked long ago.
  {
    id: "checked-two-years-ago",
    source: "A score last checked against its TRF in 2024",
    kind: "bad",
    record: edit(IELTS, {
      verified: { by: "human", at: "2024-11-03", rev: 2, fields: ["overall", "sections"] },
    }),
    flags: [`${IELTS} stale`],
  },

  // An outside profile saying something else.
  {
    id: "linkedin-headline-out-of-date",
    source: "LinkedIn still shows the undergraduate headline",
    kind: "bad",
    record: linkedinShows({
      name: "Nadia Karim",
      headline: "BSc student at Northvale {code}",
      location: "Dhaka, Bangladesh",
    }),
    flags: [`${LINKEDIN} drift headline`],
  },

  // Controls: edits that only look like mistakes.
  {
    id: "cgpa-at-the-top-of-its-scale",
    source: "A perfect 4.0 on a scale of 4, the transcript saying the same",
    kind: "control",
    record: all(edit(BSC, { cgpa: 4 }), edit(TRANSCRIPT, { extracted: { cgpa: 4, scale: 4 } })),
    flags: [],
  },
  {
    id: "cgpa-as-a-percentage",
    source: "A university that grades in percent: 82 on a scale of 100",
    kind: "control",
    record: all(
      edit(BSC, { cgpa: 82, scale: 100 }),
      edit(TRANSCRIPT, { extracted: { cgpa: 82, scale: 100 } }),
    ),
    flags: [],
  },
  {
    id: "cgpa-typed-as-text",
    source: 'The CGPA quoted in the YAML, "3.82", as some editors save it',
    kind: "control",
    record: edit(BSC, { cgpa: "3.82" }),
    flags: [],
  },
  {
    id: "ielts-quarter-rounds-up",
    source: "Sections averaging 7.25, which IELTS rounds up to a band of 7.5",
    kind: "control",
    record: edit(IELTS, {
      overall: 7.5,
      sections: { listening: 7.5, reading: 7.0, writing: 7.0, speaking: 7.5 },
    }),
    flags: [],
  },
  {
    id: "ielts-three-quarters-rounds-up",
    source: "Sections averaging 7.75, which IELTS rounds up to a band of 8.0",
    kind: "control",
    record: edit(IELTS, { sections: { listening: 8.0, reading: 7.5, writing: 7.5, speaking: 8.0 } }),
    flags: [],
  },
  {
    id: "ielts-eighth-rounds-down",
    source: "Sections averaging 7.125, which IELTS rounds down to a band of 7.0",
    kind: "control",
    record: edit(IELTS, {
      overall: 7.0,
      sections: { listening: 7.5, reading: 7.0, writing: 7.0, speaking: 7.0 },
    }),
    flags: [],
  },
  {
    id: "toefl-full-marks",
    source: "A TOEFL of 120, the most the test gives, with its report",
    kind: "control",
    record: add("facts/tests/toefl-2026-09.md", {
      type: "TestScore",
      title: "TOEFL iBT, September 2026",
      test: "toefl-ibt",
      overall: 120,
      sections: { reading: 30, listening: 30, speaking: 30, writing: 30 },
      date: "2026-09-12",
      expires: "2028-09-12",
      file: "files/toefl-2026.pdf",
    }),
    flags: [],
  },
  {
    id: "role-still-going",
    source: "A current role with no end date yet",
    kind: "control",
    record: edit(ROLE, { end: undefined, current: true }),
    flags: [],
  },
  {
    id: "one-day-role",
    source: "A one-day volunteer role, starting and ending the same day",
    kind: "control",
    record: edit(ROLE, { start: "2025-07-01", end: "2025-07-01" }),
    flags: [],
  },
  {
    id: "expired-score-kept-as-history",
    source: "A score that ran out years ago, kept and superseded by the newer one",
    kind: "control",
    record: edit(OLD_IELTS, {
      date: "2023-03-15",
      expires: "2025-03-15",
      title: "IELTS Academic, March 2023",
    }),
    flags: [],
  },
  {
    id: "score-valid-on-the-deadline-day",
    source: "A score that expires on the application's deadline, the day TUM checks it, and still counts",
    kind: "control",
    record: all(edit(IELTS, { expires: "2027-05-31" }), edit(TRF, { expires: "2027-05-31" })),
    flags: [],
  },
  {
    id: "second-role-same-employer",
    source: "A return offer at the same company: same org, another title and start, its offer letter filed",
    kind: "control",
    record: all(
      add("facts/roles/acme-engineer-2026.md", {
        type: "Role",
        title: "Software Engineer, Acme Robotics",
        org: "Acme Robotics",
        kind: "job",
        start: "2026-01-05",
      }),
      add("documents/acme-offer-2026.md", {
        type: "Document",
        title: "Acme Robotics offer letter",
        kind: "certificate",
        issuer: "Acme Robotics",
        issued: "2025-10-20",
        file: "files/acme-offer-2026.pdf",
        proves: ["../facts/roles/acme-engineer-2026.md"],
      }),
    ),
    flags: [],
  },
  {
    id: "master-at-the-same-university",
    source: "An MSc at the same university as the BSc, one letter apart in its degree's name",
    kind: "control",
    record: all(
      add("facts/education/msc-northvale.md", {
        type: "Education",
        title: "MSc Computer Science, Northvale University",
        institution: "Northvale University",
        degree: "MSc Computer Science",
        start: "2025-09-01",
        current: true,
      }),
      add("documents/msc-enrolment.md", {
        type: "Document",
        title: "MSc enrolment letter, Northvale University",
        kind: "certificate",
        issuer: "Northvale University Registrar",
        issued: "2025-08-15",
        file: "files/msc-enrolment.pdf",
        proves: ["../facts/education/msc-northvale.md"],
      }),
    ),
    flags: [],
  },
  {
    id: "neighbouring-university",
    source: "A referee at Northgate University, a real other place two letters from Northvale",
    kind: "control",
    record: add("people/p-osei.md", {
      type: "Person",
      title: "Dr Priya Osei",
      role: "referee",
      org: "Northgate University",
    }),
    flags: [],
  },
  {
    id: "stamford-and-stanford",
    source: "Referees at Stamford University (Dhaka) and Stanford University, two real places a letter apart",
    kind: "control",
    record: all(
      add("people/r-haque.md", {
        type: "Person",
        title: "Dr Rafiq Haque",
        role: "referee",
        org: "Stamford University",
      }),
      add("people/l-chen.md", {
        type: "Person",
        title: "Dr Lin Chen",
        role: "advisor",
        org: "Stanford University",
      }),
    ),
    flags: [],
  },
  {
    id: "checked-eleven-months-ago",
    source: "A score checked against its TRF eleven months ago, inside the year",
    kind: "control",
    record: edit(IELTS, {
      verified: { by: "human", at: "2025-12-20", rev: 2, fields: ["overall", "sections"] },
    }),
    flags: [],
  },
  {
    id: "linkedin-says-the-same",
    source: "LinkedIn matching the record, spacing aside and the ownership code still in the headline",
    kind: "control",
    record: linkedinShows({
      name: "Nadia  Karim",
      headline: "MSc Informatics applicant · NLP for low-resource languages {code}",
      location: "Dhaka, Bangladesh",
    }),
    flags: [],
  },
];

/** A flag as cases name it. */
const flagOf = (notes: readonly ReviewNote[], check: Check): Flag => {
  const path = notes.find((n) => n.id === check.noteId)?.path ?? check.noteId;
  return check.field === undefined ? `${path} ${check.detector}` : `${path} ${check.detector} ${check.field}`;
};

/** What the detectors are measured as: the record's notes in, its flags out. */
export type Detect = (notes: readonly ReviewNote[]) => readonly Check[];
export const DETECT: Detect = (notes) => detect(notes, MANIFEST, NOW);

export interface Result {
  readonly id: string;
  readonly kind: Case["kind"];
  /** The case's flags the detectors raised. */
  readonly raised: readonly Flag[];
  /** The case's flags they didn't. */
  readonly missed: readonly Flag[];
  /** New flags the case didn't name. */
  readonly falseAlarms: readonly Flag[];
  readonly ok: boolean;
}

/**
 * The flags the fixture rightly raises on its own: its role and paper have no document behind them. Named here, not
 * read from the detectors, so one they start raising on every copy counts as a false alarm in every case.
 */
const FIXTURE_FLAGS: ReadonlySet<Flag> = new Set<Flag>([
  "facts/papers/swahili-ner-2026.md proof",
  "facts/roles/acme-intern-2025.md proof",
]);

/**
 * Each case against the fixture's own flags (`FIXTURE_FLAGS`): only what the copy adds counts. Recall is the bad cases caught (every
 * flag they name raised); precision is the new flags that a case named, out of every new flag, controls included.
 */
export function measure(cases: readonly Case[], run: Detect = DETECT) {
  const results: Result[] = cases.map((c) => {
    const notes = c.record(FIXTURE);
    const added = new Set(
      run(notes)
        .map((check) => flagOf(notes, check))
        .filter((flag) => !FIXTURE_FLAGS.has(flag)),
    );
    const raised = c.flags.filter((flag) => added.has(flag));
    const missed = c.flags.filter((flag) => !added.has(flag));
    const falseAlarms = [...added].filter((flag) => !c.flags.includes(flag));
    return {
      id: c.id,
      kind: c.kind,
      raised,
      missed,
      falseAlarms,
      ok: missed.length === 0 && falseAlarms.length === 0,
    };
  });
  const bad = results.filter((r) => r.kind === "bad");
  const caught = bad.filter((r) => r.missed.length === 0).length;
  const right = results.reduce((sum, r) => sum + r.raised.length, 0);
  const raised = results.reduce((sum, r) => sum + r.raised.length + r.falseAlarms.length, 0);
  const gates: Gate[] = [
    atLeast("Recall: seeded errors flagged", FLOORS.detectorRecall, caught, bad.length),
    atLeast("Precision: new flags that name a seeded error", FLOORS.detectorPrecision, right, raised),
  ];
  return { results, gates };
}
