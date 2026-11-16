// The vault (contract §5): secrets and the files that print them. Every upload is sealed with the record's data
// key and starts unclassified, which agents see only as a one-line summary. A file is cleared only when the
// server's checks read all of it and found nothing, and the person confirmed what it is; anything the checks
// find stays in the vault whatever kind anyone chose. Nothing here returns a secret's value or a vault file's
// bytes, text or URL: secrets leave only by the fill path (secrets.ts), originals only to the person, through a
// single-use file token for the usercontent origin (`mintFileToken`).
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

import {
  parsePassport,
  PathError,
  pathKey,
  relationTo,
  resolveFile,
  scan,
  ulid,
  type Finding,
  type Passport,
} from "@brainiac/core";

import { advance, canonical, type Signature } from "./approvals.ts";
import { canSee, connectionOf, type Connection } from "./connections.ts";
import { enqueue, finishJob } from "./jobs.ts";
import { getNote, type NoteRow } from "./notes.ts";
import { mutate, type Context, type Forbidden, type MutationResult } from "./mutate.ts";
import { extracts, isImage, mediaType, needsReading, pdfJpegs, PIPELINE } from "./pages.ts";
import { chunkFile, fileOwner, putChunks } from "./search.ts";
import type { Sql } from "./sql.ts";

// AES-256-GCM: a fresh 12-byte IV per seal, the 16-byte tag after it, and a context string as associated data,
// so a sealed value only opens as what it was sealed as (a secret under its own name, a file under its hash).
const IV = 12;
const TAG = 16;

/** `plaintext` sealed under `key`, opening only as `context` (a secret's name, a file's hash). */
export function seal(key: Uint8Array, plaintext: Uint8Array, context: string): Uint8Array {
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
 * The stage's vault keys from Cloudflare's Secrets Store: `current` wraps every data key, and `previous` is
 * bound only while a rotation runs (infra/README.md#rotating-the-vault-key), so records wrapped by it still open.
 */
export interface VaultKeys {
  readonly current: string;
  readonly previous: string | undefined;
}

/**
 * Names a vault key without saying anything that opens what it wraps: a different hash from the wrapping key's,
 * so the id kept beside a data key and in the registry can't stand in for the key.
 */
export const vaultKeyId = (vaultKey: string): string =>
  createHash("sha256").update(`brainiac vault key id\0${vaultKey}`).digest("hex").slice(0, 16);

const wrapping = (vaultKey: string) => createHash("sha256").update(vaultKey).digest();

/**
 * The record's data key if it has one, rewrapped under the current vault key if another wraps it, in the caller's
 * transaction. A record sealed before key ids were kept has none, and was wrapped by the stage's first key, which
 * is `current` until the first rotation and `previous` during it. No key it holds opening the stored one is a
 * throw, never a new data key: that would orphan every file and secret the old one sealed.
 */
function unwrap(sql: Sql, keys: VaultKeys): Uint8Array | undefined {
  const rows = sql.all<{ key: string; value: string }>(
    "SELECT key, value FROM meta WHERE key IN ('dataKey', 'vaultKeyId')",
  );
  const wrapped = rows.find((row) => row.key === "dataKey")?.value;
  if (wrapped === undefined) return undefined;
  const id = rows.find((row) => row.key === "vaultKeyId")?.value;
  const held = [keys.current, keys.previous].filter((key) => key !== undefined);
  for (const vaultKey of held.filter((key) => id === undefined || vaultKeyId(key) === id)) {
    let key: Uint8Array;
    try {
      key = unseal(wrapping(vaultKey), Buffer.from(wrapped, "base64"), "dataKey");
    } catch {
      continue;
    }
    if (vaultKey !== keys.current || id === undefined) store(sql, key, keys.current);
    return key;
  }
  throw new Error(
    `This record's data key is wrapped by vault key ${id ?? "(unrecorded)"}, which this Worker doesn't hold ` +
      `(it holds ${held.map(vaultKeyId).join(", ")}). Bind that key again as VAULT_KEY_PREVIOUS ` +
      "(infra/README.md#rotating-the-vault-key); a new data key would orphan everything the record sealed.",
  );
}

/** Wraps `key` under `vaultKey` and records which key that was, in one write. */
function store(sql: Sql, key: Uint8Array, vaultKey: string) {
  sql.all(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('dataKey', ?), ('vaultKeyId', ?)",
    Buffer.from(seal(wrapping(vaultKey), key, "dataKey")).toString("base64"),
    vaultKeyId(vaultKey),
  );
}

/**
 * The record's data key: made on first use and kept in `meta`, wrapped by the vault key from Cloudflare's
 * Secrets Store, so the record's own storage never holds a key that opens it. A key wrapped by the previous
 * vault key is rewrapped under the current one as it opens.
 */
export function dataKey(sql: Sql, keys: VaultKeys): Uint8Array {
  return sql.transaction(() => {
    const existing = unwrap(sql, keys);
    if (existing) return existing;
    const key = randomBytes(32);
    store(sql, key, keys.current);
    return key;
  });
}

/**
 * Moves the record's data key onto the current vault key if the previous one wraps it, and makes none if it has
 * none (the rotation sweep wakes every record). The id of the key everything it seals is under from now on.
 */
export function rewrapDataKey(sql: Sql, keys: VaultKeys): string {
  sql.transaction(() => unwrap(sql, keys));
  return vaultKeyId(keys.current);
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
 * A PDF or a photo reads as `undefined` here and gets its text from a `file` job (`installFile`); anything else
 * stays unclassified, which is safe and means it can't be cleared.
 */
export function readText(bytes: Uint8Array, mime: string): string | undefined {
  if (!PLAIN.has(mediaType(mime)) || bytes.includes(0)) return undefined;
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
  /** How many pages its extraction found, once it has one. */
  readonly pages: number | null;
  /** The extraction (`PIPELINE`) that produced `checks`; 0 while a PDF waits for its first one. */
  readonly pipelineVersion: number;
  /** Who uploaded it (a revision's actor): a passport parsed later writes its note as them. */
  readonly uploadedBy: string | null;
  /** Where it sits in the record (`unorganized/files/<name>` until filed): what its sidecar note's `file:` resolves to. */
  readonly path: string | null;
  /** The person's own name for it, as they uploaded it. Only they see it: it can print a secret. */
  readonly name: string | null;
  /** When it was uploaded; null for an upload from before this was kept. */
  readonly uploadedAt: number | null;
  /** When the person let their agents see this photo itself (`shareFile`); null while they don't. */
  readonly sharedAt: number | null;
  /** How many times the person turned that on or off: a signature over one turn names it, so it works once. */
  readonly shares: number;
}

const COLUMNS =
  "sha256, r2Key, mime, bytes, pages, class, checks, findings, kind, confirmedAt, noteId, rev, pipelineVersion, uploadedBy, path, name, uploadedAt, sharedAt, shares";

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
      readonly path: string | null;
      readonly name: string | null;
      /** The person lets their agents see this photo itself (`shareFile`). */
      readonly shared: boolean;
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
      path: file.path,
      name: file.name,
      shared: file.sharedAt !== null,
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
  /** The uploader's name for the file (`cleanName`): kept for the person, never in the record's notes. */
  readonly name?: string;
}

export type Uploaded =
  | {
      readonly file: FileView | undefined;
      /** The note written from a passport's MRZ; left out for a connection that can't see sensitive notes. */
      readonly note?: MutationResult;
      /** The file's sidecar note, once written; left out for a connection that can't see it. */
      readonly sidecar?: string;
    }
  | Forbidden
  | { readonly error: string };

/**
 * Records an upload the DO has sealed into R2: runs the checks over its text, gives it a place in the record and
 * a sidecar note there, and writes a passport's MRZ into an IdDocument note, its number into the vault. Uploading
 * a file the record has again changes nothing but the person's confirmation, and a sidecar it lost.
 */
export function recordUpload(sql: Sql, key: Uint8Array, upload: Upload, ctx: Context): Uploaded {
  const kind = upload.kind;
  const refused = refuseUpload(ctx, kind);
  if (refused) return refused;
  try {
    return sql.transaction((): Uploaded => {
      const existing = getFile(sql, upload.sha256);
      if (existing) {
        if (ctx.connection === undefined && kind !== undefined && existing.confirmedAt === null)
          confirm(sql, existing, kind, ctx.now);
        const sidecar = placed(sql, existing, upload, ctx);
        return withSidecar(
          { file: viewFile(ctx.connection, getFile(sql, upload.sha256) ?? existing) },
          sidecar,
        );
      }
      const passport = upload.text === undefined ? undefined : parsePassport(upload.text, ctx.now);
      // A passport that parses is an MRZ, whatever the pattern check made of it.
      const scanned = upload.text === undefined ? [] : scan(upload.text);
      const findings = passport && !scanned.includes("mrz") ? (["mrz", ...scanned] as const) : scanned;
      const checks: Checks =
        upload.text === undefined ? "unreadable" : findings.length > 0 ? "found" : "clean";
      const confirmedAt = ctx.connection === undefined && kind !== undefined ? ctx.now : null;
      const written = passport && writePassport(sql, key, upload.sha256, passport, ctx);
      const row: FileRow = {
        sha256: upload.sha256,
        r2Key: upload.r2Key,
        mime: upload.mime,
        bytes: upload.bytes,
        pages: null,
        class: classOf({ checks, kind: kind ?? null, confirmedAt }),
        checks,
        findings: JSON.stringify(findings),
        kind: kind ?? null,
        confirmedAt,
        noteId: written?.noteId ?? null,
        rev: 0,
        pipelineVersion: extracts(upload.mime) ? 0 : PIPELINE,
        uploadedBy: ctx.actor,
        path: null,
        name: null,
        uploadedAt: ctx.now,
        sharedAt: null,
        shares: 0,
      };
      sql.all(
        `INSERT INTO files (${COLUMNS}, encrypted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        row.sha256,
        row.r2Key,
        row.mime,
        row.bytes,
        row.pages,
        row.class,
        row.checks,
        row.findings,
        row.kind,
        row.confirmedAt,
        row.noteId,
        row.rev,
        row.pipelineVersion,
        row.uploadedBy,
        row.path,
        row.name,
        row.uploadedAt,
        row.sharedAt,
        row.shares,
      );
      followUp(sql, row);
      const sidecar = placed(sql, row, upload, ctx);
      const file = viewFile(ctx.connection, getFile(sql, row.sha256) ?? row);
      const seesNote = canSee(ctx.connection, PASSPORT_NOTE);
      return withSidecar(written && seesNote ? { file, note: written.result } : { file }, sidecar);
    });
  } catch (error) {
    if (!(error instanceof NotWritten)) throw error;
    const { result } = error;
    // Every file has its sidecar: without one the upload isn't kept at all.
    const why = result.status === "invalid" ? result.issues.map((issue) => issue.message).join(" ") : "";
    return { error: `This file's note couldn't be written. ${why}`.trim() };
  }
}

const withSidecar = <U extends { readonly file: FileView | undefined }>(
  uploaded: U,
  sidecar: string | undefined,
) => (sidecar === undefined ? uploaded : { ...uploaded, sidecar });

/**
 * The person's name for a file, made safe to keep and show: its last path segment, NFC, on one line, at most 200
 * characters; `undefined` when nothing is left.
 */
function cleanName(name: string): string | undefined {
  const base = (name.normalize("NFC").split(/[/\\]/).at(-1) ?? "").replaceAll(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return base === "" ? undefined : [...base].slice(0, 200).join("");
}

// The extensions a file's place in the record may have, by type. Never taken from the filename or an unlisted type,
// both the uploader's text: `scan.A1234567` would put a passport number in the sidecar's `file:`.
const EXTENSIONS: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/** Where every upload lands, until the person or their agent moves its sidecar note (and with it the file). */
export const UNORGANIZED = "unorganized";

/**
 * Gives a file its place in the record, if it has none yet, and its sidecar note there, if no live note names it:
 * `unorganized/files/upload-<day>-<id>.<ext>` beside `unorganized/upload-<day>-<id>.md`. The place is named for the
 * upload, never for the person's filename, which can print a secret and is kept only on the file. Returns the
 * sidecar's id when the caller may see it. Throws `NotWritten` when the sidecar can't be written.
 */
function placed(sql: Sql, file: FileRow, upload: Upload, ctx: Context): string | undefined {
  const name = upload.name === undefined ? undefined : cleanName(upload.name);
  if (file.name === null && name !== undefined)
    sql.all("UPDATE files SET name = ? WHERE sha256 = ?", name, file.sha256);
  let path = file.path;
  if (path === null) {
    const stem = `upload-${new Date(ctx.now).toISOString().slice(0, 10)}-${file.sha256.slice(0, 12)}`;
    path = `${UNORGANIZED}/files/${stem}.${EXTENSIONS[mediaType(file.mime)] ?? "bin"}`;
    sql.all("UPDATE files SET path = ? WHERE sha256 = ?", path, file.sha256);
  }
  const found = sidecarOf(sql, path);
  if (found) return canSee(ctx.connection, found) ? found.id : undefined;
  const stem = path.slice(path.lastIndexOf("/") + 1, path.lastIndexOf("."));
  const notePath = path.slice(0, path.lastIndexOf("/files/") + 1) + `${stem}.md`;
  const id = ulid(ctx.now);
  // Nothing an agent shouldn't read: no filename, no kind until the person says what it is.
  const raw = [
    "---",
    `id: ${id}`,
    "type: Document",
    "title: Uploaded document",
    `file: ${relationTo(notePath, path)}`,
    "---",
    "",
  ].join("\n");
  const result = mutate(sql, { op: "create", path: notePath, raw, class: "sensitive" }, ctx);
  if (!kept(result)) throw new NotWritten(result);
  return result.status === "applied" && canSee(ctx.connection, SIDECAR) ? id : undefined;
}

// What every sidecar starts as: a sensitive Document note.
const SIDECAR = { class: "sensitive", type: "Document" } as const;

/**
 * The live note whose `file:` names the file at `path`, resolved from the note like a relation. The same rule
 * finds a laptop copy's file on disk, so the cloud and a copy agree on which file a sidecar means.
 */
function sidecarOf(sql: Sql, path: string) {
  const key = pathKey(path);
  const notes = sql.all<{ id: string; path: string; fm: string }>(
    "SELECT id, path, fm FROM notes WHERE deletedAt IS NULL AND type = 'Document'",
  );
  for (const note of notes) {
    const file: unknown = JSON.parse(note.fm)["file"];
    if (typeof file !== "string") continue;
    try {
      if (pathKey(resolveFile(note.path, file)) === key) return getNote(sql, note.id);
    } catch (error) {
      if (!(error instanceof PathError)) throw error;
    }
  }
  return undefined;
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
  const name = passportSecret(passport, sha256);
  const id = ulid(ctx.now);
  const raw = [
    "---",
    `id: ${id}`,
    "type: IdDocument",
    `title: ${JSON.stringify(`Passport, ${passport.issuer}`)}`,
    "kind: passport",
    `issuer: ${JSON.stringify(passport.issuer)}`,
    `number: ${JSON.stringify(`secret:${name}`)}`,
    ...(passport.surname === "" ? [] : [`surname: ${JSON.stringify(passport.surname)}`]),
    ...(passport.givenNames === "" ? [] : [`given_names: ${JSON.stringify(passport.givenNames)}`]),
    ...(passport.nationality === "" ? [] : [`nationality: ${JSON.stringify(passport.nationality)}`]),
    `birth_date: ${passport.birthDate}`,
    ...(passport.sex === "" ? [] : [`sex: ${passport.sex}`]),
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
      if (created.status === "proposed")
        sql.all("UPDATE secrets SET proposalId = ? WHERE name = ?", created.proposalId, name);
      return created;
    });
  } catch (error) {
    if (!(error instanceof NotWritten)) throw error;
    result = error.result;
  }
  // Only a written note is linked: a proposal the person rejects would leave the link pointing at nothing.
  return { result, noteId: result.status === "applied" ? id : null };
}

/**
 * Deletes the secrets a proposal brought in, once it is rejected or withdrawn, unless a note (even one in the trash,
 * which may come back) or another open proposal names one. Secrets the person saved belong to no proposal.
 */
export function forgetProposed(sql: Sql, proposalId: string): void {
  const secrets = sql.all<{ name: string }>("SELECT name FROM secrets WHERE proposalId = ?", proposalId);
  for (const { name } of secrets) {
    const ref = `secret:${name}`;
    const names = ({ text }: { text: string }) => namesSecret(text, ref);
    const named =
      sql.all<{ text: string }>("SELECT raw AS text FROM notes WHERE instr(raw, ?) > 0", ref).some(names) ||
      sql
        .all<{ text: string }>(
          `SELECT patch || char(10) || coalesce(action, '') AS text FROM proposals
           WHERE status = 'open' AND instr(patch || char(10) || coalesce(action, ''), ?) > 0`,
          ref,
        )
        .some(names);
    if (!named) sql.all("DELETE FROM secrets WHERE name = ?", name);
  }
}

/** Whether `text` names the secret `ref` (`secret:<name>`) itself, not a longer name that starts with it. */
function namesSecret(text: string, ref: string): boolean {
  for (let at = text.indexOf(ref); at !== -1; at = text.indexOf(ref, at + 1))
    if (!/[a-z0-9._-]/.test(text[at + ref.length] ?? "")) return true;
  return false;
}

/** A passport's number is a secret named for its issuer and the file, so no other upload can overwrite it. */
const passportSecret = (passport: Passport, sha256: string) =>
  `passport.${passport.issuer.toLowerCase()}.${sha256.slice(0, 12)}`;

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
  followUp(sql, updated, file.class);
  return { file: viewFile(undefined, updated) };
}

/**
 * Whether the person can let their agents see a file itself: a photo, or a scan, a PDF the checks couldn't clear
 * (a cleared PDF's text already reaches agents through `get`, page by page).
 */
export const showable = (file: Pick<FileRow, "mime" | "class">) =>
  isImage(file.mime) ||
  (mediaType(file.mime) === "application/pdf" && (file.class === "unclassified" || file.class === "vault"));

/**
 * The challenge for letting agents see a file's photo, as it is now: tagged so it can't equal any other plan's
 * hash, and over how many times it was turned on or off, so a signature can't be used twice.
 */
export function shareHash(file: FileRow): string {
  const plan = { share: { sha256: file.sha256, shares: file.shares } };
  return createHash("sha256").update(canonical(plan)).digest("base64url");
}

/**
 * The person lets their agents see a photo itself, or stops them (contract §5). Letting them hands an unread photo
 * to a model, which may hold anything a passport or a bank card prints, so it is loosening privacy and needs the
 * person's passkey over `shareHash`, vault document or not (contract §4); stopping them never does. Only the
 * person decides; no connection can. It never changes the file's class: its text stays out of search and agents.
 */
export function shareFile(
  sql: Sql,
  sha256: string,
  on: boolean,
  ctx: Context,
  signed?: { readonly challenge: string; readonly signature: Signature },
): Classified {
  if (ctx.connection !== undefined)
    return { status: "forbidden", reason: "Only you can let agents see a file." };
  return sql.transaction((): Classified => {
    const file = getFile(sql, sha256);
    if (!file) return { error: "No such file." };
    if (!showable(file)) return { error: "Only a photo or a scan can be shown to your agents." };
    if (on === (file.sharedAt !== null)) return { file: viewFile(undefined, file) };
    if (on) {
      const challenge = shareHash(file);
      if (!signed) return { status: "needsApproval", challenge };
      if (signed.challenge !== challenge) return { error: "This file changed since you signed. Sign again." };
      if (!advance(sql, signed.signature)) return { error: "This passkey signature was already used." };
    }
    sql.all(
      "UPDATE files SET sharedAt = ?, shares = shares + 1 WHERE sha256 = ?",
      on ? ctx.now : null,
      sha256,
    );
    return { file: viewFile(undefined, getFile(sql, sha256) ?? file) };
  });
}

/** The photo types a model reads, and the largest it takes (Claude's per-image limit). */
const READABLE: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

interface PhotoBase {
  /** Its sidecar note's id, path and revision: what `update` files it with. */
  readonly id: string;
  readonly path: string;
  readonly rev: number;
  /** The day it was uploaded. */
  readonly uploaded: string | null;
  readonly mime: string;
}

/** A photo as the person's agent may know it, beside its sidecar note: more only once the person shared it. */
export type PhotoView =
  | (PhotoBase & { readonly shared: false })
  | (PhotoBase & {
      /** The person lets the agent see the photo itself (`shareFile`). */
      readonly shared: true;
      readonly bytes: number;
      /** What the person said it is; null until they say. */
      readonly kind: string | null;
      readonly class: FileClass;
      /** What the checks found in it (OCR's text included): kinds of secret, never their values. */
      readonly found: readonly Finding[];
      /** The note written from what its MRZ said, if any. */
      readonly note: string | null;
      /** Why the agent can't get it as an image, if it can't. */
      readonly unreadable?: string;
    });

/** The photo a sidecar note names, if the note is a live sidecar of a stored photo that `connection` can see. */
function photoOf(sql: Sql, connection: Connection, noteId: string) {
  // Every upload's sidecar is sensitive; any other note naming the photo needs the same scope to reach it.
  if (!canSee(connection, SIDECAR)) return undefined;
  const note = getNote(sql, noteId);
  if (!note || note.deletedAt !== null || !canSee(connection, note)) return undefined;
  const file = fileOf(sql, note);
  return file && showable(file) ? { note, file } : undefined;
}

/** The stored file a sidecar note's `file:` names, if any. */
export function fileOf(sql: Sql, note: NoteRow): FileRow | undefined {
  const path = JSON.parse(note.fm)["file"];
  if (typeof path !== "string") return undefined;
  let key: string;
  try {
    key = pathKey(resolveFile(note.path, path));
  } catch (error) {
    if (error instanceof PathError) return undefined;
    throw error;
  }
  return sql
    .all<FileRow>(`SELECT ${COLUMNS} FROM files WHERE path IS NOT NULL`)
    .find((row) => pathKey(row.path ?? "") === key);
}

function photoView(sql: Sql, connection: Connection, note: NoteRow, file: FileRow): PhotoView {
  const base = {
    id: note.id,
    path: note.path,
    rev: note.rev,
    uploaded: file.uploadedAt === null ? null : new Date(file.uploadedAt).toISOString().slice(0, 10),
    mime: mediaType(file.mime),
  };
  if (file.sharedAt === null) return { ...base, shared: false };
  const parsed = file.noteId === null ? undefined : getNote(sql, file.noteId);
  // A scan's size is its pages': each is judged once its bytes are read (`photoImages`).
  const unreadable =
    mediaType(file.mime) === "application/pdf"
      ? undefined
      : !READABLE.has(mediaType(file.mime))
        ? `It's a ${mediaType(file.mime)} file, which models don't read. Ask the person what it shows.`
        : file.bytes > PHOTO_MAX_BYTES
          ? "It's larger than the 5 MB a model takes. Ask the person what it shows."
          : undefined;
  return {
    ...base,
    shared: true,
    bytes: file.bytes,
    kind: file.kind,
    class: file.class,
    found: JSON.parse(file.findings),
    note: parsed && parsed.deletedAt === null && canSee(connection, parsed) ? parsed.id : null,
    ...(unreadable !== undefined && { unreadable }),
  };
}

/**
 * The photos waiting in `unorganized/` (their sidecar notes are there), oldest first, as `connection` may know
 * them: a sidecar is sensitive, so a connection without the sensitive scope sees none. Only a photo the person
 * shared says more than that it exists.
 */
export function unorganizedPhotos(sql: Sql, connection: Connection): PhotoView[] {
  return sql
    .all<{ id: string }>(
      "SELECT id FROM notes WHERE deletedAt IS NULL AND type = 'Document' AND path LIKE ? ORDER BY path",
      `${UNORGANIZED}/%`,
    )
    .flatMap(({ id }) => {
      const photo = photoOf(sql, connection, id);
      return photo ? [photoView(sql, connection, photo.note, photo.file)] : [];
    })
    .toSorted((a, b) => (a.uploaded ?? "").localeCompare(b.uploaded ?? ""));
}

/**
 * The photo a sidecar note names, for handing to `connection` as an image: only one the person shared (contract
 * §5), of a type and size a model reads. The record reads its bytes after this, and asks again before it hands
 * them over, so a share turned off meanwhile holds.
 */
export function photoFor(
  sql: Sql,
  connection: Connection,
  noteId: string,
): { readonly view: PhotoView; readonly file: FileRow } | { readonly error: string } {
  const photo = photoOf(sql, connection, noteId);
  if (!photo) return { error: `No photo's note with id ${noteId}.` };
  const view = photoView(sql, connection, photo.note, photo.file);
  if (!view.shared)
    return {
      error:
        'The person hasn\'t let you see this photo. Ask them to open it on the site and turn on "Let your Claude see it".',
    };
  if (view.unreadable !== undefined) return { error: view.unreadable };
  return { view, file: photo.file };
}

/** An image as an MCP image block carries it. */
export interface PhotoImage {
  readonly data: string;
  readonly mimeType: string;
}

// The most of a scan's pages one answer holds, and all their bytes together: a transcript's few pages, without
// the answer outgrowing what a model reads in one turn.
const SCAN_PAGES = 8;
const SCAN_MAX_BYTES = 20 * 1024 * 1024;

/**
 * What the agent sees of a shared file, from its opened bytes: a photo as itself, a scan as its pages' images (the
 * JPEGs `pdfJpegs` finds). `left` says a scan holds more pages than the answer does, so the agent never takes the
 * first pages for all of it. A scan whose pages aren't JPEGs, or one too large for a model, is refused with words
 * for the agent.
 */
export function photoImages(
  mime: string,
  bytes: Uint8Array,
): { readonly images: readonly PhotoImage[]; readonly left?: string } | { readonly error: string } {
  if (mediaType(mime) !== "application/pdf")
    return { images: [{ data: Buffer.from(bytes).toString("base64"), mimeType: mediaType(mime) }] };
  const found = pdfJpegs(bytes, SCAN_PAGES + 1);
  const pages = found.slice(0, SCAN_PAGES);
  if (pages.length === 0)
    return { error: "This scan's pages aren't images Brainiac can hand over. Ask the person what it shows." };
  if (
    pages.some((page) => page.length > PHOTO_MAX_BYTES) ||
    pages.reduce((sum, page) => sum + page.length, 0) > SCAN_MAX_BYTES
  )
    return { error: "This scan is larger than a model takes in one answer. Ask the person what it shows." };
  return {
    images: pages.map((page) => ({ data: Buffer.from(page).toString("base64"), mimeType: "image/jpeg" })),
    ...(found.length > SCAN_PAGES && {
      left: `This scan has more than ${SCAN_PAGES} page images; these are its first ${SCAN_PAGES}. Ask the person for what the rest say.`,
    }),
  };
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

const cleared = <F extends Pick<FileRow, "class">>(file: F): file is F & { class: "normal" | "sensitive" } =>
  file.class === "normal" || file.class === "sensitive";

/**
 * After a file is recorded or confirmed, in the same transaction: a file whose class changed leaves search at
 * once, before any job runs, so its chunks never sit in a family it left; and a `file` job extracts one still
 * waiting for its text or indexes one cleared.
 */
function followUp(sql: Sql, file: FileRow, before: FileClass = file.class): void {
  if (!cleared(file) || file.class !== before) putChunks(sql, fileOwner(file.sha256), file.rev, []);
  if (needsJob(file)) enqueue(sql, "file", fileOwner(file.sha256), file.rev);
}

/** Whether a file has work for a `file` job: text to extract with this `PIPELINE`, or pages to index. */
export const needsJob = (file: Pick<FileRow, "mime" | "class" | "pipelineVersion">): boolean =>
  (extracts(file.mime) || PLAIN.has(mediaType(file.mime))) &&
  (file.pipelineVersion < PIPELINE || cleared(file));

/** Whether a file job should embed its pages: it will be cleared if its checks come out clean. */
export const mayClear = (file: FileRow): boolean =>
  file.findings === "[]" &&
  cleared({ class: classOf({ checks: "clean", kind: file.kind, confirmedAt: file.confirmedAt }) });

/** A file's text as a `file` job extracted it: all of it, and by page; `undefined` when it couldn't be read. */
export interface Extracted {
  readonly text: string | undefined;
  readonly pages: readonly string[] | undefined;
  /**
   * What OCR read in each of the file's images (a photo, a scan's JPEGs): for the checks and the MRZ parse only,
   * never for search or an agent, so no page holds it. It never makes a file read: OCR can't vouch it saw all an
   * image says.
   */
  readonly ocr?: readonly OcrReading[];
}

/**
 * What OCR read in one image: all its text, and its printed zone, the lines above where the MRZ starts, which alone
 * can confirm what the MRZ says that no check digit covers (none when the MRZ wasn't found or there may be two
 * passports: apps/ocr's `printedZone`).
 */
export interface OcrReading {
  readonly text: string;
  readonly printed: string;
}

/**
 * The passport in one image OCR read, keeping only what that image's printed zone says too: no check digit covers
 * a name, a country code or the sex, and OCR can misread one (`KARIN` for `KARIM`, `AUS` for `RUS`). Names and a
 * nationality it can't confirm, and the sex (one letter, which nothing confirms), are left for the person to fill
 * in; an issuer it can't confirm (the note's title and path) writes no note at all, and the file stays in the vault
 * for what its MRZ was found to be.
 */
function corroborated(image: OcrReading, now: number): Passport | undefined {
  const passport = parsePassport(image.text, now);
  if (!passport) return undefined;
  const printed = new Set(image.printed.toUpperCase().split(/[^A-Z]+/));
  // A one-letter value (Germany's `D`, a sex) is confirmed by any stray letter, so it never is.
  const seen = (words: string) => words.split(" ").every((word) => word.length > 1 && printed.has(word));
  if (!seen(passport.issuer)) return undefined;
  const named = seen(passport.surname) && seen(passport.givenNames);
  return {
    ...passport,
    surname: named ? passport.surname : "",
    givenNames: named ? passport.givenNames : "",
    nationality: seen(passport.nationality) ? passport.nationality : "",
    sex: "",
  };
}

/**
 * Installs a `file` job's result while the file is still at the job's revision: runs the checks over all the text,
 * writes a passport's MRZ as the uploader would have, and indexes the pages of a file that is cleared, paired with
 * `vectors` (one per `chunkFile` chunk, made by the job when `mayClear`). The checks only tighten: what one
 * extraction found stays found, and a page that needs reading keeps the whole file unclassified.
 */
export function installFile(
  sql: Sql,
  key: Uint8Array,
  jobId: string,
  extracted: Extracted,
  vectors: readonly Uint8Array[],
  now: number,
): "installed" | "dropped" {
  return finishJob(sql, jobId, (job) => {
    const file = getFile(sql, job.noteId.slice("file:".length));
    if (!file) return;
    const { text, pages, ocr } = extracted;
    const passport =
      (text === undefined ? undefined : parsePassport(text, now)) ??
      // From OCR, each image's passport is confirmed against that image alone.
      ocr?.reduce<Passport | undefined>((found, image) => found ?? corroborated(image, now), undefined);
    const findings = [
      ...new Set<Finding>([
        ...(JSON.parse(file.findings) as Finding[]),
        ...(passport ? (["mrz"] as const) : []),
        ...(text === undefined ? [] : scan(text)),
        ...(ocr ?? []).flatMap((image) => scan(image.text, "ocr")),
      ]),
    ];
    // Plain text is read whole by `readText`; only an extraction's pages can come back short. Pages that aren't cut
    // from the text the checks read count as unread, so search only ever holds what they read.
    const unread =
      text === undefined ||
      pages === undefined ||
      !pages.every((page) => text.includes(page)) ||
      // A photo is never all read (`isImage`). A blank page among others is read; a PDF with no text at all (every
      // page outlines, or a scan) isn't.
      isImage(file.mime) ||
      (extracts(file.mime) && (pages.some(needsReading) || pages.every((page) => page.trim() === "")));
    const checks: Checks =
      findings.length > 0
        ? "found"
        : unread
          ? "unreadable"
          : file.pipelineVersion < PIPELINE
            ? "clean"
            : file.checks;
    let noteId = file.noteId;
    const parsed =
      passport &&
      sql.all("SELECT 1 FROM secrets WHERE name = ?", passportSecret(passport, file.sha256)).length > 0;
    if (passport && !parsed && noteId === null && file.uploadedBy !== null) {
      // As the uploader: a connection's parse waits as a proposal, as it would have at upload. One that is gone
      // since writes nothing; the person's confirmation doesn't parse again, nor does a later extraction of a
      // passport already parsed (its proposal may still be waiting).
      const connection = connectionOf(sql, file.uploadedBy);
      if (connection || !file.uploadedBy.startsWith("connection:")) {
        const ctx: Context = { actor: file.uploadedBy, now, ...(connection && { connection }) };
        noteId = writePassport(sql, key, file.sha256, passport, ctx).noteId;
      }
    }
    const next: FileRow = { ...file, checks, findings: JSON.stringify(findings), noteId };
    const updated = {
      ...next,
      class: classOf(next),
      pipelineVersion: PIPELINE,
      pages: pages?.length ?? null,
    };
    sql.all(
      `UPDATE files SET checks = ?, findings = ?, class = ?, noteId = ?, pipelineVersion = ?, pages = ?
       WHERE sha256 = ?`,
      updated.checks,
      updated.findings,
      updated.class,
      updated.noteId,
      updated.pipelineVersion,
      updated.pages,
      file.sha256,
    );
    const owner = fileOwner(file.sha256);
    if (!cleared(updated) || pages === undefined) return putChunks(sql, owner, file.rev, []);
    putChunks(
      sql,
      owner,
      file.rev,
      chunkFile(file, pages).map((chunk, i) => {
        const vector = vectors[i];
        return { ...chunk, family: updated.class, ...(vector && { vector }) };
      }),
    );
  });
}
