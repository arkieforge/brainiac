// Overview and review (docs/product/features/review.md): a headline and a mark for every item, and the
// deterministic detectors that flag what looks wrong. Pure over parsed notes, so the site, the record's tools
// and a laptop copy all judge alike. Nothing here guesses: a flag names the stored values it compared, and a fix
// is offered only when the record itself says what the value should be.
import type { PatchOp, YamlValue } from "./patch.ts";
import { PathError, pathKey, resolveRelation } from "./paths.ts";
import type { Manifest } from "./schema.ts";
import { isUlid } from "./ids.ts";
import { driftChecks } from "./profiles.ts";

/** A note as the detectors read it: its front-matter, parsed. */
export interface ReviewNote {
  readonly id: string;
  readonly path: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** ✓ checked, ! looks wrong, ? unchecked or unproven, stale (checked over a year ago), conflict. */
export type Mark = "checked" | "wrong" | "unproven" | "stale" | "conflict";

export type Detector =
  /** The note disagrees with what its own document says. */
  | "document"
  /** Two notes about the same item disagree. */
  | "conflict"
  /** Two notes are the same item. */
  | "duplicate"
  /** A value that can't be: an end before its start, a score above the test's maximum. */
  | "impossible"
  /** A fact with no document or source behind it. */
  | "proof"
  /** One name written two ways. */
  | "spelling"
  /** An item an open application relies on runs out before the date it must be valid on. */
  | "expired"
  /** Checked, but over a year ago. */
  | "stale"
  /** One of the person's own profiles (LinkedIn, X, Google Scholar) says something else than the record. */
  | "drift"
  /** A saved link an open application relies on is gone (404 or 410 at its last check). */
  | "dead"
  /** A profile couldn't be read, or isn't shown to be the person's yet, so nothing was compared. */
  | "unchecked";

export interface Check {
  readonly noteId: string;
  readonly detector: Detector;
  readonly field?: string;
  /** What was found, from stored values: `transcript p2 says 3.71`. */
  readonly evidence: string;
  /** The other notes the evidence comes from. */
  readonly related: readonly string[];
  /** The fix the record itself suggests: set this field to this value. */
  readonly fix?: { readonly field: string; readonly value: YamlValue };
  /** For drift, the record's text to paste into the outside profile so it says the same. */
  readonly paste?: string;
}

export interface Item {
  readonly noteId: string;
  readonly path: string;
  readonly type: string;
  readonly headline: string;
  readonly mark: Mark;
  readonly checks: readonly Check[];
  /** The fields the person verified. */
  readonly verified: readonly string[];
  /** The open applications that rely on this item. */
  readonly usedBy: readonly string[];
  /** A newer note supersedes this one: history, not current. */
  readonly superseded: boolean;
  /** One short line beside the headline: the first flag's evidence, or what proves it. */
  readonly aside: string;
}

export interface Overview {
  /** Grouped by type in the manifest's order, then by path. */
  readonly items: readonly Item[];
  readonly counts: Readonly<Record<Mark, number>> & { readonly items: number };
}

const YEAR_MS = 365 * 24 * 60 * 60_000;
/** Fields that hold structure, not a value someone could mistype. */
const STRUCTURAL = new Set([
  "id",
  "type",
  "title",
  "verified",
  "sources",
  "supersedes",
  "proves",
  "requirements",
]);
/** Requirement check keys that aren't field filters. */
const CHECK_KEYS = new Set(["type", "field", "gte", "lte", "gt", "lt", "valid_on", "count_gte", "for"]);
/** Pairs of dates where the second can't come before the first. */
const DATE_ORDER = [
  ["start", "end"],
  ["issued", "expires"],
  ["date", "expires"],
] as const;

/** What each test's scores can be: overall and section ranges, and the step bands move in. */
const TESTS: Readonly<
  Record<
    string,
    {
      readonly overall: readonly [number, number];
      readonly section: readonly [number, number];
      readonly step: number;
    }
  >
> = {
  "ielts-academic": { overall: [0, 9], section: [0, 9], step: 0.5 },
  "ielts-general": { overall: [0, 9], section: [0, 9], step: 0.5 },
  "toefl-ibt": { overall: [0, 120], section: [0, 30], step: 1 },
  gre: { overall: [260, 340], section: [130, 170], step: 1 },
};

const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const isDate = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value);
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const today = (now: number) => new Date(now).toISOString().slice(0, 10);

/** A value as a line of text shows it. */
export function show(value: unknown): string {
  if (Array.isArray(value)) return value.map(show).join(", ");
  if (isRecord(value))
    return Object.entries(value)
      .map(([key, v]) => `${key} ${show(v)}`)
      .join(", ");
  return String(value);
}

/** Equal as values: numbers as numbers, text ignoring case and spacing, collections item by item. */
function same(a: unknown, b: unknown): boolean {
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  if (typeof a === "string" && typeof b === "string")
    return a.trim().replaceAll(/\s+/g, " ").toLowerCase() === b.trim().replaceAll(/\s+/g, " ").toLowerCase();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => same(a[key], b[key]));
  }
  return a === b;
}

/** The fields a note's `verified` block names; every field when it names none (as approvals read it). */
function verifiedFields(data: Readonly<Record<string, unknown>>): string[] {
  const block = data["verified"];
  if (!isRecord(block)) return [];
  const fields = block["fields"];
  return Array.isArray(fields) && fields.every((f) => typeof f === "string")
    ? fields.map((f: string) => f.split(".")[0] ?? f)
    : Object.keys(data).filter((key) => key !== "verified");
}

/** The fields one review covers: the type's own values, never its structure. */
export function reviewFields(data: Readonly<Record<string, unknown>>, manifest: Manifest | null): string[] {
  const spec = specOf(manifest, data);
  return Object.keys(data).filter((key) => {
    if (STRUCTURAL.has(key)) return false;
    const kind = spec?.fields[key]?.kind;
    if (spec) return Object.hasOwn(spec.fields, key) && kind !== "list" && kind !== "relation";
    return !Array.isArray(data[key]);
  });
}

/**
 * The edit "Correct" makes: `verified` for the fields shown, at the revision the person saw. Inside a review
 * session the record lets it through on the session's one signature (contract §4).
 */
export function verifyOps(
  data: Readonly<Record<string, unknown>>,
  manifest: Manifest | null,
  rev: number,
  now: number,
): PatchOp[] {
  const fields = reviewFields(data, manifest);
  return [{ op: "set", path: ["verified"], value: { by: "human", at: today(now), rev, fields } }];
}

const specOf = (manifest: Manifest | null, data: Readonly<Record<string, unknown>>) => {
  const type = str(data["type"]);
  return manifest && type !== undefined && Object.hasOwn(manifest.types, type)
    ? manifest.types[type]
    : undefined;
};

/**
 * One line for an item from its type's `headline` template: `{field}` is the value, `{field|year}` its year,
 * `{field|month}` its month, `{field|1}` a number to one decimal. Parts are separated by ` · `; a part with a
 * missing value is left out, so a headline never shows a blank or a guess. No template: the title.
 */
export function headline(note: ReviewNote, manifest: Manifest | null): string {
  const title = str(note.data["title"]) ?? note.path;
  const template = specOf(manifest, note.data)?.headline;
  if (template === undefined) return title;
  const parts = template.split(" · ").flatMap((part) => {
    let missing = false;
    const filled = part.replaceAll(/\{([\w.]+)(?:\|(\w+))?\}/g, (_, field: string, format?: string) => {
      // `{synced.venue}` reaches into a mapping, such as the block a connector fills.
      const value =
        field === "title"
          ? title
          : field.split(".").reduce<unknown>((at, key) => (isRecord(at) ? at[key] : undefined), note.data);
      if (value === undefined || value === null || value === "") {
        missing = true;
        return "";
      }
      // A registry's date may be only a month or a year (`2026-03`, `2026`).
      if (format === "year" && typeof value === "string" && /^\d{4}(?:-|$)/.test(value))
        return value.slice(0, 4);
      if (format === "month" && isDate(value)) return value.slice(0, 7);
      if (format !== undefined && /^\d$/.test(format) && typeof value === "number")
        return value.toFixed(Number(format));
      return show(value);
    });
    return missing ? [] : [filled];
  });
  return parts.length > 0 ? parts.join(" · ") : title;
}

/** Finds notes by relation (a path relative to the note, or an id), as the record resolves them. */
export function resolver(notes: readonly ReviewNote[]) {
  const byPath = new Map(notes.map((note) => [pathKey(note.path), note]));
  const byId = new Map(notes.map((note) => [note.id, note]));
  return (from: ReviewNote, relation: unknown): ReviewNote | undefined => {
    if (typeof relation !== "string") return undefined;
    if (isUlid(relation)) return byId.get(relation);
    try {
      const target = byPath.get(pathKey(resolveRelation(from.path, relation)));
      return target?.id === from.id ? undefined : target;
    } catch (error) {
      if (error instanceof PathError) return undefined;
      throw error;
    }
  };
}

const labelOf = (note: ReviewNote) => str(note.data["title"]) ?? note.path;
const listOf = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];

/** Every check on the record, note by note in path order. */
export function detect(notes: readonly ReviewNote[], manifest: Manifest | null, now: number): Check[] {
  const resolve = resolver(notes);
  const superseded = new Set(
    notes.flatMap((note) => {
      const target = resolve(note, note.data["supersedes"]);
      return target ? [target.id] : [];
    }),
  );
  const verified = new Map(notes.map((note) => [note.id, new Set(verifiedFields(note.data))]));
  const checks: Check[] = [];
  const add = (check: Check) => {
    // A name or value the person checked on this note isn't flagged for disagreeing with another note.
    if ((check.detector === "spelling" || check.detector === "conflict") && check.field !== undefined)
      if (verified.get(check.noteId)?.has(check.field)) return;
    checks.push(check);
  };
  const current = notes.filter((note) => !superseded.has(note.id));

  for (const note of notes) {
    documents(note, notes, resolve, add);
    impossible(note, add);
  }
  for (const note of current) {
    proof(note, notes, resolve, manifest, add);
    stale(note, now, add);
  }
  sameItems(current, manifest, verified, add);
  spellings(current, manifest, verified, add);
  expiries(notes, current, resolve, now, add);
  deadLinks(notes, current, resolve, now, add);
  for (const check of driftChecks(notes)) add(check);
  const order = new Map(notes.map((note, i) => [note.id, i]));
  return checks.toSorted((a, b) => (order.get(a.noteId) ?? 0) - (order.get(b.noteId) ?? 0));
}

type Add = (check: Check) => void;
type Resolve = ReturnType<typeof resolver>;

/**
 * Note vs its own document: each source names a document and the fields it proves; the document's `extracted`
 * mapping is what it says. A document that proves the note and expires must expire when the note does.
 */
function documents(note: ReviewNote, notes: readonly ReviewNote[], resolve: Resolve, add: Add) {
  const seen = new Set<string>();
  for (const source of listOf(note.data["sources"])) {
    if (!isRecord(source)) continue;
    const doc = resolve(note, source["resource"]);
    const extracted = doc?.data["extracted"];
    if (!doc || !isRecord(extracted)) continue;
    const page = source["page"];
    const where = `${labelOf(doc)}${typeof page === "number" ? ` p${page}` : ""}`;
    const fields = Array.isArray(source["fields"])
      ? source["fields"].filter((f) => typeof f === "string")
      : [];
    for (const field of fields.length > 0 ? fields : Object.keys(extracted)) {
      const said = extracted[field];
      const value = note.data[field];
      if (said === undefined || value === undefined || same(value, said) || seen.has(field)) continue;
      seen.add(field);
      add({
        noteId: note.id,
        detector: "document",
        field,
        evidence: `${where} says ${show(said)}`,
        related: [doc.id],
        fix: { field, value: said as YamlValue },
      });
    }
  }
  const expires = note.data["expires"];
  if (!isDate(expires) || seen.has("expires")) return;
  for (const doc of notes) {
    if (doc.id === note.id || !listOf(doc.data["proves"]).some((p) => resolve(doc, p)?.id === note.id))
      continue;
    const said = doc.data["expires"];
    if (!isDate(said) || said === expires) continue;
    add({
      noteId: note.id,
      detector: "document",
      field: "expires",
      evidence: `${labelOf(doc)} says it expires ${said}`,
      related: [doc.id],
      fix: { field: "expires", value: said },
    });
    return;
  }
}

/** Values that can't be: dates out of order, a grade above its scale, a score outside what the test gives. */
function impossible(note: ReviewNote, add: Add) {
  const { data } = note;
  for (const [first, second] of DATE_ORDER) {
    const a = data[first];
    const b = data[second];
    if (isDate(a) && isDate(b) && b < a)
      add({
        noteId: note.id,
        detector: "impossible",
        field: second,
        evidence: `${second} ${b} is before ${first} ${a}`,
        related: [],
      });
  }
  const cgpa = data["cgpa"];
  const scale = data["scale"];
  if (typeof cgpa === "number" && (cgpa < 0 || (typeof scale === "number" && cgpa > scale)))
    add({
      noteId: note.id,
      detector: "impossible",
      field: "cgpa",
      evidence:
        typeof scale === "number" && cgpa > scale
          ? `${cgpa} is above the scale of ${scale}`
          : `${cgpa} is below 0`,
      related: [],
    });
  const test = str(data["test"]);
  const range = test !== undefined && Object.hasOwn(TESTS, test) ? TESTS[test] : undefined;
  if (!range || test === undefined) return;
  const outside = (value: number, [lo, hi]: readonly [number, number]) =>
    value < lo || value > hi || Math.abs(value / range.step - Math.round(value / range.step)) > 1e-9;
  const overall = data["overall"];
  const off = (value: number, bounds: readonly [number, number]) =>
    `${value} isn't a ${test} score (${bounds[0]} to ${bounds[1]}${range.step < 1 ? ` in steps of ${range.step}` : ""})`;
  if (typeof overall === "number" && outside(overall, range.overall))
    add({
      noteId: note.id,
      detector: "impossible",
      field: "overall",
      evidence: off(overall, range.overall),
      related: [],
    });
  const sections = data["sections"];
  if (!isRecord(sections)) return;
  const bad = Object.entries(sections).find(([, v]) => typeof v === "number" && outside(v, range.section));
  if (bad)
    add({
      noteId: note.id,
      detector: "impossible",
      field: "sections",
      evidence: `${bad[0]} ${off(Number(bad[1]), range.section)}`,
      related: [],
    });
  // IELTS: the overall band is the mean of the four sections, rounded to the nearest half (a quarter rounds up).
  const values = Object.values(sections);
  if (
    test.startsWith("ielts") &&
    !bad &&
    typeof overall === "number" &&
    values.length === 4 &&
    values.every((v) => typeof v === "number")
  ) {
    const mean = values.reduce((sum: number, v) => sum + Number(v), 0) / 4;
    const band = Math.round(mean * 2) / 2;
    if (band !== overall)
      add({
        noteId: note.id,
        detector: "impossible",
        field: "overall",
        evidence: `The sections average ${mean}, which is a band of ${band.toFixed(1)}`,
        related: [],
        fix: { field: "overall", value: band },
      });
  }
}

/** A held fact (an achievement, a score, a role) with nothing behind it. */
function proof(
  note: ReviewNote,
  notes: readonly ReviewNote[],
  resolve: Resolve,
  manifest: Manifest | null,
  add: Add,
) {
  if (!specOf(manifest, note.data)?.held || note.data["file"] !== undefined) return;
  const sources = listOf(note.data["sources"]).filter(isRecord);
  const broken = sources.find((source) => !resolve(note, source["resource"]));
  if (broken) {
    add({
      noteId: note.id,
      detector: "proof",
      field: "sources",
      evidence: `Its source ${show(broken["resource"])} isn't in the record`,
      related: [],
    });
    return;
  }
  if (sources.length > 0) return;
  const proven = notes.some((doc) => listOf(doc.data["proves"]).some((p) => resolve(doc, p)?.id === note.id));
  if (!proven)
    add({ noteId: note.id, detector: "proof", evidence: "No document or source backs it", related: [] });
}

function stale(note: ReviewNote, now: number, add: Add) {
  const block = note.data["verified"];
  const at = isRecord(block) ? block["at"] : undefined;
  if (isDate(at) && now - Date.parse(at) > YEAR_MS)
    add({
      noteId: note.id,
      detector: "stale",
      evidence: `Checked ${at.slice(0, 10)}, over a year ago`,
      related: [],
    });
}

/**
 * Note vs note: notes of a type whose manifest `key` values match are one item. Differing values are a conflict
 * (fixed to the other note's value only when the person verified it there); identical ones are duplicates.
 */
function sameItems(
  notes: readonly ReviewNote[],
  manifest: Manifest | null,
  verified: ReadonlyMap<string, ReadonlySet<string>>,
  add: Add,
) {
  const groups = new Map<string, ReviewNote[]>();
  for (const note of notes) {
    const key = specOf(manifest, note.data)?.key;
    if (!key || key.length === 0) continue;
    const values = key.map((field) => note.data[field]);
    if (values.some((v) => v === undefined || v === null || v === "")) continue;
    const id = JSON.stringify([
      note.data["type"],
      ...values.map((v) => (typeof v === "string" ? fold(v) : v)),
    ]);
    groups.set(id, [...(groups.get(id) ?? []), note]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // The note the person verified most of is the one the others are measured against.
    const ranked = group.toSorted(
      (a, b) => (verified.get(b.id)?.size ?? 0) - (verified.get(a.id)?.size ?? 0),
    );
    const [first, ...rest] = ranked;
    if (!first) continue;
    const spec = specOf(manifest, first.data);
    const comparable = Object.keys(spec?.fields ?? {}).filter((field) => {
      const kind = spec?.fields[field]?.kind;
      return (
        !STRUCTURAL.has(field) && kind !== "list" && kind !== "relation" && !(spec?.key ?? []).includes(field)
      );
    });
    for (const [i, note] of ranked.entries())
      for (const other of ranked.slice(i + 1))
        for (const field of comparable) {
          const a = note.data[field];
          const b = other.data[field];
          if (a === undefined || b === undefined || same(a, b)) continue;
          const pair: [ReviewNote, ReviewNote, unknown][] = [
            [note, other, b],
            [other, note, a],
          ];
          for (const [self, them, theirs] of pair)
            add({
              noteId: self.id,
              detector: "conflict",
              field,
              evidence: `${labelOf(them)} says ${show(theirs)}`,
              related: [them.id],
              ...(verified.get(them.id)?.has(field) && { fix: { field, value: theirs as YamlValue } }),
            });
        }
    for (const note of rest) {
      const differs = comparable.some((field) => {
        const a = note.data[field];
        const b = first.data[field];
        return a !== undefined && b !== undefined && !same(a, b);
      });
      if (!differs)
        add({
          noteId: note.id,
          detector: "duplicate",
          evidence: `Same item as ${labelOf(first)}`,
          related: [first.id],
        });
    }
  }
}

/** Case, accents, spacing and punctuation folded away. */
const fold = (text: string) =>
  text
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, "");

/** Optimal string alignment distance, stopping early past 1. */
function nearlySame(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d = Math.min(d, (prev2[j - 2] ?? 0) + 1);
      row.push(d);
    }
    prev2 = prev;
    prev = row;
  }
  return (prev[b.length] ?? 2) <= 1;
}

/**
 * Two spellings of one name: the same once case, accents and punctuation are folded, or one word apart by a
 * single typo. Only a word of five letters or more, starting with the same letter and holding no digits, may
 * differ, so "BSc" and "MSc", or "2021" and "2022", are never one name.
 */
function oneName(a: string, b: string): boolean {
  if (a === b) return false;
  if (fold(a) === fold(b)) return fold(a).length > 0;
  const wa = a
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const wb = b
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (wa.length !== wb.length) return false;
  const differing = wa.flatMap((word, i) => (word === wb[i] ? [] : [[word, wb[i] ?? ""] as const]));
  if (differing.length !== 1) return false;
  const [[x, y] = ["", ""]] = differing;
  return x.length >= 5 && y.length >= 5 && x[0] === y[0] && !/\d/.test(x + y) && nearlySame(x, y);
}

/**
 * Names written two ways across the record's text fields (an institution, an employer, an issuer). The spelling
 * most notes use wins, then a verified one; a tie between unverified spellings flags each with no fix.
 */
function spellings(
  notes: readonly ReviewNote[],
  manifest: Manifest | null,
  verified: ReadonlyMap<string, ReadonlySet<string>>,
  add: Add,
) {
  const uses: { note: ReviewNote; field: string; value: string }[] = [];
  for (const note of notes) {
    const spec = specOf(manifest, note.data);
    if (!spec) continue;
    for (const [field, fieldSpec] of Object.entries(spec.fields)) {
      const value = note.data[field];
      if ((fieldSpec.kind ?? "text") !== "text" || fieldSpec.values || typeof value !== "string") continue;
      if (STRUCTURAL.has(field) || /^secret:|:\/\//.test(value) || /\d{4,}/.test(value)) continue;
      uses.push({ note, field, value });
    }
  }
  const spellingsOf = new Map<string, typeof uses>();
  for (const use of uses) spellingsOf.set(use.value, [...(spellingsOf.get(use.value) ?? []), use]);
  const names = [...spellingsOf.keys()];
  for (const [i, a] of names.entries())
    for (const b of names.slice(i + 1)) {
      if (!oneName(a, b)) continue;
      const usesA = spellingsOf.get(a) ?? [];
      const usesB = spellingsOf.get(b) ?? [];
      const checkedA = usesA.some((u) => verified.get(u.note.id)?.has(u.field));
      const checkedB = usesB.some((u) => verified.get(u.note.id)?.has(u.field));
      const winner =
        usesA.length !== usesB.length
          ? usesA.length > usesB.length
            ? a
            : b
          : checkedA !== checkedB
            ? checkedA
              ? a
              : b
            : undefined;
      for (const [mine, theirs, other] of [
        [usesA, usesB, b],
        [usesB, usesA, a],
      ] as const) {
        if (winner !== undefined && winner !== mine[0]?.value) {
          for (const use of mine)
            add({
              noteId: use.note.id,
              detector: "spelling",
              field: use.field,
              evidence: `${labelOf(theirs[0]?.note ?? use.note)} spells it ${other}`,
              related: [...new Set(theirs.map((u) => u.note.id))],
              fix: { field: use.field, value: other },
            });
        }
        if (winner === undefined)
          for (const use of mine)
            add({
              noteId: use.note.id,
              detector: "spelling",
              field: use.field,
              evidence: `${labelOf(theirs[0]?.note ?? use.note)} spells it ${other}`,
              related: [...new Set(theirs.map((u) => u.note.id))],
            });
      }
    }
}

const BOUNDS = {
  gte: (value: number, bound: number) => value >= bound,
  lte: (value: number, bound: number) => value <= bound,
  gt: (value: number, bound: number) => value > bound,
  lt: (value: number, bound: number) => value < bound,
};

/** A requirement check's `field` meets its bounds (`gte: 6.5`): a score too low never stands in for one that counts. */
function meetsBounds(note: ReviewNote, check: Readonly<Record<string, unknown>>): boolean {
  const field = check["field"];
  if (typeof field !== "string") return true;
  const value = note.data[field];
  return Object.entries(BOUNDS).every(([key, holds]) => {
    const bound = check[key];
    return typeof bound !== "number" || (typeof value === "number" && holds(value, bound));
  });
}

const isOpen = (note: ReviewNote) => note.data["type"] === "Application" && note.data["status"] !== "decided";

/** The current notes an open application's requirement check matches, for every open application. */
export function usedBy(notes: readonly ReviewNote[], now: number): Map<string, string[]> {
  const resolve = resolver(notes);
  const superseded = new Set(notes.flatMap((n) => [resolve(n, n.data["supersedes"])?.id ?? []].flat()));
  const current = notes.filter((n) => !superseded.has(n.id));
  const used = new Map<string, string[]>();
  for (const { application, matches } of requirements(notes, current, resolve, now))
    for (const match of matches)
      used.set(match.id, [...new Set([...(used.get(match.id) ?? []), application.id])]);
  return used;
}

function* requirements(
  notes: readonly ReviewNote[],
  current: readonly ReviewNote[],
  resolve: Resolve,
  now: number,
) {
  for (const application of notes.filter(isOpen))
    for (const requirement of listOf(application.data["requirements"])) {
      const check = isRecord(requirement) ? requirement["check"] : undefined;
      if (!isRecord(check) || typeof check["type"] !== "string") continue;
      const matches = current.filter(
        (note) =>
          note.data["type"] === check["type"] &&
          meetsBounds(note, check) &&
          Object.entries(check).every(([key, want]) => {
            if (key === "for")
              return want !== "this" || resolve(note, note.data["for"])?.id === application.id;
            return CHECK_KEYS.has(key) || same(note.data[key], want);
          }),
      );
      const validOn = check["valid_on"];
      const on =
        typeof validOn === "string" && isDate(application.data[validOn])
          ? String(application.data[validOn])
          : undefined;
      yield {
        application,
        requirement,
        matches,
        on: on ?? today(now),
        named: on !== undefined ? String(validOn) : undefined,
      };
    }
}

/** An item an open application relies on that runs out before the date it must be valid on, with no valid one beside it. */
function expiries(
  notes: readonly ReviewNote[],
  current: readonly ReviewNote[],
  resolve: Resolve,
  now: number,
  add: Add,
) {
  for (const { application, matches, on, named } of requirements(notes, current, resolve, now)) {
    const expiring = matches.filter((note) => isDate(note.data["expires"]));
    if (expiring.length === 0 || expiring.length < matches.length) continue;
    if (expiring.some((note) => String(note.data["expires"]).slice(0, 10) >= on)) continue;
    const latest = expiring.toSorted((a, b) =>
      String(b.data["expires"]).localeCompare(String(a.data["expires"])),
    )[0];
    if (!latest) continue;
    add({
      noteId: latest.id,
      detector: "expired",
      field: "expires",
      evidence: `Expires ${String(latest.data["expires"]).slice(0, 10)}, before ${labelOf(application)}${named ? `'s ${named}` : ""} ${on}`,
      related: [application.id],
    });
  }
}

/**
 * A saved link an open application relies on, through a requirement check or the link's own `for`, that was gone
 * at its last health check, or couldn't be checked. A link nothing relies on is only the person's bookmark.
 */
function deadLinks(
  notes: readonly ReviewNote[],
  current: readonly ReviewNote[],
  resolve: Resolve,
  now: number,
  add: Add,
) {
  const relies = new Map<ReviewNote, Set<ReviewNote>>();
  const rely = (link: ReviewNote, application: ReviewNote) =>
    relies.set(link, (relies.get(link) ?? new Set()).add(application));
  for (const { application, matches } of requirements(notes, current, resolve, now))
    for (const match of matches) if (match.data["type"] === "Link") rely(match, application);
  for (const link of current) {
    const application = link.data["type"] === "Link" ? resolve(link, link.data["for"]) : undefined;
    if (application && isOpen(application)) rely(link, application);
  }
  for (const [link, applications] of relies) {
    const synced = link.data["synced"];
    // A block filled for another address says nothing about this one: it is checked again on its own.
    if (!isRecord(synced) || synced["url"] !== link.data["url"]) continue;
    const apps = [...applications];
    const names = apps.map(labelOf);
    const who = `${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)} rely` : `${names[0]} relies`} on it`;
    const related = apps.map((app) => app.id);
    const checked = typeof synced["checked"] === "string" ? synced["checked"].slice(0, 10) : undefined;
    if (synced["status"] === "dead")
      add({
        noteId: link.id,
        detector: "dead",
        field: "url",
        evidence: `Gone (${show(synced["code"])}) when checked${checked ? ` ${checked}` : ""}, and ${who}`,
        related,
      });
    else if (synced["status"] === "unchecked")
      add({
        noteId: link.id,
        detector: "unchecked",
        field: "url",
        evidence: `Couldn't be checked: ${show(synced["why"])}, and ${who}`,
        related,
      });
  }
}

const WRONG = new Set<Detector>([
  "document",
  "duplicate",
  "impossible",
  "spelling",
  "expired",
  "drift",
  "dead",
]);

/** How bad a check is: a conflict, then a value that looks wrong, then staleness, then missing proof. */
const rankOf = (check: Check) =>
  check.detector === "conflict" ? 0 : WRONG.has(check.detector) ? 1 : check.detector === "stale" ? 2 : 3;

function markOf(checks: readonly Check[], verified: readonly string[]): Mark {
  if (checks.some((c) => c.detector === "conflict")) return "conflict";
  if (checks.some((c) => WRONG.has(c.detector))) return "wrong";
  if (checks.some((c) => c.detector === "stale")) return "stale";
  if (verified.length === 0 || checks.some((c) => c.detector === "proof" || c.detector === "unchecked"))
    return "unproven";
  return "checked";
}

/** Every typed note as an item with its headline, mark and checks, grouped by type, and the counts per mark. */
export function overview(notes: readonly ReviewNote[], manifest: Manifest | null, now: number): Overview {
  // Inbox items and questions are waiting work, not items of the record.
  const typed = notes.filter(
    (note) =>
      typeof note.data["type"] === "string" &&
      note.data["type"] !== "InboxItem" &&
      note.data["type"] !== "Question",
  );
  const resolve = resolver(notes);
  const checks = detect(notes, manifest, now);
  const used = usedBy(notes, now);
  const superseded = new Set(typed.flatMap((n) => [resolve(n, n.data["supersedes"])?.id ?? []].flat()));
  const order = Object.keys(manifest?.types ?? {});
  const rank = (type: string) => (order.includes(type) ? order.indexOf(type) : order.length);
  const items = typed
    .map((note): Item => {
      // Worst first, so the line beside the headline names what the mark is for.
      const mine = checks.filter((c) => c.noteId === note.id).toSorted((a, b) => rankOf(a) - rankOf(b));
      const verified = verifiedFields(note.data);
      const [flag] = mine;
      return {
        noteId: note.id,
        path: note.path,
        type: String(note.data["type"]),
        headline: headline(note, manifest),
        mark: markOf(mine, verified),
        checks: mine,
        verified,
        usedBy: used.get(note.id) ?? [],
        superseded: superseded.has(note.id),
        aside: flag?.evidence ?? (superseded.has(note.id) ? "superseded" : proofOf(note, resolve)),
      };
    })
    .toSorted(
      (a, b) => rank(a.type) - rank(b.type) || a.type.localeCompare(b.type) || a.path.localeCompare(b.path),
    );
  // History isn't counted: it's neither checked nor waiting to be.
  const counts = { items: 0, checked: 0, wrong: 0, unproven: 0, stale: 0, conflict: 0 };
  for (const item of items)
    if (!item.superseded) {
      counts.items++;
      counts[item.mark]++;
    }
  return { items, counts };
}

function proofOf(note: ReviewNote, resolve: Resolve): string {
  const [source] = listOf(note.data["sources"]).filter(isRecord);
  const doc = source && resolve(note, source["resource"]);
  if (!source || !doc) return "";
  const page = source["page"];
  return `proof: ${labelOf(doc)}${typeof page === "number" ? ` p${page}` : ""}`;
}

const SEVERITY: Record<Mark, number> = { conflict: 0, wrong: 1, stale: 2, unproven: 3, checked: 4 };

/**
 * What review mode walks, worst first: flags, then what an open application relies on, then the rest. History
 * (a superseded note) is left out.
 */
export function reviewQueue(items: readonly Item[]): Item[] {
  const tier = (item: Item) =>
    item.mark === "conflict" || item.mark === "wrong" ? 0 : item.usedBy.length > 0 ? 1 : 2;
  return items
    .filter((item) => !item.superseded)
    .toSorted((a, b) => tier(a) - tier(b) || SEVERITY[a.mark] - SEVERITY[b.mark]);
}
