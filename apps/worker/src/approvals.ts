// The passkey half of approvals (contract §4): a WebAuthn assertion is checked here, in the DO, against the
// passkey the Worker loaded for the record's owner. What it signed (a plan hash or a review nonce) is judged
// and used up in @brainiac/base, in the mutation's transaction.
import type { Signature } from "@brainiac/base";
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";

import { canApprove } from "./auth/recovery.ts";

/**
 * The passkey that signed, as the Worker's session route loads it from Neon: one of the record owner's
 * passkeys, picked by the response's credential id. Never from the request body.
 */
export interface Approver {
  readonly credentialId: string;
  /** The COSE public key, base64, as Better Auth stores it. */
  readonly publicKey: string;
  readonly counter: number;
  /** Null until enrollment finishes; in the future while a recovered account waits its 72 hours. */
  readonly approvesAt: Date | null;
  /** The site's origin. Passkeys are bound to its host. */
  readonly origin: string;
}

export type Checked = Signature | { readonly error: string };

/**
 * Whether `response` is this passkey signing `challenge` on our site with the person verified, and with a
 * counter past the last one the record saw. The record still refuses a signature it has used before.
 */
export async function checkSignature(
  response: AuthenticationResponseJSON,
  challenge: string,
  approver: Approver,
  lastCounter: number,
  now: number,
): Promise<Checked> {
  if (response.id !== approver.credentialId) return { error: "That passkey isn't the one that signed." };
  if (!canApprove(approver, new Date(now))) return { error: "This passkey can't approve yet." };
  try {
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: approver.origin,
      expectedRPID: new URL(approver.origin).hostname,
      credential: {
        id: approver.credentialId,
        publicKey: new Uint8Array(Buffer.from(approver.publicKey, "base64")),
        counter: Math.max(approver.counter, lastCounter),
      },
      requireUserVerification: true,
    });
    if (!verified) return { error: "The passkey signature doesn't check out." };
    return {
      credentialId: approver.credentialId,
      counter: authenticationInfo.newCounter,
      assertion: JSON.stringify(response),
    };
  } catch (error) {
    // SimpleWebAuthn throws on every mismatch (challenge, origin, signature, counter); none is our fault.
    return { error: error instanceof Error ? error.message : "The passkey signature doesn't check out." };
  }
}
