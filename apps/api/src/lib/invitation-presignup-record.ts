/**
 * PreSignUp invitation record (raw DynamoDB item).
 *
 * The Cognito PreSignUp trigger (`apps/api/src/lambda/pre-signup.ts`) enforces
 * invitation-only signup fail-closed by `GetItem`-ing a raw DynamoDB item keyed
 * `{ pk: "invitations:<CODE>", sk: "v" }` and rejecting when it is missing,
 * `used` is truthy, or `ttl` (epoch seconds) is in the past. That item is the
 * ONLY thing PreSignUp reads — the trigger has no DB/RDS access by design.
 *
 * This module is the single writer of that item, so real invited signup works:
 *   - {@link writePreSignUpInvitationRecord} runs when an invitation is created
 *     (invitation-handler), so the invited user can actually pass the gate.
 *     Before this existed, only tests seeded the row and invited signup was
 *     impossible in any real environment (the create flow wrote only a Prisma
 *     `Invitation` row + an `invitation-session:` KV token, neither of which
 *     PreSignUp reads).
 *   - {@link markPreSignUpInvitationRecordUsed} runs from PostConfirmation after
 *     a successful signup, flipping `used: true` so the code cannot be redeemed
 *     a second time (PreSignUp rejects `used` items).
 *
 * CASING (load-bearing): PreSignUp looks up the code exactly as the user submits
 * it — no case transform. Invitation codes are generated and stored upper-case
 * (`generateInvitationCode`), the Zod validate/redeem schemas upper-case, and
 * `markInvitationAsUsed` / PostConfirmation upper-case before the Prisma lookup.
 * So we canonicalize to upper-case here too: the pk we WRITE must equal the pk
 * the user PRESENTS at signup. A casing mismatch silently reintroduces the bug.
 */

import type { KvStore } from "@de-otio/saas-foundation/kv";
import { getKvStore } from "./kv/kv-provider.js";

/** The record value stored under the invitation key (pk/sk/ttl are reserved). */
interface PreSignUpInvitationValue {
  used: boolean;
  usedBy?: string;
  email?: string;
}

let _store: KvStore | null = null;

/**
 * The `invitations` KvStore, provider-selected (KV_PROVIDER, default DynamoDB).
 * On AWS the raw item PreSignUp reads is UNCHANGED: pk `invitations:<CODE>`, sk
 * `v`, ttl epoch seconds (the KvStore key is the upper-cased code, so the port
 * recomposes the exact pk; only the additive `_v` differs). The record VALUE is
 * `{ used, usedBy?, email? }` — never pk/sk/ttl, which the port owns.
 */
function store(): KvStore {
  if (_store !== null) return _store;
  _store = getKvStore("invitations");
  return _store;
}

/** Test seam: inject a `KvStore` (e.g. `MemoryKvStore`) for outcome-equivalence tests. */
export function __setInvitationStoreForTest(s: KvStore | null): void {
  _store = s;
}

/** The `pk` the PreSignUp reader looks up for a given invitation code. */
export function preSignUpInvitationPk(code: string): string {
  return `invitations:${code.toUpperCase()}`;
}

export interface WritePreSignUpInvitationRecordInput {
  /** The invitation code (as stored in Prisma / returned to the inviter). */
  code: string;
  /** Invitation expiry — written as the DynamoDB `ttl` in epoch SECONDS. */
  expiresAt: Date;
  /** Email restriction, if the invite is email-scoped. Carried for a future
   *  PreSignUp email-match check; PreSignUp does NOT enforce it today. */
  email?: string | null;
  /** Injectable for tests. */
  store?: KvStore;
}

/**
 * Write the fail-closed PreSignUp record for a freshly created invitation.
 * The DynamoKvStore layout renders the same raw item `pre-signup.ts` reads
 * (`pk: "invitations:<CODE>", sk: "v", ttl`), with `{ used, email? }` in the
 * value and `used: false` on create.
 */
export async function writePreSignUpInvitationRecord(
  input: WritePreSignUpInvitationRecordInput,
): Promise<void> {
  const kv = input.store ?? store();
  const value: PreSignUpInvitationValue = {
    used: false,
    ...(input.email ? { email: input.email } : {}),
  };
  await kv.put(input.code.toUpperCase(), value, {
    expiresAt: Math.floor(input.expiresAt.getTime() / 1000),
  });
}

export interface DeletePreSignUpInvitationRecordInput {
  /** The invitation code whose PreSignUp record should be removed. */
  code: string;
  /** Injectable for tests. */
  store?: KvStore;
}

/**
 * Remove the PreSignUp record for an invitation that is being deleted.
 *
 * Without this, deleting an invitation via the API leaves its fail-closed
 * DynamoDB item behind, so the deleted code stays redeemable until its `ttl`
 * lapses. Deleting the item here revokes the code immediately (PreSignUp then
 * rejects the missing item, failing closed).
 *
 * Best-effort: callers should treat a failure as non-fatal (log, don't throw)
 * so it never breaks the overall invitation-delete response — the Prisma row
 * and session token are removed regardless. Keyed off the same upper-cased pk
 * the record was written under (see the casing note above).
 */
export async function deletePreSignUpInvitationRecord(
  input: DeletePreSignUpInvitationRecordInput,
): Promise<void> {
  const kv = input.store ?? store();
  await kv.delete(input.code.toUpperCase());
}

export interface MarkPreSignUpInvitationRecordUsedInput {
  /** The invitation code presented at signup. */
  code: string;
  /** User id (or email) that redeemed the code. */
  usedBy: string;
  /** Preserved email restriction, if known. */
  email?: string | null;
  /** Preserved expiry, if known; otherwise a bounded future ttl is used. */
  expiresAt?: Date;
  /** Injectable for tests. */
  store?: KvStore;
}

/**
 * Mark the PreSignUp record `used` so the code cannot be redeemed twice.
 *
 * Uses `PutItem` (not `UpdateItem`) deliberately: the PostConfirmation Lambda
 * role is granted `dynamodb:PutItem` but not `dynamodb:UpdateItem`, so
 * overwriting the item keeps this fix self-contained (no IAM/CDK change). Only
 * `used: true` is load-bearing for the gate — PreSignUp rejects any item whose
 * `used` is truthy (and also rejects a missing item, so this fails closed even
 * if the marker were lost).
 */
export async function markPreSignUpInvitationRecordUsed(
  input: MarkPreSignUpInvitationRecordUsedInput,
): Promise<void> {
  const kv = input.store ?? store();
  const ttlMs =
    input.expiresAt?.getTime() ?? Date.now() + 24 * 60 * 60 * 1000;
  const value: PreSignUpInvitationValue = {
    used: true,
    usedBy: input.usedBy,
    ...(input.email ? { email: input.email } : {}),
  };
  await kv.put(input.code.toUpperCase(), value, {
    expiresAt: Math.floor(ttlMs / 1000),
  });
}
