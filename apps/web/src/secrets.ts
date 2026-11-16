// The person's vault as the site shows it (`/api/secrets`): names, the domain each fills on and its policy, never a
// value. Values go in once, when saved, and leave the record only into a form on that domain (the extension's Fill).
import { api } from "./record.ts";

export type Policy = "ask" | "allow" | "never";

export interface Secret {
  readonly name: string;
  readonly domain: string | null;
  readonly policy: Policy;
}

export const POLICIES: readonly { readonly policy: Policy; readonly label: string }[] = [
  { policy: "ask", label: "Ask for my passkey each time" },
  { policy: "allow", label: "Fill on its domain without asking" },
  { policy: "never", label: "Never fill" },
];

const isPolicy = (value: unknown): value is Policy => POLICIES.some(({ policy }) => policy === value);

const secretOf = (value: unknown): Secret | undefined =>
  typeof value === "object" &&
  value !== null &&
  "name" in value &&
  typeof value.name === "string" &&
  "domain" in value &&
  (typeof value.domain === "string" || value.domain === null) &&
  "policy" in value &&
  isPolicy(value.policy)
    ? { name: value.name, domain: value.domain, policy: value.policy }
    : undefined;

/** The person's secrets, or undefined when the record can't be reached: they load only from it, never a cache. */
export async function listSecrets(): Promise<readonly Secret[] | undefined> {
  const res = await api("/api/secrets").catch(() => undefined);
  const body: unknown = res?.ok ? await res.json().catch(() => undefined) : undefined;
  if (typeof body !== "object" || body === null || !("secrets" in body) || !Array.isArray(body.secrets))
    return undefined;
  return body.secrets.flatMap((secret: unknown) => secretOf(secret) ?? []);
}

export interface SecretInput {
  readonly name: string;
  readonly value?: string;
  /** What the person typed: a host or the portal's address, which the record turns into the host. */
  readonly domain?: string | null;
  readonly policy?: Policy;
  /** The person's passkey answer over the challenge a `needsApproval` answer named. */
  readonly response?: unknown;
}

export type Saved =
  | { readonly secret: Secret }
  /** Filling without asking where it didn't before: the person's passkey over `challenge`, then the same save. */
  | { readonly challenge: string }
  | { readonly error: string };

/** Saves a secret, or changes its value, domain or policy. */
export async function saveSecret(input: SecretInput): Promise<Saved> {
  const res = await api("/api/secrets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }).catch(() => undefined);
  if (!res) return { error: "You're offline, so nothing was saved." };
  const body: unknown = await res.json().catch(() => ({}));
  const field = (key: string) =>
    typeof body === "object" && body !== null
      ? Object.entries(body).find(([k]) => k === key)?.[1]
      : undefined;
  const challenge = field("challenge");
  if (res.status === 409 && typeof challenge === "string") return { challenge };
  const secret = secretOf(field("secret"));
  if (res.ok && secret) return { secret };
  const error = field("error") ?? field("reason");
  return { error: typeof error === "string" ? error : "That didn't save." };
}

/** Removes a secret: notes that name it keep the reference, which then fills nothing. */
export async function forgetSecret(name: string): Promise<{ readonly error: string } | undefined> {
  const res = await api("/api/secrets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, forget: true }),
  }).catch(() => undefined);
  if (!res) return { error: "You're offline, so nothing was removed." };
  return res.ok ? undefined : { error: "That didn't work." };
}
