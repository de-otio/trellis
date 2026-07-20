/**
 * Thin AWS entrypoint for the Cognito PreSignUp trigger (WS-3.3 trigger-hook
 * extraction, WS-2 pattern).
 *
 * Owns the Cognito concerns only: the trigger-event shape (the invitation
 * code arrives via `custom:invitationCode` or clientMetadata) and the
 * response flags. The invitation-gate LOGIC lives in
 * `lib/identity/invitation-gate.ts`, reading the `invitations` record through
 * the KvStore port (`KV_PROVIDER`, default DynamoDB — the byte-compatible
 * item this trigger always read: pk `invitations:<CODE>`, sk `v`, ttl).
 */

import type { PreSignUpTriggerHandler } from "aws-lambda";
import type { KvStore } from "@de-otio/saas-foundation/kv";
import { assertInvitationValid } from "../lib/identity/invitation-gate.js";
import { getKvStore } from "../lib/kv/kv-provider.js";

let _store: KvStore | null = null;

function store(): KvStore {
  if (_store === null) _store = getKvStore("invitations");
  return _store;
}

/** Test seam: inject a `KvStore` (e.g. `MemoryKvStore`); pass null to reset. */
export function __setInvitationStoreForTest(s: KvStore | null): void {
  _store = s;
}

export const handler: PreSignUpTriggerHandler = async (event) => {
  const invitationCode = (event.request.userAttributes["custom:invitationCode"] ||
                          event.request.clientMetadata?.invitationCode) as string | undefined;

  await assertInvitationValid(invitationCode, { store: store() });

  // Auto-confirm and auto-verify invited users.
  //
  // Registration is passwordless (magic-link CUSTOM_AUTH). An UNCONFIRMED user
  // cannot initiate that flow, so without auto-confirm an invited sign-up would
  // create an account that can never sign in. This is safe because:
  //   - entry is already gated by a single-use invitation code (checked above);
  //   - access still requires answering the magic-link challenge, i.e. receiving
  //     and clicking a link sent to this exact address — the link, not this
  //     flag, is the real proof of email ownership and the access gate.
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;

  return event;
};
