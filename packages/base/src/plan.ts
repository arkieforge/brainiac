// The record's plan (docs/product/pricing.md). Free holds 300 notes and 200 MB of files; Pro has no note limit and
// holds 10 GB. Limits apply only once the record is told billing is on (`setBilling`, from the Worker when the
// stage has Polar), so a stage without billing, and a laptop's copy, never refuse. Polar's word on the plan lands
// with `setPlan`; the record keeps the newest one.
import type { Sql } from "./sql.ts";

const MB = 1024 * 1024;
const LIMITS = {
  free: { notes: 300, bytes: 200 * MB },
  pro: { notes: Number.POSITIVE_INFINITY, bytes: 10 * 1024 * MB },
} as const;

/** What Polar last said: Pro until `until` (the paid period's end), or free; `at` is when Polar said it. */
export interface PlanState {
  readonly plan: "free" | "pro";
  readonly until: number | null;
  readonly at: number;
}

/** The record's plan and what it holds, for the account page; `limits` is null while billing is off. */
export interface PlanView {
  readonly plan: "free" | "pro";
  readonly limits: { readonly notes: number; readonly bytes: number } | null;
  readonly notes: number;
  readonly bytes: number;
}

const read = (sql: Sql, key: string) =>
  sql.all<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)[0]?.value;
const put = (sql: Sql, key: string, value: string) =>
  sql.all(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );

function stored(sql: Sql): PlanState | undefined {
  const value = read(sql, "plan");
  return value === undefined ? undefined : (JSON.parse(value) as PlanState);
}

/** Pro while Polar's last word says so and its period hasn't ended; a lapsed Pro is free. */
function current(sql: Sql, now: number): "free" | "pro" {
  const state = stored(sql);
  return state?.plan === "pro" && (state.until === null || state.until > now) ? "pro" : "free";
}

/** Turns limits on or off for this record; the Worker calls it on wake with whether the stage has billing. */
export function setBilling(sql: Sql, on: boolean): void {
  if (on === (read(sql, "billing") === "on")) return;
  if (on) put(sql, "billing", "on");
  else sql.all("DELETE FROM meta WHERE key = 'billing'");
}

/** Keeps Polar's newest word on the plan; an older one arriving late changes nothing. Returns whether it applied. */
export function setPlan(sql: Sql, state: PlanState): boolean {
  const before = stored(sql);
  if (before && before.at > state.at) return false;
  put(sql, "plan", JSON.stringify(state));
  return true;
}

// Every live note counts, whoever wrote it: a type is only a field, so none can be left out.
const countNotes = (sql: Sql) =>
  sql.all<{ n: number }>("SELECT count(*) AS n FROM notes WHERE deletedAt IS NULL")[0]?.n ?? 0;

/**
 * Every file the record keeps, whichever note names it, so no edit or delete moves bytes out of the count.
 * shortcut: nothing deletes a file yet, so a deleted file's room never comes back; when files can be deleted
 * (blob and row, once no note names them), its bytes leave with it.
 */
const countBytes = (sql: Sql) =>
  sql.all<{ n: number }>("SELECT coalesce(sum(bytes), 0) AS n FROM files")[0]?.n ?? 0;

export function planOf(sql: Sql, now: number): PlanView {
  const plan = current(sql, now);
  return {
    plan,
    limits: read(sql, "billing") === "on" ? LIMITS[plan] : null,
    notes: countNotes(sql),
    bytes: countBytes(sql),
  };
}

/**
 * Why the record can't take `more` on its plan (new notes, a file's bytes, or both for an upload, which writes a
 * sidecar note), or undefined if it can. Counts nothing while billing is off.
 */
export function overLimit(
  sql: Sql,
  now: number,
  more: { readonly notes?: number; readonly bytes?: number },
): string | undefined {
  if (read(sql, "billing") !== "on") return undefined;
  const plan = current(sql, now);
  const limits = LIMITS[plan];
  const upgrade = plan === "free" ? " Upgrade to Pro on your account page for more." : "";
  if (more.notes !== undefined) {
    const notes = countNotes(sql);
    if (notes + more.notes > limits.notes)
      return `Your ${plan} plan holds ${limits.notes} notes, and this record is full. Delete some, or make room another way.${upgrade}`;
  }
  if (more.bytes !== undefined && countBytes(sql) + more.bytes > limits.bytes)
    return `Your ${plan} plan holds ${Math.round(limits.bytes / MB)} MB of files, and this one doesn't fit. Every file the record keeps counts, deleted ones too.${upgrade}`;
  return undefined;
}
