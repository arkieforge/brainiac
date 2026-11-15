// The query filter (docs/internals/agent-interface.md, "The filter"): exact lookups over front-matter. It runs over
// rows the projection already let through, in the DO and on bun:sqlite alike, so cloud and local answer the same.
import { createHash } from "node:crypto";

import { deepEqual } from "@brainiac/core";
import { type } from "arktype";

/** What one field must satisfy; every operator given must hold. */
const Condition = type({
  "+": "reject",
  "eq?": "unknown",
  "in?": "unknown[]",
  "gte?": "string | number",
  "lte?": "string | number",
  "exists?": "boolean",
  "has?": "unknown",
  "text?": "string",
});
type Condition = typeof Condition.infer;

export const Where = type({ "[string]": Condition });

/** A row the filter reads: a note's front-matter, or a proposal's or question's fields. */
export interface Row {
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
  /** What the top-level `text` looks in: a note's whole text. */
  readonly text: string;
}

export interface Filter {
  readonly where?: Readonly<Record<string, Condition>>;
  readonly text?: string;
}

export interface Page extends Filter {
  readonly type?: string;
  readonly sort?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i;

/** A date or date-time string as UTC milliseconds; one without an offset is read as UTC. */
function instant(value: string): number | undefined {
  if (!DAY.test(value) && !DATE_TIME.test(value)) return undefined;
  let iso = value.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (!DAY.test(iso) && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(iso)) iso += "Z";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

const fold = (text: string) => text.normalize("NFKC").toLowerCase();
/** For `text`: case and accents both fold, as search does. */
const loose = (text: string) => fold(text.normalize("NFKD").replace(/\p{M}/gu, ""));

/**
 * Every value at a dotted path, lists flattened: `sources.page` reads each source's page, `sources.0.page` the
 * first. Null and empty lists read as nothing, so a field set to null matches only `exists: false`, like a missing one.
 */
function valuesAt(data: unknown, path: string): unknown[] {
  let values: unknown[] = [data];
  for (const key of path.split(".")) {
    values = values.flatMap((value) => {
      if (Array.isArray(value))
        return /^\d+$/.test(key) ? [value[Number(key)]] : value.map((v) => at(v, key));
      return [at(value, key)];
    });
  }
  const leaves = values.flatMap((value) => (Array.isArray(value) ? value : [value]));
  return leaves.filter((value) => value !== undefined && value !== null);
}

const at = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;

function equal(value: unknown, operand: unknown): boolean {
  if (typeof value === "string" && typeof operand === "string") {
    const a = instant(value);
    const b = instant(operand);
    if (a !== undefined && b !== undefined) return compareDates(value, operand) === 0;
    return fold(value) === fold(operand);
  }
  return deepEqual(value, operand);
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Dates compare in UTC; against a plain date, by the day the other side falls on. */
function compareDates(value: string, operand: string): number | undefined {
  const a = instant(value);
  const b = instant(operand);
  if (a === undefined || b === undefined) return undefined;
  if (DAY.test(operand) || DAY.test(value)) {
    return day(a) < day(b) ? -1 : day(a) > day(b) ? 1 : 0;
  }
  return Math.sign(a - b);
}

function compare(value: unknown, operand: string | number): number | undefined {
  if (typeof value === "number" && typeof operand === "number") return Math.sign(value - operand);
  if (typeof value !== "string" || typeof operand !== "string") return undefined;
  const dates = compareDates(value, operand);
  if (dates !== undefined) return dates;
  if (instant(value) !== undefined || instant(operand) !== undefined) return undefined;
  const [a, b] = [fold(value), fold(operand)];
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Why a filter can't run, in words an agent can act on; `undefined` when it can. */
export function checkFilter(filter: Filter): string | undefined {
  for (const [field, condition] of Object.entries(filter.where ?? {})) {
    if (field === "") return "A where key must name a field.";
    const operators = Object.keys(condition);
    if (operators.length === 0)
      return `where.${field} names no operator. Use eq, in, gte, lte, exists, has or text.`;
    if ([condition.eq, condition.has, ...(condition.in ?? [])].some((v) => v === null))
      return `where.${field} compares with null. A missing or null field matches only {"exists": false}.`;
  }
  return undefined;
}

function satisfies(values: readonly unknown[], condition: Condition): boolean {
  const { eq, gte, lte, exists, has, text } = condition;
  if (exists !== undefined && exists !== values.length > 0) return false;
  if (eq !== undefined && !values.some((v) => equal(v, eq))) return false;
  if (condition.in && !values.some((v) => condition.in?.some((option) => equal(v, option)))) return false;
  if (gte !== undefined && !values.some((v) => (compare(v, gte) ?? -1) >= 0)) return false;
  if (lte !== undefined && !values.some((v) => (compare(v, lte) ?? 1) <= 0)) return false;
  if (
    has !== undefined &&
    !values.some(
      (v) =>
        equal(v, has) ||
        (typeof has === "string" && typeof v === "object" && v !== null && Object.hasOwn(v, has)),
    )
  )
    return false;
  if (text !== undefined) {
    const words = loose(text).split(/\s+/).filter(Boolean);
    const strings = values.filter((v) => typeof v === "string" || typeof v === "number").map(String);
    if (!strings.some((s) => words.every((word) => loose(s).includes(word)))) return false;
  }
  return true;
}

/** Whether a row passes the filter. Check it with `checkFilter` first. */
export function matches(row: Row, filter: Filter): boolean {
  for (const [field, condition] of Object.entries(filter.where ?? {}))
    if (!satisfies(valuesAt(row.data, field), condition)) return false;
  if (filter.text !== undefined) {
    const words = loose(filter.text).split(/\s+/).filter(Boolean);
    const haystack = loose(row.text);
    if (!words.every((word) => haystack.includes(word))) return false;
  }
  return true;
}

/** A sort value: its kind first (numbers, then dates, then text, then the rest), then the value. */
type Key = readonly [rank: number, value: number | string] | null;

function keyOf(value: unknown): Key {
  if (value === undefined) return null;
  if (typeof value === "number") return [0, value];
  if (typeof value === "string") {
    const ms = instant(value);
    return ms === undefined ? [2, fold(value)] : [1, ms];
  }
  if (typeof value === "boolean") return [3, value ? 1 : 0];
  return [4, JSON.stringify(value)];
}

/** Missing values sort last whichever way the field sorts. */
function compareKeys(a: Key, b: Key, descending: boolean): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const order = a[0] !== b[0] ? a[0] - b[0] : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  return descending ? -order : order;
}

interface Position {
  readonly keys: readonly Key[];
  readonly id: string;
}

const DEFAULT_SORT = ["-date"];

/** The query a cursor belongs to, so a cursor from one query can't page another. */
const queryHash = (page: Page) =>
  createHash("sha256")
    .update(JSON.stringify([page.type ?? null, page.where ?? null, page.text ?? null, page.sort ?? null]))
    .digest("base64url")
    .slice(0, 16);

const Cursor = type({ q: "string", keys: "unknown[]", id: "string" });

function readCursor(cursor: string, page: Page, sorts: number): Position | string {
  const wrong = "That cursor doesn't belong to this query. Drop it to start from the first page.";
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return wrong;
  }
  const position = Cursor(parsed);
  if (position instanceof type.errors || position.q !== queryHash(page) || position.keys.length !== sorts)
    return wrong;
  const keys = position.keys.map((key): Key | undefined => {
    if (key === null) return null;
    if (!Array.isArray(key) || key.length !== 2 || typeof key[0] !== "number") return undefined;
    const value: unknown = key[1];
    return typeof value === "number" || typeof value === "string" ? [key[0], value] : undefined;
  });
  if (keys.some((key) => key === undefined)) return wrong;
  return { keys: keys.filter((key) => key !== undefined), id: position.id };
}

/**
 * One page of the rows that pass the filter, in a stable order: the sort fields (default newest `date` first),
 * then id. The cursor names the last row's position, so rows added or removed between pages never repeat or
 * skip one that stayed.
 */
export function paginate<R extends Row>(
  rows: readonly R[],
  page: Page,
): { readonly rows: R[]; readonly next: string | null } | { readonly error: string } {
  const sort = (page.sort ?? DEFAULT_SORT).map((spec) => ({
    field: spec.replace(/^[-+]/, ""),
    descending: spec.startsWith("-"),
  }));
  if (sort.some((s) => s.field === "")) return { error: "A sort entry must name a field, like -date." };
  const positionOf = (row: R): Position => ({
    keys: sort.map((s) => keyOf(valuesAt(row.data, s.field)[0])),
    id: row.id,
  });
  const order = (a: Position, b: Position) => {
    for (const [i, s] of sort.entries()) {
      const c = compareKeys(a.keys[i] ?? null, b.keys[i] ?? null, s.descending);
      if (c !== 0) return c;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  let after: Position | undefined;
  if (page.cursor !== undefined) {
    const read = readCursor(page.cursor, page, sort.length);
    if (typeof read === "string") return { error: read };
    after = read;
  }
  const sorted = rows
    .filter((row) => matches(row, page))
    .map((row) => ({ row, position: positionOf(row) }))
    .filter(({ position }) => after === undefined || order(position, after) > 0)
    .toSorted((a, b) => order(a.position, b.position));
  const limit = page.limit ?? 20;
  const taken = sorted.slice(0, limit);
  const last = taken.at(-1);
  const next =
    sorted.length > limit && last
      ? Buffer.from(JSON.stringify({ q: queryHash(page), ...last.position })).toString("base64url")
      : null;
  return { rows: taken.map(({ row }) => row), next };
}
