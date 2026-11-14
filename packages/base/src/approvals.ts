// Approvals (contract §4): a change whose effect alters, clears or deletes a verified value, or sets
// verification, lands only with a passkey signature over its plan hash, or inside a review session the person
// signed. The DO checks the signature (it holds the passkey's key); this module judges effects, hashes plans
// and keeps each signature to one use, in the mutation's own transaction, so cloud and local judge alike.
import { createHash, randomBytes } from "node:crypto";

import { deepEqual, isUlid, PathError, resolveRelation, type PlanItem } from "@brainiac/core";

import { diff, stateOf } from "./diff.ts";
import { getNote, getNoteByPath, type NoteRow } from "./notes.ts";
import type { Sql } from "./sql.ts";

/** How long a review session lasts after its signature, and how long its nonce waits to be signed. */
export const REVIEW_MS = 10 * 60 * 1000;
/** Deleting more notes than this in one change always needs its own plan-hash signature (contract §4). */
const BULK_DELETE = 5;

/** What one transaction did to one note: the note as it started and as it ended. */
export interface Effect {
  readonly before: NoteRow | undefined;
  readonly after: NoteRow;
}

export interface NeedsApproval {
  readonly status: "needsApproval";
  /** The WebAuthn challenge to sign: base64url SHA-256 over `items`. */
  readonly planHash: string;
  readonly items: readonly PlanItem[];
}

/** JSON with object keys sorted, so equal plans hash equally whatever order their fields were built in. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : typeof value === "object" && value !== null
      ? `{${Object.keys(value)
          .toSorted()
          .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
          .join(",")}}`
      : JSON.stringify(value);

export const planHash = (items: readonly PlanItem[]): string =>
  createHash("sha256").update(canonical(items)).digest("base64url");

const live = (note: NoteRow | undefined): Readonly<Record<string, unknown>> | undefined =>
  note && note.deletedAt === null ? JSON.parse(note.fm) : undefined;

/**
 * The top-level fields a note's `verified` block covers. `sections.writing` covers `sections`, and also a
 * top-level field literally named `sections.writing`, since front-matter allows both.
 */
function verifiedFields(verified: unknown): string[] {
  const fields =
    typeof verified === "object" && verified !== null && "fields" in verified ? verified.fields : [];
  return Array.isArray(fields)
    ? fields.flatMap((f) => (typeof f === "string" ? [f, f.split(".")[0] ?? f] : []))
    : [];
}

/** The note a `supersedes` relation names (a path relative to the note, or an id), if it is live. */
function superseded(sql: Sql, from: string, relation: unknown): NoteRow | undefined {
  if (typeof relation !== "string") return undefined;
  if (isUlid(relation)) return getNote(sql, relation);
  try {
    return getNoteByPath(sql, resolveRelation(from, relation));
  } catch (error) {
    if (error instanceof PathError) return undefined;
    throw error;
  }
}

/**
 * Whether an effect needs an approval: it sets verification, or it changes a verified note's verification,
 * one of its verified values, its type, its path or whether it exists, or it points `supersedes` at a verified
 * note. Judged on the note as the transaction found it and left it, so clearing `verified` first and editing
 * after, in one transaction or two, is caught at the first step.
 */
function needsApproval(sql: Sql, { before, after }: Effect): boolean {
  const was = live(before);
  const is = live(after);
  if (is && !deepEqual(was?.["supersedes"], is["supersedes"])) {
    const target = superseded(sql, after.path, is["supersedes"]);
    if (target && target.id !== after.id && Object.hasOwn(live(target) ?? {}, "verified")) return true;
  }
  if (!was || !Object.hasOwn(was, "verified")) return is !== undefined && Object.hasOwn(is, "verified");
  if (!is || before?.path !== after.path) return true;
  return ["verified", "type", ...verifiedFields(was["verified"])].some(
    (key) => Object.hasOwn(was, key) !== Object.hasOwn(is, key) || !deepEqual(was[key], is[key]),
  );
}

interface ApprovalRow {
  readonly id: string;
  readonly planHash: string;
  readonly usedAt: number | null;
}

interface ReviewRow {
  readonly actor: string;
  readonly items: string;
  readonly assertion: string;
  readonly expiresAt: number;
}

/** What the caller holds: an approval for this exact plan, or a review session. Never from a request body alone. */
export interface Grant {
  readonly approvalId?: string;
  readonly review?: string;
}

/**
 * Lets a transaction's effects stand, or says what must be signed. An approval covers one plan once: it is used
 * up here, in the transaction that applies it. A review session covers edits (and, for an undo, restores and
 * deletes) to the notes it showed, until it expires.
 */
export function settle(
  sql: Sql,
  effects: readonly Effect[],
  ctx: Grant & { readonly actor: string; readonly now: number },
  scope: "change" | "undo",
): NeedsApproval | undefined {
  const needing = effects.filter((effect) => needsApproval(sql, effect));
  if (needing.length === 0) return undefined;
  const items = effects
    .map(({ before, after }): PlanItem => ({
      noteId: after.id,
      baseRev: before?.rev ?? 0,
      path: after.path,
      class: after.class,
      patch: diff(stateOf(before), stateOf(after)),
    }))
    .toSorted((a, b) => (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0));
  const hash = planHash(items);
  if (ctx.approvalId !== undefined) {
    const [approval] = sql.all<ApprovalRow>("SELECT * FROM approvals WHERE id = ?", ctx.approvalId);
    if (approval && approval.planHash === hash && approval.usedAt === null) {
      sql.all("UPDATE approvals SET usedAt = ? WHERE id = ?", ctx.now, approval.id);
      return undefined;
    }
  }
  if (ctx.review !== undefined) {
    const [review] = sql.all<ReviewRow>("SELECT * FROM review_runs WHERE nonce = ?", ctx.review);
    const deletes = effects.filter(({ before, after }) => live(before) && !live(after)).length;
    // The session is the person's own, not a bearer token: its nonce in anyone else's hands does nothing.
    if (
      review &&
      review.actor === ctx.actor &&
      review.assertion !== "" &&
      review.expiresAt > ctx.now &&
      deletes <= BULK_DELETE
    ) {
      const shown = new Set<string>(JSON.parse(review.items));
      const covered = needing.every(
        ({ before, after }) =>
          shown.has(after.id) &&
          (scope === "undo" ||
            (live(before) !== undefined && live(after) !== undefined && before?.path === after.path)),
      );
      if (covered) return undefined;
    }
  }
  return { status: "needsApproval", planHash: hash, items };
}

/** A passkey assertion the DO has checked: who signed, the counter it reported, and the raw response. */
export interface Signature {
  readonly credentialId: string;
  readonly counter: number;
  readonly assertion: string;
}

/** The highest counter the record has seen from this passkey; the DO checks the next assertion against it. */
export function lastCounter(sql: Sql, credentialId: string): number {
  const [row] = sql.all<{ counter: number }>(
    "SELECT counter FROM passkey_keys WHERE credentialId = ?",
    credentialId,
  );
  return row?.counter ?? 0;
}

/**
 * Takes a passkey's counter forward, or refuses an assertion that doesn't move it (a replay or a cloned key).
 * Authenticators that keep no counter always report 0; those rely on the one-use rows instead.
 */
function advance(sql: Sql, signature: Signature): boolean {
  const last = lastCounter(sql, signature.credentialId);
  if ((signature.counter > 0 || last > 0) && signature.counter <= last) return false;
  sql.all(
    // The key itself stays in Neon, where the Worker reads it for each check; the record keeps the counter.
    `INSERT INTO passkey_keys (credentialId, publicKey, counter) VALUES (?, '', ?)
     ON CONFLICT (credentialId) DO UPDATE SET counter = excluded.counter`,
    signature.credentialId,
    signature.counter,
  );
  return true;
}

export type Approved = { readonly approvalId: string } | { readonly error: string };
export type Opened = { readonly review: string } | { readonly error: string };

/**
 * Records a checked signature over `planHash(items)`, ready for the change to cite once. A plan approved but
 * not yet used gets its approval back, so an answer lost on the way to the site doesn't strand the change.
 */
export function recordApproval(
  sql: Sql,
  items: readonly PlanItem[],
  signature: Signature,
  now: number,
): Approved {
  return sql.transaction((): Approved => {
    const hash = planHash(items);
    const [given] = sql.all<ApprovalRow>("SELECT * FROM approvals WHERE planHash = ?", hash);
    if (given)
      return given.usedAt === null ? { approvalId: given.id } : { error: "This plan was already applied." };
    if (!advance(sql, signature)) return { error: "This passkey signature was already used." };
    const approvalId = randomBytes(16).toString("base64url");
    sql.all(
      "INSERT INTO approvals (id, planHash, items, assertion, credentialId, at) VALUES (?, ?, ?, ?, ?, ?)",
      approvalId,
      hash,
      JSON.stringify(items),
      signature.assertion,
      signature.credentialId,
      now,
    );
    return { approvalId };
  });
}

/** A nonce for the person (`actor`) to sign, opening a review session over `noteIds` (the items shown). */
export function startReview(sql: Sql, noteIds: readonly string[], actor: string, now: number): string {
  const nonce = randomBytes(32).toString("base64url");
  // Unsigned yet: an empty assertion, and until when it may be signed.
  sql.all(
    "INSERT INTO review_runs (nonce, items, assertion, credentialId, expiresAt, actor) VALUES (?, ?, '', '', ?, ?)",
    nonce,
    JSON.stringify([...new Set(noteIds)]),
    now + REVIEW_MS,
    actor,
  );
  return nonce;
}

/** Opens the session once its nonce is signed: valid for 10 minutes, and only a new signature renews it. */
export function openReview(sql: Sql, nonce: string, signature: Signature, now: number): Opened {
  return sql.transaction((): Opened => {
    const [review] = sql.all<ReviewRow>("SELECT * FROM review_runs WHERE nonce = ?", nonce);
    if (!review || review.assertion !== "" || review.expiresAt <= now)
      return { error: "This review session can't be opened. Start a new one." };
    if (!advance(sql, signature)) return { error: "This passkey signature was already used." };
    sql.all(
      "UPDATE review_runs SET assertion = ?, credentialId = ?, expiresAt = ? WHERE nonce = ?",
      signature.assertion,
      signature.credentialId,
      now + REVIEW_MS,
      nonce,
    );
    return { review: nonce };
  });
}
