/**
 * Pre-signup invitation gate — provider-neutral core (WS-3.3, trigger-hook
 * extraction per 02-trellis-redesign §3 step 3 / the WS-2 worker pattern).
 *
 * The LOGIC of the Cognito PreSignUp trigger, extracted verbatim: signup is
 * invitation-only, fail-closed against the `invitations` record that
 * `lib/invitation-presignup-record.ts` writes (single writer). The Cognito
 * Lambda (`lambda/pre-signup.ts`) is now a thin shell mapping the trigger
 * event onto this function; a Keycloak deployment reaches the same gate from
 * its own registration hook.
 *
 * Behavior parity notes (each preserved exactly):
 *  - the code is looked up EXACTLY as submitted — no case transform (the
 *    writer canonicalizes to upper-case; see invitation-presignup-record.ts);
 *  - `used` is checked BEFORE expiry (a used-and-expired code reports "used");
 *  - a record with no expiry never expires;
 *  - the read uses `includeExpired` so an expired-but-unswept record still
 *    yields the distinct "expired" message (a swept/missing one reports
 *    "invalid or expired") — the exact split the raw-DynamoDB read had;
 *  - error MESSAGES are part of the contract (clients surface them).
 */

import type { KvStore } from "@de-otio/saas-foundation/kv";

/** The record value the single writer stores (invitation-presignup-record.ts). */
interface PreSignUpInvitationValue {
  used?: boolean;
  usedBy?: string;
  email?: string;
}

export interface InvitationGateDeps {
  /** The `invitations`-namespace KvStore. */
  readonly store: KvStore;
  /** Injectable clock, epoch ms (frozen-clock tests). Defaults to Date.now. */
  readonly now?: () => number;
}

/**
 * Assert an invitation code permits registration. Resolves on a valid code;
 * throws the exact user-facing message otherwise (fail closed — any lookup
 * error propagates so the identity provider retries rather than admitting).
 */
export async function assertInvitationValid(
  invitationCode: string | undefined,
  deps: InvitationGateDeps,
): Promise<void> {
  if (!invitationCode) {
    throw new Error("An invitation code is required to register.");
  }

  // The KvStore rejects keys containing the adapter's pk separator with a
  // TypeError; a user-submitted code can contain anything. Map that shape to
  // the same fail-closed "invalid" outcome a missing record produces.
  if (/[:#]/.test(invitationCode)) {
    throw new Error("Invalid or expired invitation code.");
  }

  const record = await deps.store.get<PreSignUpInvitationValue>(invitationCode, {
    includeExpired: true,
  });
  if (record === null) {
    throw new Error("Invalid or expired invitation code.");
  }

  if (record.value.used) {
    throw new Error("This invitation code has already been used.");
  }

  const nowSeconds = Math.floor((deps.now ?? Date.now)() / 1000);
  if (record.expiresAt !== undefined && record.expiresAt < nowSeconds) {
    throw new Error("This invitation code has expired.");
  }
}
