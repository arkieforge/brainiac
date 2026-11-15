// Secrets and the fill path (docs/internals/security.md, "Secrets"). A secret is sealed in the vault with the domain
// the person saved it for and a policy: `ask` (their passkey each time, over the page's host), `allow` (on the saved
// domain without asking) or `never`. An agent asks for a fill with `fill_form`, naming fields and secrets, and gets
// back only that the fill waits; the values leave the record only to the person, when they press Fill on a page whose
// host is on every named secret's saved domain. Nothing here returns a value to a connection, and a lookalike page
// is named as one.
import { createHash } from "node:crypto";

import { pageHost, placement, savedDomain, ulid, type Placement } from "@brainiac/core";

import { advance, canonical, type Signature } from "./approvals.ts";
import { recordAudit } from "./audit.ts";
import { getConnection } from "./connections.ts";
import type { Context, Forbidden } from "./mutate.ts";
import type { Sql } from "./sql.ts";
import { seal, unseal } from "./vault.ts";

export type Policy = "ask" | "allow" | "never";
const POLICIES: ReadonlySet<string> = new Set<Policy>(["ask", "allow", "never"]);
const isPolicy = (value: string): value is Policy => POLICIES.has(value);

const NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;
/** The longest value a secret holds: a passphrase or a recovery code, never a file. */
const MAX_VALUE = 4096;
/** How long a fill waits for the person to press Fill. */
export const FILL_MS = 15 * 60_000;
/** The most fields one fill names. */
const MAX_FIELDS = 50;

interface SecretRow {
  readonly name: string;
  readonly ciphertext: string;
  readonly policy: Policy;
  readonly domain: string | null;
  /** Bumped by every save, so a passkey signature over one change can't be used for another. */
  readonly rev: number;
}

/** A secret as the person sees it on the site: never its value. */
export interface SecretView {
  readonly name: string;
  readonly domain: string | null;
  readonly policy: Policy;
}

const getSecret = (sql: Sql, name: string): SecretRow | undefined =>
  sql.all<SecretRow>("SELECT name, ciphertext, policy, domain, rev FROM secrets WHERE name = ?", name)[0];

const view = ({ name, domain, policy }: SecretRow): SecretView => ({ name, domain, policy });

const ONLY_YOU: Forbidden = { status: "forbidden", reason: "Only you can see or change your secrets." };

/** Every secret's name, domain and policy, for the person. */
export function listSecrets(sql: Sql, ctx: Context): SecretView[] | Forbidden {
  if (ctx.connection !== undefined) return ONLY_YOU;
  return sql
    .all<SecretRow>("SELECT name, ciphertext, policy, domain, rev FROM secrets ORDER BY name")
    .map(view);
}

const hash = (plan: unknown) => createHash("sha256").update(canonical(plan)).digest("base64url");

/**
 * The challenge for letting a secret fill on `domain` without asking: tagged so it can't equal another plan's hash,
 * and over the secret's `rev` (-1 before it exists), so a signature is good for this one save.
 */
export const secretHash = (name: string, domain: string | null, rev: number): string =>
  hash({ secret: { name, domain, policy: "allow", rev } });

export interface SecretInput {
  readonly name: string;
  /** Required for a new secret; left out, an existing secret keeps its value. */
  readonly value?: string;
  /** A host name or the page it's used on; null fills nowhere. Left out, an existing secret keeps its domain. */
  readonly domain?: string | null;
  /** Left out, an existing secret keeps its policy and a new one asks. */
  readonly policy?: string;
}

export type SavedSecret =
  | { readonly secret: SecretView }
  /** `allow` on a domain the secret wasn't already allowed on needs the person's passkey over `challenge`. */
  | { readonly status: "needsApproval"; readonly challenge: string }
  | Forbidden
  | { readonly error: string };

/** The person saves a secret, or changes its value, domain or policy. */
export function saveSecret(
  sql: Sql,
  key: Uint8Array,
  input: SecretInput,
  ctx: Context,
  signed?: { readonly challenge: string; readonly signature: Signature },
): SavedSecret {
  if (ctx.connection !== undefined) return ONLY_YOU;
  if (!NAME.test(input.name))
    return { error: `A secret's name looks like portal.tum (was "${input.name}").` };
  if (input.policy !== undefined && !isPolicy(input.policy))
    return { error: "policy is ask, allow or never." };
  if (input.value !== undefined && (input.value === "" || input.value.length > MAX_VALUE))
    return { error: `A secret's value is 1 to ${MAX_VALUE} characters.` };
  let domain: string | null | undefined = input.domain;
  if (typeof input.domain === "string") {
    domain = savedDomain(input.domain);
    if (domain === undefined) return { error: "domain is a site's host name, like campus.tum.de." };
  }
  return sql.transaction((): SavedSecret => {
    const existing = getSecret(sql, input.name);
    if (!existing && input.value === undefined) return { error: "A new secret needs its value." };
    const next = {
      domain: domain === undefined ? (existing?.domain ?? null) : domain,
      policy:
        input.policy !== undefined && isPolicy(input.policy) ? input.policy : (existing?.policy ?? "ask"),
    };
    if (next.policy === "allow" && next.domain === null)
      return { error: "A secret filled without asking needs the domain it's for." };
    // Filling without asking where it didn't before is the one change that hands the secret out more freely.
    if (next.policy === "allow" && (existing?.policy !== "allow" || existing.domain !== next.domain)) {
      const challenge = secretHash(input.name, next.domain, existing?.rev ?? -1);
      if (!signed) return { status: "needsApproval", challenge };
      if (signed.challenge !== challenge)
        return { error: "This secret changed since you signed. Sign again." };
      if (!advance(sql, signed.signature)) return { error: "This passkey signature was already used." };
    }
    const ciphertext =
      input.value === undefined
        ? existing?.ciphertext
        : Buffer.from(seal(key, Buffer.from(input.value), `secret:${input.name}`)).toString("base64");
    sql.all(
      `INSERT INTO secrets (name, ciphertext, policy, domain, rev) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT (name) DO UPDATE SET
         ciphertext = excluded.ciphertext, policy = excluded.policy, domain = excluded.domain, rev = rev + 1`,
      input.name,
      ciphertext ?? null,
      next.policy,
      next.domain,
    );
    return { secret: { name: input.name, ...next } };
  });
}

/** The person removes a secret; notes that name it keep the reference, which then fills nothing. */
export function forgetSecret(sql: Sql, name: string, ctx: Context): { forgot: boolean } | Forbidden {
  if (ctx.connection !== undefined) return ONLY_YOU;
  return { forgot: sql.all("DELETE FROM secrets WHERE name = ? RETURNING name", name).length > 0 };
}

/** One field of a form, found on the page by its label, name or id: a value the agent knows, or a secret's name. */
export type FillField =
  | { readonly field: string; readonly value: string }
  | { readonly field: string; readonly secret: string };

interface FillRow {
  readonly id: string;
  readonly connectionId: string | null;
  readonly url: string;
  readonly host: string;
  /** JSON: `FillField[]`. */
  readonly fields: string;
  readonly expiresAt: number;
}

/** A fill as the person sees it before pressing Fill: the values the agent gave, and secrets by name only. */
export interface FillView {
  readonly id: string;
  readonly url: string;
  readonly connectionId: string | null;
  readonly expiresAt: number;
  readonly fields: readonly FillField[];
}

export type Requested =
  | { readonly status: "waiting"; readonly fill: string; readonly url: string; readonly expiresAt: number }
  /** A secret can't go to that page; `message` says why, and whether the page imitates its domain. */
  | { readonly status: "refused"; readonly message: string }
  | Forbidden
  | { readonly error: string };

/** Why a secret can't be filled on `host`, or `undefined` when it can. */
function refusal(secret: SecretRow, host: string): string | undefined {
  if (secret.policy === "never") return `${secret.name} is set never to be filled.`;
  if (secret.domain === null)
    return `${secret.name} has no saved domain, so it fills nowhere yet. Ask the person to save the portal's domain with it on the site.`;
  const where: Placement = placement(host, secret.domain);
  if (where === "lookalike")
    return `${host} imitates ${secret.domain}, where ${secret.name} is saved: it may be a phishing page. Don't enter anything there, and tell the person.`;
  if (where === "elsewhere") return `${secret.name} is saved for ${secret.domain}, and ${host} isn't on it.`;
  return undefined;
}

/**
 * An agent asks for a form to be filled: the request waits, holding no values of secrets, until the person presses
 * Fill on the page (`releaseFill`). Refused up front when a secret couldn't be filled on that page anyway.
 */
export function requestFill(
  sql: Sql,
  input: { readonly url: string; readonly fields: readonly FillField[] },
  ctx: Context,
): Requested {
  if (ctx.connection !== undefined && ctx.connection.level !== "write")
    return {
      status: "forbidden",
      reason: "Filling forms needs a write connection; the person can raise it.",
    };
  const host = pageHost(input.url);
  if (host === undefined) return { error: "url is the form's https page, like https://campus.tum.de/apply." };
  if (input.fields.length === 0 || input.fields.length > MAX_FIELDS)
    return { error: `Name 1 to ${MAX_FIELDS} fields.` };
  if (input.fields.some((f) => f.field.trim() === "" || f.field.length > 200))
    return { error: "Each field is the label, name or id the page shows, up to 200 characters." };
  for (const field of input.fields) {
    if (!("secret" in field)) continue;
    const secret = getSecret(sql, field.secret);
    if (!secret) {
      const here = savedFor(sql, host);
      return {
        error: `No secret named ${field.secret}.${here.length > 0 ? ` Secrets saved for ${host}: ${here.join(", ")}.` : ""}`,
      };
    }
    const refused = refusal(secret, host);
    if (refused !== undefined) return { status: "refused", message: refused };
  }
  const id = ulid(ctx.now);
  const expiresAt = ctx.now + FILL_MS;
  sql.transaction(() => {
    sql.all("DELETE FROM fills WHERE expiresAt <= ?", ctx.now);
    sql.all(
      "INSERT INTO fills (id, connectionId, url, host, fields, expiresAt) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      ctx.connection?.id ?? null,
      input.url,
      host,
      JSON.stringify(input.fields),
      expiresAt,
    );
  });
  return { status: "waiting", fill: id, url: input.url, expiresAt };
}

/** The names of secrets that could fill on `host`: told to an agent that named one the record doesn't have. */
const savedFor = (sql: Sql, host: string) =>
  sql
    .all<SecretRow>("SELECT name, ciphertext, policy, domain, rev FROM secrets ORDER BY name")
    .filter((secret) => refusal(secret, host) === undefined)
    .map((secret) => secret.name);

const fillView = (row: FillRow): FillView => ({
  id: row.id,
  url: row.url,
  connectionId: row.connectionId,
  expiresAt: row.expiresAt,
  fields: JSON.parse(row.fields),
});

/** The fills waiting for the page at `url`, for the person's extension to offer. */
export function pendingFills(sql: Sql, url: string, ctx: Context): FillView[] | Forbidden {
  if (ctx.connection !== undefined) return ONLY_YOU;
  const host = pageHost(url);
  if (host === undefined) return [];
  return sql
    .all<FillRow>("SELECT * FROM fills WHERE expiresAt > ? ORDER BY id", ctx.now)
    .filter((fill) => placement(host, fill.host) === "on")
    .map(fillView);
}

/**
 * The challenge for a fill that uses an `ask` secret: over the fill, the page's host and each secret's domain, so
 * the passkey signs exactly where the values go. A fill is used once, so its signature can't be used again.
 */
export const fillHash = (fillId: string, host: string, secrets: readonly SecretView[]): string =>
  hash({ fill: { id: fillId, host, secrets: secrets.map(({ name, domain }) => ({ name, domain })) } });

export type Released =
  | { readonly fields: readonly { readonly field: string; readonly value: string }[] }
  /** A secret's policy is `ask`: the person's passkey over `challenge` releases the fill. */
  | { readonly status: "needsApproval"; readonly challenge: string; readonly host: string }
  | Forbidden
  | { readonly error: string };

/**
 * The person presses Fill on the page at `url`: every field's value, secrets unsealed, once. Only when the page's
 * host is on the fill's and on each secret's saved domain as they are now, and with their passkey for an `ask`
 * secret. Every release is in the audit log under the connection that asked.
 */
export function releaseFill(
  sql: Sql,
  key: Uint8Array,
  fillId: string,
  url: string,
  ctx: Context,
  signed?: { readonly challenge: string; readonly signature: Signature },
): Released {
  if (ctx.connection !== undefined) return { status: "forbidden", reason: "Only you can fill a form." };
  return sql.transaction((): Released => {
    const [fill] = sql.all<FillRow>("SELECT * FROM fills WHERE id = ? AND expiresAt > ?", fillId, ctx.now);
    if (!fill) return { error: "This fill ran out or was used. Ask your agent to start it again." };
    if (fill.connectionId !== null && !getConnection(sql, fill.connectionId))
      return { error: "The agent that asked for this fill was disconnected." };
    const host = pageHost(url);
    const where = host === undefined ? "elsewhere" : placement(host, fill.host);
    if (where === "lookalike")
      return { error: `This page only imitates ${fill.host}. Don't enter anything here.` };
    if (host === undefined || where !== "on")
      return { error: `This fill is for ${fill.host}, not this page.` };
    const fields: FillField[] = JSON.parse(fill.fields);
    const secrets: SecretRow[] = [];
    for (const field of fields) {
      if (!("secret" in field)) continue;
      const secret = getSecret(sql, field.secret);
      if (!secret) return { error: `${field.secret} was removed from your vault.` };
      const refused = refusal(secret, host);
      if (refused !== undefined) return { error: refused };
      secrets.push(secret);
    }
    if (secrets.some((secret) => secret.policy === "ask")) {
      const challenge = fillHash(fill.id, host, secrets.map(view));
      if (!signed) return { status: "needsApproval", challenge, host };
      if (signed.challenge !== challenge) return { error: "This fill changed since you signed. Sign again." };
      if (!advance(sql, signed.signature)) return { error: "This passkey signature was already used." };
    }
    sql.all("DELETE FROM fills WHERE id = ?", fill.id);
    if (secrets.length > 0)
      recordAudit(sql, {
        actor: fill.connectionId === null ? ctx.actor : `connection:${fill.connectionId}`,
        tool: "fill",
        noteIds: [],
        secretName: [...new Set(secrets.map((secret) => secret.name))].join(", "),
        at: ctx.now,
      });
    return {
      fields: fields.map((field) => {
        if (!("secret" in field)) return field;
        const secret = secrets.find((s) => s.name === field.secret);
        if (!secret) throw new Error(`Secret ${field.secret} wasn't loaded.`);
        const sealed = Buffer.from(secret.ciphertext, "base64");
        return {
          field: field.field,
          value: Buffer.from(unseal(key, sealed, `secret:${secret.name}`)).toString(),
        };
      }),
    };
  });
}

/** The person turns a fill down; it would run out on its own after `FILL_MS`. */
export function dismissFill(sql: Sql, fillId: string, ctx: Context): { dismissed: boolean } | Forbidden {
  if (ctx.connection !== undefined) return ONLY_YOU;
  return { dismissed: sql.all("DELETE FROM fills WHERE id = ? RETURNING id", fillId).length > 0 };
}
