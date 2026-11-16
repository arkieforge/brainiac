// Which passkeys can approve, and when a session vouches for one (contract §4). Kept apart from the recovery
// plugin so the pages and the DO's approvals don't load Better Auth at the Worker's startup.
import type { Passkey } from "@better-auth/passkey";

export const RECOVERY_WAIT_MS = 72 * 60 * 60 * 1000;
/** How long a passkey check vouches for the session, like the contract's 10-minute review session. */
export const VOUCH_MS = 10 * 60 * 1000;
/** A first passkey approves at once only during sign-up; an account left without one recovers like any other. */
export const SIGN_UP_MS = 60 * 60 * 1000;

/** `approvesAt` stays empty until enrollment finishes, so a half-enrolled passkey never approves. */
export type ApprovingPasskey = Passkey & { approvesAt?: Date | null };

/** The check approvals (the plan-hash signature in the DO) make before trusting a passkey. */
export const canApprove = (passkey: Pick<ApprovingPasskey, "approvesAt">, now = new Date()) =>
  passkey.approvesAt != null && passkey.approvesAt.getTime() <= now.getTime();

/** What a session records about the last time it proved a passkey that can approve. */
export type SessionFields = {
  passkeyId?: string | null | undefined;
  passkeyAt?: Date | string | null | undefined;
};

/**
 * Until when (ms since epoch, 0 if never) this session counts as holding a passkey that can approve: 10
 * minutes after it last proved one. A session cookie alone isn't possession of a passkey, so an old or stolen
 * one can't vouch for a new passkey.
 */
export const vouchedUntil = (
  session: SessionFields,
  passkeys: readonly ApprovingPasskey[],
  now = new Date(),
) => {
  const passkey = passkeys.find((p) => p.id === session.passkeyId);
  if (!passkey || !canApprove(passkey, now) || session.passkeyAt == null) return 0;
  return new Date(session.passkeyAt).getTime() + VOUCH_MS;
};
