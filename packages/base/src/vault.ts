// The vault (contract §5): secrets and the files that print them. Every upload is sealed with the record's data
// key and starts unclassified, which agents see only as a one-line summary. A file is cleared only when the
// server's checks read all of it and found nothing, and the person confirmed what it is; anything the checks
// find stays in the vault whatever kind anyone chose. Nothing here returns a secret's value or a vault file's
// bytes, text or URL: secrets leave only by the fill path (#37), originals only to the person, through a
// single-use file token for the usercontent origin (`mintFileToken`).
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

import { parsePassport, scan, ulid, type Finding, type Passport } from "@brainiac/core";

import { advance, canonical, type Signature } from "./approvals.ts";
import { canSee, type Connection } from "./connections.ts";
import { mutate, type Context, type Forbidden, type MutationResult } from "./mutate.ts";
import type { Sql } from "./sql.ts";

// AES-256-GCM: a fresh 12-byte IV per seal, the 16-byte tag after it, and a context string as associated data,
// so a sealed value only opens as what it was sealed as (a secret under its own name, a file under its hash).
const IV = 12;
const TAG = 16;

function seal(key: Uint8Array, plaintext: Uint8Array, context: string): Uint8Array {
  const iv = randomBytes(IV);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** The plaintext, or a throw if `sealed` was changed or sealed under another key or context. */
export function unseal(key: Uint8Array, sealed: Uint8Array, context: string): Uint8Array {
  const bytes = Buffer.from(sealed);
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV))
    .setAAD(Buffer.from(context))
    .setAuthTag(bytes.subarray(IV, IV + TAG));
  return Buffer.concat([decipher.update(bytes.subarray(IV + TAG)), decipher.final()]);
}

/**
 * The record's data key: made on first use and kept in `meta`, wrapped by the vault key from Cloudflare's
 * Secrets Store, so the record's own storage never holds a key that opens it. A vault key that doesn't open
 * it throws rather than making a new one, which would orphan every sealed value.
 */
export function dataKey(sql: Sql, vaultKey: string): Uint8Array {
  const wrapping = createHash("sha256").update(vaultKey).digest();
  return sql.transaction(() => {
    const [row] = sql.all<{ value: string }>("SELECT value FROM meta WHERE key = 'dataKey'");
    if (row) return unseal(wrapping, Buffer.from(row.value, "base64"), "dataKey");
    const key = randomBytes(32);
    sql.all(
      "INSERT INTO meta (key, value) VALUES ('dataKey', ?)",
      Buffer.from(seal(wrapping, key, "dataKey")).toString("base64"),
    );
    return key;
  });
}

/**
 * A file sealed for R2, under its id: an HMAC of its bytes under the data key, so the record dedupes its own
 * uploads but an id handed to an agent can't be used to test guesses at what a file says (a passport number,
 * say, when the rest of its MRZ is known). Stored in the `sha256` column.
 */
export function sealFile(key: Uint8Array, bytes: Uint8Array): { sha256: string; sealed: Uint8Array } {
  const sha256 = createHmac("sha256", key).update(bytes).digest("hex");
  return { sha256, sealed: seal(key, bytes, `file:${sha256}`) };
}

// The types whose bytes are all there is to read. Anything that renders (HTML, SVG, email) can show what its
// bytes only encode, so it waits for extraction like a PDF.
const PLAIN = new Set(["text/plain", "text/markdown", "text/csv"]);

/** A token a hex dump is made of: 2, 4 or 8 wide, mixing digits with a to f. */
const hexWord = (token: string) =>
  [2, 4, 8].includes(token.length) && /\d/.test(token) && /[a-f]/i.test(token);

/**
 * All of a file's text, or `undefined` when the checks can't be sure they read all of it: anything but plain
 * text, markdown or CSV, and in those, bytes that aren't UTF-8 or carry a PDF header, markup, character
 * references or a long encoded run (base64 or hex can hide a whole scan).
 * shortcut: PDFs and images read as `undefined` until extraction (#20) gives the checks their text; until then
 * they stay unclassified, which is safe and means they can't be cleared.
 */
export function readText(bytes: Uint8Array, mime: string): string | undefined {
  if (!PLAIN.has(mime.split(";")[0]?.trim().toLowerCase() ?? "") || bytes.includes(0)) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
  if (text.slice(0, 1024).includes("%PDF-")) return undefined;
  if (/<[a-z!?/][^<>]*>|&#?[a-z0-9]+;/i.test(text)) return undefined;
  if (/[A-Za-z0-9+/=]{200,}/.test(text.replaceAll(/\r?\n|\r/g, ""))) return undefined;
  // A hex dump with spaces between the bytes or groups. It is full of 2, 4 or 8-wide tokens that mix digits with
  // a to f (`4E`, `0D1A`); a sheet of marks has none or a few, even with `AB` for absent, letter grades or
  // course codes like `EEE101` and `CE305` beside them.
  for (const [dump] of text.matchAll(/(?:[0-9a-f]{2,8}\s+){60,}/gi))
    if (dump.split(/\s+/).filter(hexWord).length >= 20) return undefined;
  return text;
}

/** Why an upload is refused before anything is stored, if it is: checked again inside the transaction. */
export function refuseUpload(
  ctx: Context,
  kind: string | undefined,
): Forbidden | { readonly error: string } | undefined {
  if (ctx.connection?.level === "read")
    return { status: "forbidden", reason: "This connection can only read." };
  if (kind !== undefined && !KIND.test(kind))
    return { error: `kind must look like "transcript" (was "${kind}").` };
  return undefined;
}

/**
 * Kinds that print secret values: a file confirmed as one stays in the vault even when the checks find
 * nothing. Any other kind clears a file the checks found clean.
 */
const VAULT_KINDS: ReadonlySet<string> = new Set(["passport", "national-id", "visa", "bank-statement"]);
const KIND = /^[a-z][a-z0-9-]{0,39}$/;

export type FileClass = "unclassified" | "vault" | "normal" | "sensitive";
/** What the checks made of a file: `unreadable` when they couldn't read all of it, so it can't be cleared. */
export type Checks = "clean" | "found" | "unreadable";

export interface FileRow {
  readonly sha256: string;
  readonly r2Key: string;
  readonly mime: string;
  readonly bytes: number;
  readonly class: FileClass;
  readonly checks: Checks;
  /** What the checks found, as JSON: `Finding[]`. */
  readonly findings: string;
  /** What the file is, as the person or the uploader said. */
  readonly kind: string | null;
  /** When the person confirmed `kind`; an agent's kind is only a suggestion. */
  readonly confirmedAt: number | null;
  /** The note written from the file's structured parse (a passport's MRZ). */
  readonly noteId: string | null;
  /** Bumped by every confirmation, so a signature over one kind change can't be used for another. */
  readonly rev: number;
}

const COLUMNS = "sha256, r2Key, mime, bytes, class, checks, findings, kind, confirmedAt, noteId, rev";

export const getFile = (sql: Sql, sha256: string): FileRow | undefined =>
  sql.all<FileRow>(`SELECT ${COLUMNS} FROM files WHERE sha256 = ?`, sha256)[0];

/** Every file in the record, as `connection` may know it (`viewFile`); the person sees them all. */
export const listFiles = (sql: Sql, connection: Connection | undefined): FileView[] =>
  sql
    .all<FileRow>(`SELECT ${COLUMNS} FROM files ORDER BY rowid`)
    .map((file) => viewFile(connection, file))
    .filter((file) => file !== undefined);

/** Where a file belongs, from what the checks found and what the person confirmed. */
function classOf(file: Pick<FileRow, "checks" | "kind" | "confirmedAt">): FileClass {
  if (file.checks === "found" || (file.kind !== null && VAULT_KINDS.has(file.kind))) return "vault";
  if (file.checks !== "clean" || file.confirmedAt === null) return "unclassified";
  // A cleared file is still someone's document: sensitive until the person makes it normal, which is loosening
  // privacy (contract §4) and arrives with the first feature that needs a normal file.
  return "sensitive";
}

// How much each class keeps from agents. Moving a confirmed file down this list loosens privacy.
const RANK: Record<FileClass, number> = { normal: 0, sensitive: 1, unclassified: 2, vault: 3 };

const UNCLASSIFIED = "Unclassified document, waiting for you.";
const VAULTED = "Vault document: only you can open it.";

/** What a caller is told about a file. */
export type FileView =
  | {
      readonly sha256: string;
      readonly class: FileClass;
      readonly kind: string | null;
      readonly mime: string;
      readonly bytes: number;
      readonly checks: Checks;
      readonly findings: readonly Finding[];
      readonly confirmed: boolean;
      readonly noteId: string | null;
    }
  /** For agents, a file still unclassified or in the vault: the summary, and (with the sensitive scope) its kind and note. */
  | {
      readonly sha256: string;
      readonly class: "unclassified" | "vault";
      readonly summary: string;
      readonly kind?: string | null;
      readonly noteId?: string | null;
    }
  | {
      readonly sha256: string;
      readonly class: "normal" | "sensitive";
      readonly kind: string | null;
      readonly mime: string;
      readonly bytes: number;
    };

// What a passport's parse writes, as `canSee` (the one read check) judges it: a sensitive IdDocument note.
const PASSPORT_NOTE = { class: "sensitive", type: "IdDocument" } as const;

/**
 * The one projection of a file for every read surface. The person sees what the checks found; a connection never
 * gets more than a summary of a file that isn't cleared, and nothing of a cleared one `canSee` would hide (a
 * file has no type, so a type-scoped connection sees none).
 */
export function viewFile(connection: Connection | undefined, file: FileRow): FileView | undefined {
  const { sha256 } = file;
  if (connection === undefined) {
    return {
      sha256,
      class: file.class,
      kind: file.kind,
      mime: file.mime,
      bytes: file.bytes,
      checks: file.checks,
      findings: JSON.parse(file.findings),
      confirmed: file.confirmedAt !== null,
      noteId: file.noteId,
    };
  }
  if (file.class === "unclassified") return { sha256, class: file.class, summary: UNCLASSIFIED };
  if (file.class === "vault") {
    return canSee(connection, PASSPORT_NOTE)
      ? { sha256, class: file.class, summary: VAULTED, kind: file.kind, noteId: file.noteId }
      : { sha256, class: file.class, summary: VAULTED };
  }
  if (!canSee(connection, { class: file.class, type: null })) return undefined;
  return { sha256, class: file.class, kind: file.kind, mime: file.mime, bytes: file.bytes };
}

export interface Upload {
  readonly sha256: string;
  readonly r2Key: string;
  readonly mime: string;
  readonly bytes: number;
  /** All of the file's text (`readText`), or `undefined` when the checks can't read it all. */
  readonly text: string | undefined;
  /** What the uploader says it is. From the person this is their confirmation; from an agent, a suggestion. */
  readonly kind?: string;
}

export type Uploaded =
  | {
      readonly file: FileView | undefined;
      /** The note written from a passport's MRZ; left out for a connection that can't see sensitive notes. */
      readonly note?: MutationResult;
    }
  | Forbidden
  | { readonly error: string };

/**
 * Records an upload the DO has sealed into R2: runs the checks over its text, and writes a passport's MRZ into
 * an IdDocument note, its number into the vault. Uploading a file the record has again changes nothing but
 * the person's confirmation.
 */
export function recordUpload(sql: Sql, key: Uint8Array, upload: Upload, ctx: Context): Uploaded {
  const kind = upload.kind;
  const refused = refuseUpload(ctx, kind);
  if (refused) return refused;
  return sql.transaction((): Uploaded => {
    const existing = getFile(sql, upload.sha256);
    if (existing) {
      if (ctx.connection === undefined && kind !== undefined && existing.confirmedAt === null) {
        return confirm(sql, existing, kind, ctx.now);
      }
      return { file: viewFile(ctx.connection, existing) };
    }
    const passport = upload.text === undefined ? undefined : parsePassport(upload.text, ctx.now);
    // A passport that parses is an MRZ, whatever the pattern check made of it.
    const scanned = upload.text === undefined ? [] : scan(upload.text);
    const findings = passport && !scanned.includes("mrz") ? (["mrz", ...scanned] as const) : scanned;
    const checks: Checks = upload.text === undefined ? "unreadable" : findings.length > 0 ? "found" : "clean";
    const confirmedAt = ctx.connection === undefined && kind !== undefined ? ctx.now : null;
    const written = passport && writePassport(sql, key, upload.sha256, passport, ctx);
    const row: FileRow = {
      sha256: upload.sha256,
      r2Key: upload.r2Key,
      mime: upload.mime,
      bytes: upload.bytes,
      class: classOf({ checks, kind: kind ?? null, confirmedAt }),
      checks,
      findings: JSON.stringify(findings),
      kind: kind ?? null,
      confirmedAt,
      noteId: written?.noteId ?? null,
      rev: 0,
    };
    sql.all(
      `INSERT INTO files (${COLUMNS}, encrypted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      row.sha256,
      row.r2Key,
      row.mime,
      row.bytes,
      row.class,
      row.checks,
      row.findings,
      row.kind,
      row.confirmedAt,
      row.noteId,
      row.rev,
    );
    const file = viewFile(ctx.connection, row);
    const seesNote = canSee(ctx.connection, PASSPORT_NOTE);
    return written && seesNote ? { file, note: written.result } : { file };
  });
}

/**
 * A passport's fields as an IdDocument note and its number as a secret the note names, together or not at all.
 * The secret is named for the file, so another upload can never overwrite it.
 */
function writePassport(
  sql: Sql,
  key: Uint8Array,
  sha256: string,
  passport: Passport,
  ctx: Context,
): { readonly result: MutationResult; readonly noteId: string | null } {
  const issuer = passport.issuer.toLowerCase();
  const name = `passport.${issuer}.${sha256.slice(0, 12)}`;
  const id = ulid(ctx.now);
  const raw = [
    "---",
    `id: ${id}`,
    "type: IdDocument",
    `title: ${JSON.stringify(`Passport, ${passport.issuer}`)}`,
    "kind: passport",
    `issuer: ${JSON.stringify(passport.issuer)}`,
    `number: ${JSON.stringify(`secret:${name}`)}`,
    `surname: ${JSON.stringify(passport.surname)}`,
    `given_names: ${JSON.stringify(passport.givenNames)}`,
    `nationality: ${JSON.stringify(passport.nationality)}`,
    `birth_date: ${passport.birthDate}`,
    `sex: ${passport.sex}`,
    `expires: ${passport.expires}`,
    "---",
    "",
  ].join("\n");
  const path = `identity/passport-${issuer}-${passport.expires}.md`;
  let result: MutationResult;
  try {
    result = sql.transaction(() => {
      // Base64 text rather than a BLOB: the engines return blobs as different types, and nothing reads it back
      // but the fill path.
      sql.all(
        "INSERT INTO secrets (name, ciphertext, policy, domain) VALUES (?, ?, 'ask', NULL)",
        name,
        Buffer.from(seal(key, Buffer.from(passport.number), `secret:${name}`)).toString("base64"),
      );
      const created = mutate(sql, { op: "create", path, raw, class: "sensitive" }, ctx);
      // A note that wasn't written or kept as a proposal (a path clash with this passport's note from another
      // scan, a manifest without IdDocument) takes the secret with it.
      if (!kept(created)) throw new NotWritten(created);
      return created;
    });
  } catch (error) {
    if (!(error instanceof NotWritten)) throw error;
    result = error.result;
  }
  // Only a written note is linked: a proposal the person rejects would leave the link pointing at nothing.
  return { result, noteId: result.status === "applied" ? id : null };
}

/** Whether a note was written, or kept as a proposal that may write it. */
const kept = (result: MutationResult) => result.status === "applied" || result.status === "proposed";

/** Rolls back a passport's secret when its note wasn't written. */
class NotWritten extends Error {
  readonly result: MutationResult;
  constructor(result: MutationResult) {
    super("not written");
    this.result = result;
  }
}

export type Classified =
  | { readonly file: FileView | undefined }
  /** Loosening a file the person already confirmed needs their passkey over `challenge` (contract §4). */
  | { readonly status: "needsApproval"; readonly challenge: string }
  | Forbidden
  | { readonly error: string };

/**
 * The challenge for confirming `kind` on a file as it is now: tagged so it can't equal any other plan's hash,
 * and over the file's `rev`, which every confirmation bumps, so a signature can't be used twice.
 */
export function kindHash(file: FileRow, kind: string): string {
  const plan = { kind: { sha256: file.sha256, kind, from: file.class, rev: file.rev } };
  return createHash("sha256").update(canonical(plan)).digest("base64url");
}

/**
 * The person says what a file is. That clears a file the checks found clean, or keeps it in the vault; it never
 * takes a file the checks found something in out of the vault. Changing a confirmed kind in a way that hands
 * agents more needs the person's passkey over `kindHash` (checked by the DO); tightening never does.
 */
export function classifyFile(
  sql: Sql,
  sha256: string,
  kind: string,
  ctx: Context,
  signed?: { readonly challenge: string; readonly signature: Signature },
): Classified {
  if (ctx.connection !== undefined)
    return { status: "forbidden", reason: "Only you can say what a file is." };
  if (!KIND.test(kind)) return { error: `kind must look like "transcript" (was "${kind}").` };
  return sql.transaction((): Classified => {
    const file = getFile(sql, sha256);
    if (!file) return { error: "No such file." };
    const next = classOf({ checks: file.checks, kind, confirmedAt: ctx.now });
    if (file.confirmedAt !== null && RANK[next] < RANK[file.class]) {
      const challenge = kindHash(file, kind);
      if (!signed) return { status: "needsApproval", challenge };
      if (signed.challenge !== challenge) return { error: "This file changed since you signed. Sign again." };
      if (!advance(sql, signed.signature)) return { error: "This passkey signature was already used." };
    }
    return confirm(sql, file, kind, ctx.now);
  });
}

function confirm(sql: Sql, file: FileRow, kind: string, now: number): { file: FileView | undefined } {
  const next = { ...file, kind, confirmedAt: now, rev: file.rev + 1 };
  const updated = { ...next, class: classOf(next) };
  sql.all(
    "UPDATE files SET kind = ?, confirmedAt = ?, class = ?, rev = rev + 1 WHERE sha256 = ?",
    kind,
    now,
    updated.class,
    file.sha256,
  );
  return { file: viewFile(undefined, updated) };
}

// A file token opens one file's bytes once, on the usercontent origin, for a minute. Like a CLI token it names its
// record (`brf_<base id>_<secret>`), so the usercontent route needs no lookup to find the record, and the record
// keeps only a hash of the whole token, so the same secret under another record's id opens nothing.
const FILE_TOKEN = /^brf_([0-9a-f]{1,128})_([\w-]{43})$/;
/** How long a file token works: long enough for a page to load what it asked for, never long enough to share. */
export const FILE_TOKEN_MS = 60_000;

const fileTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** The record a file token names, for routing only: the record itself decides whether it opens anything. */
export const fileTokenBase = (token: string): string | undefined => FILE_TOKEN.exec(token)?.[1];

export type FileToken =
  | { readonly token: string; readonly expiresAt: number }
  /** The file is unclassified or in the vault: its original opens only after a passkey check (contract §5). */
  | { readonly status: "needsPasskey" }
  | Forbidden
  | { readonly error: string };

/**
 * A token that opens `sha256` once from the usercontent origin, for the person only: connections never get a
 * file's bytes or URL. An unclassified or vault file needs `passkey`, the site's proof that the person checked a
 * passkey in the last few minutes. `origin` is the site page that asked; only it may read the bytes.
 */
export function mintFileToken(
  sql: Sql,
  baseId: string,
  sha256: string,
  ctx: Context,
  opts: { readonly origin: string; readonly passkey: boolean },
): FileToken {
  if (ctx.connection !== undefined) return { status: "forbidden", reason: "Files open only on the site." };
  if (!/^[0-9a-f]{1,128}$/.test(baseId)) throw new Error(`Not a record id: ${baseId}`);
  if (!/^https?:\/\/[^/?#\s]+$/.test(opts.origin)) return { error: "Not a site origin." };
  const file = getFile(sql, sha256);
  if (!file) return { error: "No such file." };
  if ((file.class === "unclassified" || file.class === "vault") && !opts.passkey)
    return { status: "needsPasskey" };
  const token = `brf_${baseId}_${randomBytes(32).toString("base64url")}`;
  const expiresAt = ctx.now + FILE_TOKEN_MS;
  sql.transaction(() => {
    sql.all("DELETE FROM file_tokens WHERE expiresAt <= ?", ctx.now);
    sql.all(
      "INSERT INTO file_tokens (hash, sha256, origin, expiresAt) VALUES (?, ?, ?, ?)",
      fileTokenHash(token),
      sha256,
      opts.origin,
      expiresAt,
    );
  });
  return { token, expiresAt };
}

/** Uses up a file token: the file it opens and the origin that may read it, once, before it expires. */
export function takeFileToken(
  sql: Sql,
  token: string,
  now: number,
): { readonly file: FileRow; readonly origin: string } | undefined {
  if (!FILE_TOKEN.test(token)) return undefined;
  return sql.transaction(() => {
    const [row] = sql.all<{ sha256: string; origin: string; expiresAt: number }>(
      "DELETE FROM file_tokens WHERE hash = ? RETURNING sha256, origin, expiresAt",
      fileTokenHash(token),
    );
    if (!row || row.expiresAt <= now) return undefined;
    const file = getFile(sql, row.sha256);
    return file && { file, origin: row.origin };
  });
}
