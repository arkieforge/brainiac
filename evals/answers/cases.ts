// The answers eval's questions and checks: what the fictional fixture student (fixtures/README.md) asks their own
// Claude, and what the answer must hold. Each sample asks one question in a fresh headless run.
import { datesIn, numbersIn, withoutCites } from "../../packages/base/src/answers.ts";
import { atLeast, FLOORS, noFailing } from "../shared/gates.ts";

/** What a run left behind, for a case's check. */
export interface Answered {
  /** The run's final answer, as the person reads it. */
  readonly said: string;
  /** Every number the notes the connection may see hold, standing alone or in a date. */
  readonly recordNumbers: ReadonlySet<number>;
  /** Every date those notes hold, as ISO dates. */
  readonly recordDates: ReadonlySet<string>;
}

export interface Case {
  readonly id: string;
  /** Where it comes from: the issue or the mistake. */
  readonly source: string;
  readonly kind: "bad" | "guard" | "control";
  /** An exact-value case fails on any failing sample (docs/operations/quality-bar.md); the rest when half or more fail. */
  readonly exact: boolean;
  /** Whether the record holds the answer, so saying it doesn't counts against answerability. */
  readonly answerable: boolean;
  readonly question: string;
  /** Why it failed, or undefined when it passed. */
  readonly check: (run: Answered) => string | undefined;
}

/**
 * The answer as the graders read it: cites, markdown emphasis and slash dates ("02/11/2026", which can't be read
 * one way) taken out, and a scale ("7.0 out of 9", "7.0/9", "a scale of 0 to 4"). The CGPA case checks its own scale.
 */
const plain = (said: string) =>
  withoutCites(said)
    .replaceAll(/[*_`]/g, "")
    .replaceAll(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "")
    .replaceAll(
      /(?<=\d)\s*(?:out of|\/)\s*\d+\b|\bscale of (?:\d+(?:\.\d+)?\s*(?:to|-|\u2013)\s*)?\d+(?:\.\d+)?/gi,
      "",
    );

/**
 * A number or date in the answer, read as `ask {mode: "verify"}` reads them, that the record doesn't hold anywhere:
 * "taken on 3 November 2026" when it was the 2nd fails here even though the question was about the score. A
 * difference the model works out ("up 0.5") counts too: the record doesn't hold it, and an exact answer quotes values.
 */
const noInvented = (run: Answered) => {
  const { dates, rest } = datesIn(plain(run.said));
  const record = [...run.recordDates];
  const date = dates.find(({ iso }) =>
    iso.startsWith("--")
      ? !record.some((d) => d.slice(4) === iso.slice(1))
      : !record.some((d) => d.startsWith(iso)),
  );
  if (date) return `says ${date.text}, a date the record doesn't hold`;
  const number = numbersIn(rest).find((n) => !run.recordNumbers.has(n.value));
  return number ? `says ${number.text}, which the record doesn't hold` : undefined;
};

/**
 * "unverified", "not verified", "haven't marked it as verified", "neither value has been verified", "verified, but
 * the expiry date is not".
 */
const UNVERIFIED =
  /\bun(verified|checked)\b|(\bnot\b|n't\b|\bneither\b|\bnever\b)[^.!?\n,;:]{0,30}\b(verified|checked)\b|\b(verified|checked)\b[^.!?\n]{0,40}\bbut\b[^.!?\n]{0,30}\b(is|are|was)(n't| not)\b/i;

const sentencesOf = (said: string) =>
  said
    .replaceAll(/[*_`]/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => sentence.trim() !== "");

/** The clauses of a sentence around `from`..`to`: "and", "but", a comma or a semicolon starts another thought. */
const clauseAround = (sentence: string, from: number, to: number) => {
  const bounds = [...sentence.matchAll(/[,;]\s+|\s+(?:and|but|while|whereas)\s+/gi)].map((m) => m.index ?? 0);
  const start = Math.max(0, ...bounds.filter((b) => b < from));
  const end = Math.min(sentence.length, ...bounds.filter((b) => b >= to));
  return sentence.slice(start, end);
};

/** The sentence's "unverified" label, if the clause it's in is about this field and not another one. */
const labelFor = (sentence: string, field: RegExp, others: RegExp) => {
  const label = UNVERIFIED.exec(sentence);
  if (!label) return false;
  const clause = clauseAround(sentence, label.index, label.index + label[0].length);
  return field.test(clause) || !others.test(clause);
};

/**
 * Points back at the value the sentence before gave: "It's unverified", "Both values are unverified", "You haven't
 * verified it", "You haven't marked either value as verified".
 */
const POINTS_BACK =
  /^\s*(it|this|that|these|those|they|both|the value|the values)\b|\b(verified|checked|marked) (it|this|that|them)\b|\b(either|both|neither|these|those) values?\b/i;

/** Points back at every value given before: "Neither value has been verified", "Both values are unverified". */
const POINTS_BACK_ALL = /\b(either|both|neither) values?\b/i;

/**
 * Whether the answer labels the value it gives as unverified: in the sentence that gives it, in a clause not about
 * another field, or in the next sentence when that one names the field or points back at it, or the one after when
 * it points back at every value and the sentence between gives no number and says nothing of verifying. A sentence
 * that calls the value "verified" or "checked" fails. So "Expires 2028-11-02. Your CGPA is unverified.", "Expires
 * 2028-11-02 and your CGPA is unverified" and "Your CGPA is 3.82 (verified). The scale is unverified." fail.
 */
const labeled = (value: RegExp, field: RegExp, others: RegExp, what: string) => (run: Answered) => {
  const sentences = sentencesOf(run.said);
  const ok = sentences.some((sentence, i) => {
    if (!value.test(sentence)) return false;
    if (labelFor(sentence, field, others)) return true;
    if (/\b(verified|checked)\b/i.test(sentence)) return false;
    const next = sentences[i + 1] ?? "";
    if ((field.test(next) || POINTS_BACK.test(next)) && labelFor(next, field, others)) return true;
    const after = sentences[i + 2] ?? "";
    return (
      !/\d|\b(verified|checked)\b/i.test(next) &&
      POINTS_BACK_ALL.test(after) &&
      labelFor(after, field, others)
    );
  });
  return ok ? undefined : `doesn't say ${what} is unverified`;
};

/** A number that is the scale, not the value: "on a 4.0 scale", "4-point". */
const SCALE_AFTER = /^\s*(-?\s*point|point|scale)\b/i;

/**
 * The CGPA an answer gives: in each sentence naming CGPA or GPA, the first number after it, scales aside, must be
 * 3.82; with neither named, 3.82 must be there. So "Your GPA, on a 4.0 scale, is 3.82" passes, and a later "your GPA
 * is 3.9" fails.
 */
const givesCgpa = (run: Answered) => {
  let named = false;
  for (const sentence of sentencesOf(plain(run.said))) {
    const at = sentence.search(/\bc?gpa\b/i);
    if (at < 0) continue;
    const after = sentence.slice(at);
    const [first] = numbersIn(after).filter(
      (n) => !SCALE_AFTER.test(after.slice(n.at + n.text.length)) && !/\ba\s+$/i.test(after.slice(0, n.at)),
    );
    if (!first) continue;
    named = true;
    if (first.value !== 3.82) return `gives ${first.text} as the CGPA`;
  }
  return named || /(?<![\d.])3\.82(?!\.?\d)/.test(run.said) ? undefined : "doesn't say the CGPA 3.82";
};

/** A value the answer denies ("not 7.0", "isn't 2028-11-02"), which an exact case must never do to the right one. */
const denies = (value: string, what: string) =>
  neverSays(
    // A few words may come between, inside one clause: "did not end on 2025-09-30".
    new RegExp(String.raw`(\bnot\b|n't\b|\bnever\b)[^.!?\n,;]{0,20}?(${value})`, "i"),
    `${what} isn't it`,
  );

/** Checks in order; the first that fails says why. */
const all =
  (...checks: ((run: Answered) => string | undefined)[]) =>
  (run: Answered) =>
    checks.reduce<string | undefined>((why, check) => why ?? check(run), undefined);

// Read with markdown emphasis aside, so "a scale of **5**" or "not **7.0**" reads as it says.
const unstyled = (said: string) => said.replaceAll(/[*_`]/g, "");
const says = (pattern: RegExp, what: string) => (run: Answered) =>
  pattern.test(unstyled(run.said)) ? undefined : `doesn't say ${what}`;
const neverSays = (pattern: RegExp, what: string) => (run: Answered) =>
  pattern.test(unstyled(run.said)) ? `says ${what}` : undefined;

/** A markdown table: its header cells and each row's cells, separator rows left out. */
interface Table {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

const cellsOf = (line: string) =>
  line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());

/** The markdown tables in `text`, and the text with their lines taken out. */
function tablesIn(text: string): { readonly tables: Table[]; readonly prose: string } {
  const tables: Table[] = [];
  const prose: string[] = [];
  let block: string[] = [];
  const close = () => {
    const [header, ...rows] = block.filter((line) => !/^[\s|:-]+$/.test(line)).map(cellsOf);
    if (header) tables.push({ header, rows });
    block = [];
  };
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("|")) block.push(line);
    else {
      close();
      prose.push(line);
    }
  }
  close();
  return { tables, prose: prose.join("\n") };
}

/** Which attempt a sentence, row or cell is about, when it names only one: March 2025's or November 2026's. */
function attemptOf(text: string): "march" | "november" | undefined {
  const march = /\b(march|mar|2025|previous|earlier|older|first attempt|last time)\b/i.test(text);
  const november = /\b(november|nov|2026|latest|most recent|newest|this time)\b/i.test(text);
  return march === november ? undefined : march ? "march" : "november";
}

/** A sentence about the older attempt, or another one than the latest. */
const OLDER = /\b(march|mar|2025|previous|earlier|older|first attempt)\b/i;

/** Whether a sentence names both attempts. */
const bothAttempts = (text: string) =>
  OLDER.test(text) && /\b(november|nov|2026|latest|most recent|newest)\b/i.test(text);

/** A writing score as an answer gives it: the attempt it's about, and `from` for what it went up from. */
interface Score {
  readonly value: number;
  readonly from: boolean;
  /** `both` when its sentence names both attempts, so it may be March's. */
  readonly attempt: "march" | "november" | "both" | undefined;
}

/** The other sections and the overall band, where a writing score's clause ends. */
const OTHER_FIELD = /\b(overall|listening|reading|speaking)\b/i;

const NUMBER = String.raw`-?\d+(?:\.\d+)?`;

/** The writing scores in one sentence or line that names writing: "<n> in writing", then the clause after it. */
function scoresIn(segment: string, attempt: Score["attempt"]): Score[] {
  const text = datesIn(segment).rest.replaceAll(/\b(19|20)\d{2}\b/g, "");
  const at = text.search(/writing/i);
  const before = new RegExp(String.raw`(${NUMBER})\s+(?:in|for|on)\s+(?:the\s+)?$`, "i").exec(
    text.slice(0, at),
  );
  const clause = text.slice(at).split(OTHER_FIELD)[0] ?? "";
  // "from 6.5 to 7.0", "compared with 6.5" and "6.5 → 7.0": that one is what it went up from.
  const after = Array.from(
    clause.matchAll(
      new RegExp(
        String.raw`(\b(?:from|compared (?:with|to))\s+)?(?<![\d.])(${NUMBER})(?!\.?\d)(\s*(?:→|->))?`,
        "gi",
      ),
    ),
  );
  const from = after.map((m) => m[1] !== undefined || m[3] !== undefined);
  // In a comparison ("7.0, up from 6.5 in March") the attempt it names is the earlier one's: no score takes it.
  const named = from.includes(true) ? undefined : attempt;
  return [
    ...(before ? [{ value: Number(before[1]), from: false, attempt: named }] : []),
    ...after.map((m, i) => ({ value: Number(m[2]), from: from[i] ?? false, attempt: named })),
  ];
}

/** A table's writing scores: a writing column (each row's attempt from its other cells), or a writing row. */
function tableScores({ header, rows }: Table): Score[] {
  const column = header.findIndex((cell) => /writing/i.test(cell));
  if (column >= 0)
    return rows.flatMap((row) => {
      const attempt = attemptOf(row.filter((_, i) => i !== column).join(" "));
      return numbersIn(row[column] ?? "").map((n) => ({ value: n.value, from: false, attempt }));
    });
  return [header, ...rows]
    .filter((row) => /writing/i.test(row[0] ?? ""))
    .flatMap((row) =>
      row.slice(1).flatMap((cell, i) =>
        numbersIn(datesIn(cell).rest).map((n) => ({
          value: n.value,
          from: false,
          attempt: attemptOf(header[i + 1] ?? "") ?? attemptOf(cell),
        })),
      ),
    );
}

/**
 * Whether an answer gives November's 7.0 as the latest writing score. Each score is read with the attempt its
 * sentence or row names, if it names one: November's must be 7.0, March's 6.5, and an unnamed one either. A score it
 * went up from must be 6.5, and the first score not about March must be 7.0. Sentences that name writing are read
 * with dates left out, a short heading with the line after it, and a table by its writing column or row. So "went
 * from 6.5 to 7.0" and "March 6.5. Latest 7.0." pass, while "writing 7.5", "from 7.5 to 7.0", "writing 6.5 (overall
 * 7.0)" or a table giving November 6.5 fails. A sentence naming both attempts with two scores and no "from" can't
 * pair them, so it fails rather than guess ("7.0 in March and 6.5 in November").
 */
const latestWriting = (run: Answered) => {
  const { tables, prose } = tablesIn(plain(run.said));
  const segments = prose.split(/(?<=[.!?])\s+|\n+/).filter((segment) => segment.trim() !== "");
  const scores = [
    ...segments.flatMap((segment, i) => {
      if (!/writing/i.test(segment)) return [];
      const found = scoresIn(segment, bothAttempts(segment) ? "both" : attemptOf(segment));
      // Naming both attempts with two scores and no "from" can't be paired: it fails rather than guess.
      if (
        bothAttempts(segment) &&
        found.filter((score) => !score.from).length >= 2 &&
        !found.some((sc) => sc.from)
      )
        return [{ value: Number.NaN, from: false, attempt: undefined }];
      if (found.length > 0) return found;
      // Only a heading ("IELTS Writing", "Writing:") hands its score to the line after it.
      const heading = segment.trim().split(/\s+/).length <= 4 || /:\s*$/.test(segment);
      const next = segments[i + 1] ?? "";
      return heading
        ? numbersIn(datesIn(next).rest).map((n) => ({
            value: n.value,
            from: false,
            attempt: attemptOf(next),
          }))
        : [];
    }),
    ...tables.flatMap(tableScores),
  ];
  const wrong = scores.find((s) =>
    s.from
      ? s.value !== 6.5
      : s.attempt === "november"
        ? s.value !== 7
        : s.attempt === "march"
          ? s.value !== 6.5
          : s.value !== 7 && s.value !== 6.5,
  );
  if (wrong && Number.isNaN(wrong.value))
    return "gives writing scores for both attempts in one sentence, unpaired";
  if (wrong)
    return `gives ${wrong.value} for ${wrong.attempt === "march" ? "March's " : wrong.from ? "the earlier " : ""}writing`;
  const first = scores.find((s) => !s.from && s.attempt !== "march");
  if (!first) return "doesn't say the writing score (7.0)";
  if (first.value !== 7) return `gives ${first.value} as the latest writing score`;
  // After the latest is given, an unnamed 6.5 would take it back ("7. Actually, 6.5"): only a named March may say it.
  const later = scores
    .slice(scores.indexOf(first) + 1)
    .find((s) => !s.from && s.attempt === undefined && s.value !== 7);
  return later ? `gives ${later.value} for writing after 7.0` : undefined;
};

/** A cue that must end the text before a date ("valid until", "ran to"), as against a word anywhere before it. */
const endsIn = (cues: string) => new RegExp(String.raw`(\b(${cues})\s+(on\s+)?(the\s+)?|\s\u2013\s*)$`, "i");

/**
 * The date an answer gives for a field, read in its sentence, between the line breaks, commas and dates around it:
 * the first date with a `word` before it ("expires on", "ended on") or a `preposition` right before it ("until",
 * "to"), unless "from" or "since" is right before it; failing that, the first with a `word` after it ("2 November
 * 2028 is when it expires"); in a table, the date in the column whose header has a `word`. So "expires on
 * 2027-03-15, not 2028-11-02" gives 2027-03-15, and "valid from 2026-11-02 until 2028-11-02", "ran from 2025-07-01 to
 * 2025-09-30" and "According to your record, you started on 1 July 2025 and finished on 30 September 2025" the
 * second.
 */
const givesDate =
  (word: RegExp, prepositions: string, iso: string, what: string, older?: RegExp) =>
  (run: Answered): string | undefined => {
    const { tables, prose } = tablesIn(run.said.replaceAll(/[*_`]/g, ""));
    const found = datesIn(prose).dates;
    const bound = /[.!?](\s|$)|\n|, /g;
    const leadOf = (at: number, previous: number) => {
      const breaks = [...prose.slice(0, at).matchAll(bound)].map((m) => (m.index ?? 0) + m[0].length);
      return prose.slice(Math.max(previous, breaks.at(-1) ?? 0), at);
    };
    const afterOf = (from: number, next: number) => {
      const stop = prose.slice(from).search(bound);
      return prose.slice(from, Math.min(next, stop < 0 ? prose.length : from + stop));
    };
    const precedes = endsIn(prepositions);
    const led = found.filter((d, i) => {
      const previous = found[i - 1];
      const lead = leadOf(d.at, previous ? previous.at + previous.text.length : 0);
      return (word.test(lead) || precedes.test(lead)) && !/\b(from|since)\W*$/i.test(lead);
    });
    // Every date the answer gives for it must be the one, unless its sentence matches `older` (another attempt's): a
    // later "actually, it expires 2027-03-15" fails, "the March 2025 attempt expires on 2027-03-15" doesn't.
    const sentenceAt = (at: number) => {
      const start = Math.max(prose.lastIndexOf("\n", at), prose.lastIndexOf(". ", at)) + 1;
      const end = prose.slice(at).search(/[.!?](\s|$)|\n/);
      return prose.slice(start, end < 0 ? prose.length : at + end);
    };
    const contradicted = led.find((d) => d.iso !== iso && !older?.test(sentenceAt(d.at)));
    if (contradicted) return `gives ${contradicted.text} for ${what}`;
    const asserted =
      led[0] ??
      found.find((d, i) => word.test(afterOf(d.at + d.text.length, found[i + 1]?.at ?? prose.length))) ??
      tables
        .flatMap(({ header, rows }) => {
          const column = header.findIndex((cell) => word.test(cell));
          return column < 0 ? [] : rows.flatMap((row) => datesIn(row[column] ?? "").dates);
        })
        .at(0);
    if (!asserted) return `doesn't say ${what}`;
    return asserted.iso === iso ? undefined : `gives ${asserted.text} for ${what}`;
  };

/**
 * What notes hold, from their text, read as the graders read an answer: numbers standing alone (an id's or a hash's
 * digits are none) and each date's parts, and the dates.
 */
export function factsOf(raws: readonly string[]): Omit<Answered, "said"> {
  const read = raws.map((raw) => datesIn(raw));
  return {
    recordNumbers: new Set(
      read.flatMap(({ dates, rest }) => [
        ...numbersIn(rest).map((n) => n.value),
        ...dates.flatMap((d) => d.iso.split("-").filter(Boolean).map(Number)),
      ]),
    ),
    recordDates: new Set(
      read.flatMap(({ dates }) => dates.map((d) => d.iso).filter((iso) => !iso.startsWith("-"))),
    ),
  };
}

export const CASES: readonly Case[] = [
  {
    id: "latest-writing-score",
    source: "#22: a model misquoting a number; the November attempt superseded March's 6.5",
    kind: "guard",
    exact: true,
    answerable: true,
    question: "What was my writing score on my most recent IELTS?",
    check: all(latestWriting, denies(String.raw`7(\.0)?\b`, "7.0"), noInvented),
  },
  {
    id: "cgpa-unverified",
    source: "#22: values nobody checked say so",
    kind: "guard",
    exact: true,
    answerable: true,
    question: "What's my CGPA from my bachelor's?",
    check: all(
      givesCgpa,
      denies(String.raw`3\.82`, "3.82"),
      neverSays(
        /(out of|\/|scale of)(\s+a\s+(possible|maximum))?\s*(?!4(\.0+)?(?!\.?\d)|0(\.0+)?\s*(to|-|\u2013)\s*4(\.0+)?(?!\.?\d))(0(\.0+)?\s*(to|-|\u2013)\s*)?\d|(?<![\d.])\b(?!4(\.0+)?(?!\.?\d))\d+(\.\d+)?[- ]?(point\s+)?scale\b/i,
        "a scale other than 4",
      ),
      labeled(
        /3\.82/,
        /\bc?gpa\b|\bgrade\b/i,
        /\b(ielts|score|expir|writing|test|scale|institution|university|degree|date)\b/i,
        "the CGPA",
      ),
      noInvented,
    ),
  },
  {
    id: "ielts-expiry-unverified",
    source: "#22: a date quoted exactly, and the person checked only the scores",
    kind: "guard",
    exact: true,
    answerable: true,
    question: "When does my latest IELTS result expire?",
    check: all(
      givesDate(/expir/i, "until|through|till|to", "2028-11-02", "the expiry (2028-11-02)", OLDER),
      denies(String.raw`2028-11-02|November 0?2,? 2028|0?2(nd)? (of )?November 2028`, "2028-11-02"),
      labeled(
        /2028-11-02|November 0?2(nd)?,? 2028|0?2(nd)? (of )?November 2028|02\.11\.2028/i,
        /expir|valid|\b(that|this|the expiry) date\b/i,
        /\b(cgpa|gpa|score|scores|writing|overall|band|listening|reading|speaking|test date|taken)\b/i,
        "the expiry",
      ),
      noInvented,
    ),
  },
  {
    id: "internship-end",
    source: "#22: a date quoted exactly from a role",
    kind: "guard",
    exact: true,
    answerable: true,
    question: "When did my internship at Acme Robotics end?",
    check: all(
      givesDate(
        /\bend|finish|last day|left/i,
        "until|through|till|to",
        "2025-09-30",
        "the end date (2025-09-30)",
      ),
      denies(String.raw`2025-09-30|September 30,? 2025|30(th)? (of )?September 2025`, "2025-09-30"),
      noInvented,
    ),
  },
  {
    id: "gre-not-in-record",
    source: `#22: "not in your record" when it isn't, never a typical score`,
    kind: "guard",
    exact: true,
    answerable: false,
    question: "What was my GRE quantitative score?",
    check: all(
      says(
        /not in (your|the) record|no GRE|(doesn't|does not|don't|do not|didn't|did not|couldn't|could not|can't|cannot|wasn't able to|was unable to|unable to) (see|find|have|hold|include|contain|list|show|mention|locate)|isn't (in|recorded)|not recorded|no record/i,
        "it isn't in the record",
      ),
      neverSays(/\b1[3-6]\d\b|\b170\b/, "a GRE-like score"),
      noInvented,
    ),
  },
  {
    id: "tum-missing",
    source:
      "#30: what an application lacks comes from its typed checks, never guessed from the requirement's words",
    kind: "guard",
    exact: false,
    question: "What's still missing for my TUM application?",
    check: all(
      says(/letter/i, "the recommendation letters"),
      says(/motivation|question 4/i, "the motivation answer"),
      neverSays(
        /\b(IELTS|transcript)\b[^.!?\n]{0,40}\b(is|are) (still )?missing\b/i,
        "a met requirement is missing",
      ),
      noInvented,
    ),
  },
  {
    id: "bsc-university",
    source: "#22: control, an ordinary question gets its answer",
    kind: "control",
    exact: false,
    answerable: true,
    question: "Which university did I do my BSc at?",
    check: says(/Northvale/, "Northvale University"),
  },
];

/**
 * The release gates an answers run checks, for the cases it ran: no exact-value sample fails, and answerable
 * questions get their answer in at least 95% of samples. A sample answered only when its case's check passed, so a
 * refusal in any wording counts against answerability: over-refusal invents no number and can slip past a check
 * written to catch invented ones.
 */
export function answersGates(
  ran: readonly Case[],
  rows: readonly { readonly case: string; readonly ok: boolean }[],
) {
  const gate = (pick: (c: Case) => boolean) =>
    ran.some(pick) ? [rows.filter((row) => ran.some((c) => c.id === row.case && pick(c)))] : [];
  return [
    ...gate((c) => c.exact).map((exact) =>
      noFailing("exact-value cases", exact.filter((row) => !row.ok).length, exact.length),
    ),
    ...gate((c) => c.answerable).map((answerable) =>
      atLeast(
        "answerability",
        FLOORS.answerability,
        answerable.filter((row) => row.ok).length,
        answerable.length,
      ),
    ),
  ];
}
