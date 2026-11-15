// The safety net under `ask {mode: "verify"}` (docs/internals/retrieval.md): numbers and dates a draft states that
// no checked claim covers. Prose around them isn't checked; Brainiac doesn't claim it is.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?`;
const DAY = String.raw`(\d{1,2})(?:st|nd|rd|th)?`;
/** Between a day and its month: "2 November", "the 2nd of November". */
const OF = String.raw`(?: of)?`;

const mm = (month: string) => String(MONTHS.indexOf(month.toLowerCase().slice(0, 3)) + 1).padStart(2, "0");
const dd = (day: string) => day.padStart(2, "0");

/**
 * Dates as people write them, each read as an ISO date, a year and month (`2028-11`), or a day and month without a
 * year (`--11-02`), in the order they're tried.
 */
const DATES: readonly [RegExp, (m: RegExpMatchArray) => string][] = [
  [/\b(\d{4})-(\d{2})-(\d{2})\b/g, ([, y, m, d]) => `${y}-${m}-${d}`],
  // Day first, as German and much of the world write it: 30.09.2025.
  [/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g, ([, d = "", m = "", y]) => `${y}-${dd(m)}-${dd(d)}`],
  [
    new RegExp(String.raw`\b${DAY}${OF} ${MONTH},? (\d{4})\b`, "gi"),
    ([, d = "", m = "", y]) => `${y}-${mm(m)}-${dd(d)}`,
  ],
  [
    new RegExp(String.raw`\b${MONTH} ${DAY},? (\d{4})\b`, "gi"),
    ([, m = "", d = "", y]) => `${y}-${mm(m)}-${dd(d)}`,
  ],
  [new RegExp(String.raw`\b${MONTH},? (\d{4})\b`, "gi"), ([, m = "", y]) => `${y}-${mm(m)}`],
  [new RegExp(String.raw`\b${DAY}${OF} ${MONTH}`, "gi"), ([, d = "", m = ""]) => `--${mm(m)}-${dd(d)}`],
  [new RegExp(String.raw`\b${MONTH} ${DAY}\b`, "gi"), ([, m = "", d = ""]) => `--${mm(m)}-${dd(d)}`],
];

/**
 * A cite as `ask` gives one (`<note id>#sections.writing@2`, `file:<sha256>#p1`), or one naming the note by its
 * path (`facts/tests/ielts-2026-11.md#overall@2`): its digits are no claim.
 */
// The path starts at a boundary, so a long run with no spaces is read once, not from every character in it.
const CITE = /\b[0-9A-Z]{26}#[\w.]+@\d+|file:[0-9a-f]+#p\d+|(?<![^\s()[\]])[^\s()[\]]+\.md#[\w.]+@\d+/g;

// A number standing alone, not part of a code like B2, v3 or 26GB001234: thousands may be grouped (1,234), a place may
// be an ordinal (1st, 3rd), a decimal may have no leading zero (.5), and a unit may follow it (50k, 5pm), as long as
// no digit comes after the unit.
// shortcut: ASCII digits only, and a unit before a number with no space ("Tk50,000") hides it; neither is read until
// a case shows one.
const NUMBERS =
  /(?<![\p{L}\p{N}.])(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:st|nd|rd|th)?(?!\p{L}*\p{N}|\.\d|,\d{3}(?!\d))/gu;

/** The numbers standing alone in `text`, with a minus sign when one starts the number ("-7", ":-7"; not "3-5"). */
export const numbersIn = (text: string) =>
  Array.from(text.matchAll(NUMBERS), ({ 0: n, index }) => {
    const negative = /[-\u2212]/.test(text[index - 1] ?? "") && !/[\p{L}\p{N}]/u.test(text[index - 2] ?? "");
    const value = Number(n.replaceAll(",", "").replace(/[a-z]+$/, ""));
    return { text: negative ? `-${n}` : n, value: negative ? -value : value, at: index };
  });

const blank = (text: string, pattern: RegExp) =>
  text.replaceAll(pattern, (found) => " ".repeat(found.length));

/** `text` with every cite blanked, so a cite's revision or page is never read as a number. */
export const withoutCites = (text: string) => blank(text, CITE);

/** `text` as an exact pattern that matches only whole, not inside a longer word or number. */
const whole = (text: string) =>
  new RegExp(
    String.raw`(?<![\p{L}\p{N}.])${text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\p{L}\p{N}]|\.\d)`,
    "gu",
  );

/**
 * The dates in `text`, each with the ISO date (or year and month) it reads as and where it starts, and the text
 * with them blanked, so their parts aren't read again as a shorter date or as numbers.
 */
export function datesIn(text: string) {
  const dates: { readonly text: string; readonly iso: string; readonly at: number }[] = [];
  let rest = text;
  for (const [pattern, iso] of DATES) {
    for (const match of rest.matchAll(pattern))
      dates.push({ text: match[0], iso: iso(match), at: match.index ?? 0 });
    rest = blank(rest, pattern);
  }
  return { dates: dates.toSorted((a, b) => a.at - b.at), rest };
}

const NUMERIC = /^\s*-?\d+(?:\.\d+)?\s*$/;
const ISO_DATE = /^(\d{4})-\d{2}(-\d{2})?/;

/**
 * Whether a claimed value covers a date the text says: a claimed date covers the same date written less precisely
 * ("November 2028" or "2 November" by `2028-11-02`), never a more precise one, which the record doesn't hold.
 */
const covers = (claimed: string, iso: string) =>
  iso.startsWith("--")
    ? ISO_DATE.test(claimed) && claimed.slice(4, 10) === iso.slice(1)
    : claimed.startsWith(iso);

/** The numbers a claimed value is, in any of its spellings: 7, "7.0". */
const numbersOf = (spellings: readonly unknown[]) =>
  new Set(
    spellings.flatMap((v) =>
      typeof v === "number" ? [v] : typeof v === "string" && NUMERIC.test(v) ? [Number(v)] : [],
    ),
  );

/**
 * The numbers and dates in `text` that none of `claims` (each a matched claim's value, in its spellings: the claim's
 * own and the record's) covers. Only a single value covers anything: a claim of a whole mapping (`sections`) would
 * cover every number in it, the wrong one too. A number is covered by a claim of that number, one mention per claim,
 * since IELTS bands repeat ("writing 7.0, reading 7.0" needs both claimed); a year by a claimed date in it; a date by
 * a claimed date as precise or more (`covers`); and text quoting a claimed value whole ("TUM MSc Informatics, Winter
 * 2027") is covered, digits and all. Cites are skipped.
 */
export function uncited(
  text: string,
  claims: readonly (readonly unknown[])[],
): { readonly text: string; readonly kind: "date" | "number" }[] {
  const strings = claims.flat().flatMap((v) => (typeof v === "string" && v.trim() !== "" ? [v] : []));
  const left = new Map<number, number>();
  for (const claim of claims) for (const n of numbersOf(claim)) left.set(n, (left.get(n) ?? 0) + 1);
  const years = new Set(strings.flatMap((s) => (ISO_DATE.test(s) ? [Number(s.slice(0, 4))] : [])));
  // Blanked rather than cut, so what's left keeps its positions for the order of the answer. A number claimed as
  // text ("7") is compared as a number, never blanked, or it would blank the 7 of "7.5".
  let quoted = withoutCites(text);
  for (const value of strings) if (!NUMERIC.test(value)) quoted = blank(quoted, whole(value));
  const { dates, rest } = datesIn(quoted);
  const found = [
    ...dates
      .filter(({ iso }) => !strings.some((s) => covers(s, iso)))
      .map((d) => ({ ...d, kind: "date" as const })),
    ...numbersIn(rest)
      .filter((n) => {
        if (years.has(n.value)) return false;
        const claimed = left.get(n.value) ?? 0;
        left.set(n.value, claimed - 1);
        return claimed <= 0;
      })
      .map((n) => ({ ...n, kind: "number" as const })),
  ];
  // In the order the text says them, each once.
  return found
    .toSorted((a, b) => a.at - b.at)
    .filter((f, i, sorted) => sorted.findIndex((g) => g.text === f.text) === i)
    .map(({ text: said, kind }) => ({ text: said, kind }));
}
