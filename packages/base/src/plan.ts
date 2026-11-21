// The record's plan (docs/product/pricing.md). Free holds 300 notes and 200 MB of files; Pro has no note limit and
// holds 10 GB. Limits apply only once the record is told billing is on (`setBilling`, from the Worker when the
// stage has Polar), so a stage without billing, and a laptop's copy, never refuse. Polar's word on the plan lands
// with `setPlan`; the record keeps the newest one.
import { pathKey, PathError, resolveFile } from "@brainiac/core";

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

// Questions are the record asking the person, so a full record can still ask.
const countNotes = (sql: Sql) =>
  sql.all<{ n: number }>(
    "SELECT count(*) AS n FROM notes WHERE deletedAt IS NULL AND type IS NOT 'Question'",
  )[0]?.n ?? 0;

/**
 * The bytes of the files a live note still names (its `file:`), so deleting a file's note frees its room. Resolved
 * as the vault finds a sidecar (vault.ts `sidecarOf`).
 */
function countBytes(sql: Sql): number {
  const named = new Set<string>();
  for (const note of sql.all<{ path: string; fm: string }>(
    "SELECT path, fm FROM notes WHERE deletedAt IS NULL",
  )) {
    const file: unknown = JSON.parse(note.fm)["file"];
    if (typeof file !== "string") continue;
    try {
      named.add(pathKey(resolveFile(note.path, file)));
    } catch (error) {
      if (!(error instanceof PathError)) throw error;
    }
  }
  let bytes = 0;
  for (const file of sql.all<{ path: string | null; bytes: number }>("SELECT path, bytes FROM files"))
    if (file.path !== null && named.has(pathKey(file.path))) bytes += file.bytes;
  return bytes;
}

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
      return `Your ${plan} plan holds ${limits.notes} notes, and this record has ${notes}. Delete some, or make room another way.${upgrade}`;
  }
  if (more.bytes !== undefined && countBytes(sql) + more.bytes > limits.bytes)
    return `Your ${plan} plan holds ${Math.round(limits.bytes / MB)} MB of files, and this one doesn't fit. Deleting a file's note frees its room.${upgrade}`;
  return undefined;
}
