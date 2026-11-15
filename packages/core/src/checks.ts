// The server-side checks every upload goes through (contract §5): patterns that mean a file prints a secret.
// They err toward finding: a false hit only keeps a file in the vault, a miss would hand it to agents.

/** What a check found. Never the value itself. */
export type Finding = "mrz" | "iban" | "id-number" | "account-number";

/**
 * Every finding in `text`, each named once, in a stable order. Empty means the checks found nothing; whether
 * the text was all of the file is the caller's to know. Text OCR read (`ocr`) may have a digit wrong, so an IBAN
 * there counts by its shape, without its check digits.
 */
export function scan(text: string, read: "text" | "ocr" = "text"): Finding[] {
  const found = new Set<Finding>();
  if (mrzRuns(text).some(isMrz)) found.add("mrz");
  if (hasIban(text, read === "ocr")) found.add("iban");
  if (hasLabelled(ID_NUMBER, text) || SSN.test(text)) found.add("id-number");
  if (hasLabelled(ACCOUNT_NUMBER, text)) found.add("account-number");
  return FINDINGS.filter((finding) => found.has(finding));
}

const FINDINGS: readonly Finding[] = ["mrz", "iban", "id-number", "account-number"];

const runsIn = (part: string) => part.match(/[A-Za-z0-9<]+/g) ?? [];

// A long run, mostly capitals, with a filler pair is an MRZ line: every one has a `<<` (names, padding) except a
// passport's bottom line with its optional data filled, which its check digits give away. Prose comparisons
// ("<40 and <35") have no pair, and code that has one (`cout << value`) is mostly lower case. A few lower-case
// letters are allowed: a label glued on when spaces are removed ("Line1P<UTO..."), or an OCR `l` for `I`.
const isMrz = (run: string) =>
  (run.length >= 28 && run.includes("<<") && mostlyCapitals(run)) || isTd3Bottom(run.toUpperCase());
const mostlyCapitals = (run: string) =>
  (run.match(/[a-z]/g)?.length ?? 0) * 5 < (run.match(/[A-Za-z]/g)?.length ?? 0);

/**
 * Runs of MRZ characters, in order, read two ways: each line with its spaces removed (an OCR or a typist may
 * space out the fillers), and each word on its own (a label before the MRZ mustn't run into it). Quotes,
 * bullets and table bars end a run. An OCR may read a filler pair as a guillemet (`«`), or one as `‹`; a line
 * that also has a closing one (`»`, `›`) is quoting, as French and German documents do, and is left alone.
 */
function mrzRuns(raw: string): string[] {
  const lines = raw
    .split(/\r?\n|\r/)
    .map((line) =>
      /[\u00bb\u203a]/.test(line) ? line : line.replaceAll("\u00ab", "<<").replaceAll("\u2039", "<"),
    );
  const text = lines.join("\n");
  return [
    ...lines.flatMap((line) => runsIn(line.replaceAll(/\s/g, ""))),
    "",
    ...text.split(/\s+/).flatMap(runsIn),
  ];
}

// A label that names an identity or account number, then the number: at least 6 characters, 4 of them digits.
// Only "no", "number", "id", "is" and punctuation (markdown emphasis, CSV quotes, smart quotes and dashes) may
// come between, so "passport-size photo, 2026-11-02" isn't one. A number may be grouped with spaces after a
// prefix of up to three letters (`XK 1234567`, `1234 5678 9012`), never after a word.
// The em dash is built from its code point: the repo's lint keeps it out of copy, and this isn't copy.
const EM_DASH = String.fromCodePoint(0x2014);
// `#` is only a filler, never gap too: a character both may take backtracks polynomially on a run of them.
const GAP = `[\\s:.()*_"'\`,|=/\\-\u2018\u2019\u201c\u201d\u2013${EM_DASH}]*`;
const FILLER = "(?:(?:no|nos|number|num|nr|id|is)\\b|n\\.?[\u00b0\u00ba]|#)\\.?";
// One word in parentheses may follow the label: "Passport (UK): 123456789".
/** Horizontal space, however much: never a line break. */
const SPACE = "[^\\S\\r\\n]+";
// Every label is tried (a lookahead, so matches overlap): in "Passport No./Passeport No. 123456789" the first
// label reads the second as its number, and only the second pairs with the digits.
// `fillers` is how many filler words must come between, for a label that is also an ordinary word: `ACCT 2101`
// is a US course code, and Visa is an employer on a CV.
const labelled = (label: string, number: string, fillers = 0) =>
  new RegExp(
    `\\b(?=(?:${label})(?:['\u2019]s)?\\b${GAP}(?:\\([a-z ]{1,20}\\)${GAP})?(?:${FILLER}${GAP}){${fillers},2}(${number}))`,
    "gi",
  );
// Groups may be split by any run of space on the line (a tab in CSV, a no-break space in copied text). Bounded,
// so a label can't capture to the end of the text: with labels inside it (`ssn-ssn-...`) that would be quadratic.
const ID_DIGITS = `(?:[A-Z]{1,3}(?:${SPACE}|-)?)?\\d[\\dA-Z-]{0,24}(?:${SPACE}\\d[\\dA-Z-]{0,24}){0,5}|[A-Z0-9][A-Z0-9-]{5,24}`;
const ID_LABEL = labelled(
  "passport|passeport|passaporte|pasaporte|reisepass(?:nummer)?|national\\s+id(?:entity)?(?:\\s+card)?|nid|identity\\s+card|id\\s+card|social\\s+security|ssn|aadhaar|personalausweis|residence\\s+permit|tax\\s+id|driv(?:er['\u2019]?s|ing)\\s+licen[cs]e",
  ID_DIGITS,
);
const ID_NUMBER = [ID_LABEL, labelled("visa", ID_DIGITS, 1)];
// One space character per repetition: a run of them inside a repeated group backtracks exponentially. Periods
// count only between two or more groups (Norway's `1234.56.78903`), so a decimal like `3.00` never does.
const ACCOUNT_DIGITS = "\\d{2,}(?:\\.\\d{2,}){2,}|\\d(?:[^\\S\\r\\n]|[\\d-]){4,}\\d";
const ACCOUNT_NUMBER = [
  labelled("account|a\\/c|acct(?=[^\\S\\r\\n]*:)", ACCOUNT_DIGITS),
  labelled("acct", ACCOUNT_DIGITS, 1),
];
// An academic year (`2019-20`, `2019 - 2021`) after a label is a date, not a number.
const YEARS = /^(?:19|20)\d\d\s*[-\u2013]\s*(?:\d\d|(?:19|20)\d\d)$/;
const hasLabelled = (patterns: RegExp | readonly RegExp[], text: string) =>
  [patterns]
    .flat()
    .flatMap((pattern) => [...text.matchAll(pattern)])
    .some(
      ([, number = ""]) =>
        (number.match(/\d/g)?.length ?? 0) >= 4 &&
        number.replaceAll(/[\s.-]/g, "").length >= 6 &&
        !YEARS.test(number.trim()),
    );
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;

// IBAN lengths by country (the SWIFT registry). An unlisted country may be any legal length, 15 to 34.
const IBAN_LENGTHS = new Map(
  "AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BI27 BR29 BY28 CH21 CR22 CY28 CZ24 DE22 DJ27 DK18 DO28 EE20 EG29 ES24 FI18 FK18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 HN28 HR21 HU28 IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 LC32 LI21 LT20 LU20 LV21 LY25 MC27 MD24 ME22 MK19 MN20 MR27 MT31 MU30 NI28 NL18 NO15 OM23 PK24 PL28 PS29 PT25 QA29 RO24 RS22 RU33 SA24 SC31 SD18 SE24 SI19 SK24 SM27 SO23 ST25 SV28 TL23 TN24 TR26 UA29 VA22 VG24 XK20 YE30"
    .split(" ")
    .map((entry) => [entry.slice(0, 2), Number(entry.slice(2))] as const),
);

// An IBAN as printed: one unbroken token, or groups of four (spaces, dots, dashes or a line break between) with
// a shorter last group. Starts overlap, so `AB12` before the real IBAN can't swallow it. Only whole tokens or
// whole groups are tried: trying every length of text that runs on (a course code into its title) passes
// mod 97 about once in five lines.
const IBAN =
  /\b(?=([A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}\b|(?:[\s.-]+[A-Z0-9]{4}\b){2,8}(?:[\s.-]+[A-Z0-9]{1,3}\b)?)))/g;

// After an explicit `IBAN` label (`IBAN-Nr.:`, `My IBAN is`) any grouping counts (`DE89 370400440532013000`):
// the rest of the line is joined and tried at its country's length, which the label makes safe.
const LABELLED_IBAN = labelled(
  "iban(?:[\\s/-]*(?:bic|code|nummer))?",
  "[A-Z]{2}\\d{2}[A-Z0-9 \\t.\\u00a0-]{11,50}",
);

/** Whether `text` has an IBAN; `misread` (OCR's text) takes one of the right length without its mod 97. */
function hasIban(text: string, misread: boolean): boolean {
  const checks = (iban: string) => misread || mod97(iban) === 1;
  const upper = text.toUpperCase();
  for (const [, afterLabel = ""] of upper.matchAll(LABELLED_IBAN)) {
    const compact = afterLabel.replaceAll(/[^A-Z0-9]/g, "");
    const listed = IBAN_LENGTHS.get(compact.slice(0, 2));
    const lengths = listed === undefined ? Array.from({ length: 20 }, (_, i) => i + 15) : [listed];
    if (lengths.some((length) => compact.length >= length && checks(compact.slice(0, length)))) return true;
  }
  for (const [, candidate = ""] of upper.matchAll(IBAN)) {
    const groups = candidate.split(/[\s.-]+/);
    const tries = groups.map((_, i) => groups.slice(0, i + 1).join(""));
    const listed = IBAN_LENGTHS.get(candidate.slice(0, 2));
    const fits = (iban: string) =>
      listed === undefined ? iban.length >= 15 && iban.length <= 34 : iban.length === listed;
    if (tries.some((iban) => fits(iban) && checks(iban))) return true;
  }
  return false;
}

/** ISO 7064 mod 97-10 over an IBAN: the first four characters move to the end, letters count as 10 to 35. */
function mod97(iban: string): number {
  let rest = 0;
  for (const char of iban.slice(4) + iban.slice(0, 4)) {
    const value = Number.parseInt(char, 36);
    rest = (value > 9 ? rest * 100 + value : rest * 10 + value) % 97;
  }
  return rest;
}

/** What a passport's machine-readable zone says, every check digit verified. Names as the MRZ writes them. */
export interface Passport {
  /** The issuing state, ICAO's three-letter code (`D` for Germany). */
  readonly issuer: string;
  readonly number: string;
  readonly surname: string;
  readonly givenNames: string;
  readonly nationality: string;
  /** `YYYY-MM-DD`. The MRZ has two-digit years: a birth year ahead of `now` is in the last century. */
  readonly birthDate: string;
  /** `M`, `F` or `X`. */
  readonly sex: string;
  readonly expires: string;
}

/**
 * The passport (ICAO 9303 TD3: two lines of 44) in `text`, or `undefined` when there is none or a check digit
 * fails. A failed digit means a misread, and a misread number is worse than none.
 */
export function parsePassport(text: string, now: number): Passport | undefined {
  // A top line and the next long run in the same reading, if it is 44 (a short label like `MRZ:` may sit
  // between), or (spaces removed) one run of 88. A top line has no check digit, so only a whole run counts:
  // one cut out of a longer run, or one far from its bottom line, could pair the wrong name with a number.
  const runs = mrzRuns(text).map((run) => run.toUpperCase());
  // The next long run (or the readings' separator) after each run, found in one pass from the end.
  const nextLong: (string | undefined)[] = [];
  for (let i = runs.length - 1, found: string | undefined; i >= 0; i--) {
    nextLong[i] = found;
    const run = runs[i] ?? "";
    if (run === "" || run.length >= 28) found = run;
  }
  for (const [i, run] of runs.entries()) {
    const next = nextLong[i];
    const bottom = next?.length === 44 ? next : "";
    const passport = run.length === 88 ? td3(run.slice(0, 44), run.slice(44), now) : td3(run, bottom, now);
    if (passport) return passport;
  }
  return undefined;
}

/** A TD3 bottom line whose number, birth date and expiry check digits hold. */
function isTd3Bottom(bottom: string): boolean {
  const checked = (from: number, to: number) =>
    checkDigit(bottom.slice(from, to)) === bottom.slice(to, to + 1);
  return bottom.length === 44 && checked(0, 9) && checked(13, 19) && checked(21, 27);
}

function td3(top: string, bottom: string, now: number): Passport | undefined {
  if (!/^P[A-Z<][A-Z<]{3}[A-Z<]{39}$/.test(top) || !/^[A-Z0-9<]{44}$/.test(bottom)) return undefined;
  const field = (from: number, to: number) => bottom.slice(from, to);
  const checked = (from: number, to: number) => checkDigit(field(from, to)) === field(to, to + 1);
  const composite = field(0, 10) + field(13, 20) + field(21, 43);
  // Optional data left empty may carry a filler instead of its check digit.
  const optional = checked(28, 42) || /^<{15}$/.test(field(28, 43));
  if (!checked(0, 9) || !checked(13, 19) || !checked(21, 27) || !optional) return undefined;
  if (checkDigit(composite) !== field(43, 44)) return undefined;
  const year = new Date(now).getUTCFullYear() % 100;
  const birthDate = date(field(13, 19), (yy) => (yy > year ? 1900 : 2000));
  const expires = date(field(21, 27), () => 2000);
  const sex = field(20, 21);
  if (!birthDate || !expires || !/^[MFX<]$/.test(sex)) return undefined;
  // No check digit covers the nationality: letters only, as ICAO writes it, so a misread `UT0` isn't one.
  if (!/^[A-Z<]{3}$/.test(field(10, 13))) return undefined;
  const [surname = "", given = ""] = top.slice(5).split("<<");
  return {
    issuer: code(top.slice(2, 5)),
    number: code(field(0, 9)),
    surname: name(surname),
    givenNames: name(given),
    nationality: code(field(10, 13)),
    birthDate,
    sex: sex === "<" ? "X" : sex,
    expires,
  };
}

/** A name field: fillers between words are spaces. */
const name = (part: string) => part.replaceAll(/<+/g, " ").trim();
/** A code or number field, without its trailing fillers. */
const code = (part: string) => part.replaceAll("<", "");

/** ICAO 9303's check digit: weights 7, 3, 1; digits as themselves, A to Z as 10 to 35, the filler as 0. */
function checkDigit(chars: string): string {
  let sum = 0;
  for (const [i, char] of [...chars].entries())
    sum += (char === "<" ? 0 : Number.parseInt(char, 36)) * ([7, 3, 1][i % 3] ?? 0);
  return String(sum % 10);
}

function date(yymmdd: string, century: (yy: number) => number): string | undefined {
  if (!/^\d{6}$/.test(yymmdd)) return undefined;
  const yy = Number(yymmdd.slice(0, 2));
  const iso = `${century(yy) + yy}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
  // Rejects month 13 and February 30 alike.
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(iso) ? iso : undefined;
}
