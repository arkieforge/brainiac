// Approvals (contract §4): a change whose effect alters, clears or deletes a verified value, or sets
// verification, lands only with a passkey signature over its plan hash, or inside a review session the person
// signed. Loosening privacy (a sensitive note made normal) needs its own plan-hash signature. The DO checks
// the signature (it holds the passkey's key); this module judges effects, hashes plans and keeps each
// signature to one use, in the mutation's own transaction, so cloud and local judge alike.
import { createHash, randomBytes } from "node:crypto";

import { deepEqual, isUlid, PathError, pathKey, resolveRelation, type PlanItem } from "@brainiac/core";

import { diff, stateOf } from "./diff.ts";
import { getNote, type NoteRow } from "./notes.ts";
import type { Sql } from "./sql.ts";

/** How long a review session lasts after its signature, and how long its nonce waits to be signed. */
export const REVIEW_MS = 10 * 60 * 1000;
/** Deleting more notes than this in one change always needs its own plan-hash signature (contract §4). */
const BULK_DELETE = 5;
/** An update that changes more notes than this needs a signature (contract §4). */
const BULK_UPDATE = 20;
/** A connection's deletes add up over this long: six one-note deletes in a day are a bulk delete too. */
const DELETES_MS = 24 * 60 * 60_000;

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
export const canonical = (value: unknown): string =>
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

const liveData = (note: NoteRow | undefined): Readonly<Record<string, unknown>> | undefined =>
  note && note.deletedAt === null ? JSON.parse(note.fm) : undefined;

/**
 * The top-level fields a note's `verified` block covers. `sections.writing` covers `sections`, and also a
 * top-level field literally named `sections.writing`, since front-matter allows both. A block whose `fields`
 * isn't a list of names covers every field: when it's unclear what was verified, everything is.
 */
function verifiedFields(verified: unknown): string[] | "all" {
  const fields =
    typeof verified === "object" && verified !== null && "fields" in verified ? verified.fields : undefined;
  if (!Array.isArray(fields) || !fields.every((f) => typeof f === "string")) return "all";
  return fields.flatMap((f: string) => [f, f.split(".")[0] ?? f]);
}

/**
 * The live note a relation (a path relative to the note, or an id) names, if any. Paths match as the record
 * matches them, whatever their case or Unicode form, as a Mac or Obsidian would open them. Anything else that
 * reads `supersedes` (an edges table, a "current score" query) must resolve it exactly like this, or a form it
 * accepts and this doesn't would carry an edge past approvals and the hold.
 */
export function relationTarget(sql: Sql, from: NoteRow | undefined, relation: unknown): NoteRow | undefined {
  const id = from && relationResolver(sql)(from, relation);
  return id === undefined ? undefined : getNote(sql, id);
}

/**
 * `relationTarget` for many relations: the id of the live note each relation names, if any. The live paths are
 * read once, on the first path relation, so an id or no relation at all costs no scan of the record. Search's
 * graph hop follows edges with it, so it reads them exactly as approvals do.
 */
export function relationResolver(
  sql: Sql,
): (from: Pick<NoteRow, "id" | "path">, relation: unknown) => string | undefined {
  let byKey: Map<string, string> | undefined;
  return (from, relation) => {
    if (typeof relation !== "string") return undefined;
    let id: string | undefined;
    if (isUlid(relation)) id = getNote(sql, relation)?.deletedAt === null ? relation : undefined;
    else {
      let key: string;
      try {
        key = pathKey(resolveRelation(from.path, relation));
      } catch (error) {
        if (error instanceof PathError) return undefined;
        throw error;
      }
      // The record refuses two live paths that differ only in case or Unicode form, so a key names one note.
      byKey ??= new Map(
        sql
          .all<{ id: string; path: string }>("SELECT id, path FROM notes WHERE deletedAt IS NULL")
          .map((note) => [pathKey(note.path), note.id]),
      );
      id = byKey.get(key);
    }
    return id === from.id ? undefined : id;
  };
}

/** The live verified note a `supersedes` relation names, if any. */
function verifiedTarget(sql: Sql, from: NoteRow | undefined, relation: unknown): string | undefined {
  const target = relationTarget(sql, from, relation);
  return target && Object.hasOwn(liveData(target) ?? {}, "verified") ? target.id : undefined;
}

/**
 * A sensitive note the effect leaves normal: privacy loosened (contract §4). Live or not, since a deleted note
 * comes back with a plain edit, so a normal tombstone made from a sensitive note is as loose as a live one.
 */
const loosens = ({ before, after }: Effect) =>
  before !== undefined && before.class !== "normal" && after.class === "normal";

/** The verified notes an effect adds, moves or removes a `supersedes` edge into. */
function edgesMoved(sql: Sql, { before, after }: Effect): string[] {
  const was = liveData(before)?.["supersedes"];
  const is = liveData(after)?.["supersedes"];
  // A relative relation reads from its note's path, so the same text on a moved note can point elsewhere.
  if (deepEqual(was, is) && before?.path === after.path) return [];
  return [verifiedTarget(sql, before, was), verifiedTarget(sql, after, is)].filter((id) => id !== undefined);
}

/**
 * Whether an effect needs an approval: it sets verification, or it changes a verified note's verification,
 * one of its verified values, its type, its path or whether it exists, or it points `supersedes` at a verified
 * note. Judged on the note as the transaction found it and left it, so clearing `verified` first and editing
 * after, in one transaction or two, is caught at the first step.
 */
function needsApproval(sql: Sql, { before, after }: Effect): boolean {
  const was = liveData(before);
  const is = liveData(after);
  // Adding, moving or removing an edge into a verified note changes which verified value is current.
  if (edgesMoved(sql, { before, after }).length > 0) return true;
  if (!was || !Object.hasOwn(was, "verified")) return is !== undefined && Object.hasOwn(is, "verified");
  if (!is || before?.path !== after.path) return true;
  const fields = verifiedFields(was["verified"]);
  const guarded = fields === "all" ? [...Object.keys(was), ...Object.keys(is)] : fields;
  return ["verified", "type", "supersedes", ...guarded].some(
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

/** What a transaction's effects come to, note by note, in a stable order: what a passkey signs. */
export const planOf = (effects: readonly Effect[]): PlanItem[] =>
  effects
    .map(({ before, after }): PlanItem => ({
      noteId: after.id,
      baseRev: before?.rev ?? 0,
      path: after.path,
      class: after.class,
      patch: diff(stateOf(before), stateOf(after)),
    }))
    .toSorted((a, b) => (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0));

/**
 * Lets a transaction's effects stand, or says what must be signed. An approval covers one plan once: it is used
 * up here, in the transaction that applies it. A review session covers edits (and, for an undo, restores and
 * deletes) to the notes it showed, until it expires. `signed` means the person's signature let it through, which
 * also releases it from the hold window.
 */
export function settle(
  sql: Sql,
  effects: readonly Effect[],
  ctx: Grant & { readonly actor: string; readonly now: number; readonly connection?: object },
  scope: "change" | "undo",
): NeedsApproval | "signed" | undefined {
  const deleting = effects.filter(({ before, after }) => liveData(before) && !liveData(after));
  // A connection's deletes over the last day count together, so deleting one note per call doesn't get around the
  // limit. The count includes this transaction's own, which are written by now. Sync edits carry no connection: a
  // folder removed on disk is judged as one change.
  const [recent] =
    ctx.connection && deleting.length > 0
      ? sql.all<{ n: number }>(
          "SELECT count(*) AS n FROM changes WHERE actor = ? AND op = 'delete' AND at > ?",
          ctx.actor,
          ctx.now - DELETES_MS,
        )
      : [];
  // Deleting more than five notes needs a signature whatever they hold, and no review session covers it.
  const bulk = deleting.length > 0 && Math.max(deleting.length, recent?.n ?? 0) > BULK_DELETE;
  // Loosening privacy, like a bulk delete, always needs its own signature: no review session covers it.
  const loosening = effects.some(loosens);
  // A change to more than 20 notes needs a signature too; a review session that showed them all covers it.
  const wide = scope === "change" && effects.length > BULK_UPDATE;
  const needing =
    bulk || loosening || wide ? effects : effects.filter((effect) => needsApproval(sql, effect));
  if (needing.length === 0) return undefined;
  const items = planOf(effects);
  const hash = planHash(items);
  if (ctx.approvalId !== undefined) {
    const [approval] = sql.all<ApprovalRow>("SELECT * FROM approvals WHERE id = ?", ctx.approvalId);
    if (approval && approval.planHash === hash && approval.usedAt === null) {
      sql.all("UPDATE approvals SET usedAt = ? WHERE id = ?", ctx.now, approval.id);
      return "signed";
    }
  }
  if (ctx.review !== undefined) {
    const [review] = sql.all<ReviewRow>("SELECT * FROM review_runs WHERE nonce = ?", ctx.review);
    // The session is the person's own, not a bearer token: its nonce in anyone else's hands does nothing.
    if (
      review &&
      review.actor === ctx.actor &&
      review.assertion !== "" &&
      review.expiresAt > ctx.now &&
      !bulk &&
      !loosening
    ) {
      const shown = new Set<string>(JSON.parse(review.items));
      // The edges an edit moves count as items too: a session can't redirect one into a note it didn't show.
      const covered = needing.every(
        ({ before, after }) =>
          shown.has(after.id) &&
          edgesMoved(sql, { before, after }).every((id) => shown.has(id)) &&
          (scope === "undo" ||
            (liveData(before) !== undefined && liveData(after) !== undefined && before?.path === after.path)),
      );
      if (covered) return "signed";
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
export function advance(sql: Sql, signature: Signature): boolean {
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
    // A used approval must outlive any chance of its plan recurring (a create at revision 0 after a purge), or
    // a replayed signature from a passkey whose counter stays at 0 would open a fresh one: never prune them.
    // The cost: an identical plan after a purge and recreate can't be approved again.
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
export function openReview(
  sql: Sql,
  nonce: string,
  actor: string,
  signature: Signature,
  now: number,
): Opened {
  return sql.transaction((): Opened => {
    const [review] = sql.all<ReviewRow>("SELECT * FROM review_runs WHERE nonce = ?", nonce);
    // Only whoever started it may open it, so a session started by anyone else is never signed into theirs.
    if (!review || review.actor !== actor || review.assertion !== "" || review.expiresAt <= now)
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
