/**
 * delete-account worker core (WS-2 T1 — the extraction pattern-setter).
 *
 * The body of ONE queue-message iteration, extracted from
 * `lambda/delete-account-worker.ts`. Contract:
 *
 * - Returns on success or already-deleted (the caller acks the message).
 * - THROWS on transient failure (the AWS entrypoint records a batch-item
 *   failure; the container leaves the message in flight → redelivery).
 * - `deleteUserData` is idempotent (soft-delete + GC), safe under
 *   at-least-once redelivery.
 * - External-identity deletion runs FIRST and a failure THROWS (message not
 *   acked → redelivery, then DLQ). It used to run last and be swallowed:
 *   once `deleteUserData` had removed the row, nothing recorded that the
 *   identity still needed deleting, so a failed delete was never retried and
 *   the erased account could still sign in. Throwing before any erasure makes
 *   the redelivery a clean rerun; adapters treat "already absent" as success,
 *   so a rerun after a later step failed is a no-op here. Same order as the
 *   nightly cron, which also backstops a message that ends in the DLQ (the
 *   row is still due).
 * - GDPR fail-closed (findings 2 + 7): the pseudonym tombstone HMAC key is
 *   resolved lazily through `ctx.resolvePseudonymSecret` (never
 *   `process.env`) and re-asserted non-empty BEFORE any deletion; if
 *   empty/unresolvable the worker throws, the message is not acked, and no
 *   `HMAC("", …)` tombstone can ever be written.
 *
 * - The message is a POINTER, never the authority (worker review W3). A
 *   `{ userId }` on the queue proves only that something holding the queue
 *   credential sent it; the erasure runs only when the user row itself says
 *   erasure is due — see `erasureAuthorization`. Anything else throws
 *   (no-ack → DLQ), so a forged message is retained for inspection rather
 *   than acted on or silently dropped.
 *
 * No `aws-lambda` types, no `@aws-lambda-powertools`, no `process.env` —
 * transitively (`deleteUserData` takes the secret by argument).
 */

import { z } from "zod";
import { deleteUserData } from "../services/user-data-deletion.js";
import type { WorkerContext } from "./context.js";
import { E2E_PREFIX } from "./e2e-sweeper.js";
import { formatIssuePaths } from "./queue-payload.js";

/**
 * The wire schema. Strict: a scalar, bounded `userId` and nothing else. This
 * is what closes the type-confusion class — `{"userId": {"not": ""}}` would
 * otherwise reach ~20 `deleteMany({ where: { userId } })` filters as an
 * all-rows predicate, stopped today only by `findUnique` happening first.
 */
export const DeleteAccountPayloadSchema = z.strictObject({
  userId: z.string().min(1).max(255),
});

export type DeleteAccountPayload = z.infer<typeof DeleteAccountPayloadSchema>;

/** The narrowed capability set this worker needs (finding 4: no more). */
export type DeleteAccountContext = Pick<WorkerContext, "db" | "logger" | "identity" | "clock"> &
  Required<Pick<WorkerContext, "resolvePseudonymSecret" | "deleteStagingObjects">>;

/** The user-row fields the authorization decision reads. */
export interface ErasureAuthorizationInput {
  readonly email: string;
  readonly deletionConfirmedAt: Date | null;
  readonly deletionScheduledAt: Date | null;
}

export type ErasureAuthorization =
  | { readonly authorized: true; readonly basis: "scheduled-deletion-due" | "e2e-test-user" }
  | { readonly authorized: false; readonly reason: string };

/**
 * Is this user's erasure due, on the evidence of state the API wrote?
 *
 * Exactly two bases, each mirroring an existing producer-side rule so the
 * queue can never erase an account the system would not erase anyway:
 *
 *  1. `scheduled-deletion-due` — the nightly cron's own predicate
 *     (`nightly-cron.ts`, step 4: `deletionConfirmedAt` set AND
 *     `deletionScheduledAt <= now`). Both columns are written only by the
 *     authenticated request/confirm flow in `user-deletion-handler-enhanced.ts`,
 *     and cancel clears them. Keep the two predicates identical.
 *  2. `e2e-test-user` — the e2e sweeper's selection rule: it enqueues only
 *     identity-provider users whose email starts with `E2E_PREFIX`, without
 *     writing any deletion state (by design — it never queries the DB).
 *
 * Pure: the caller supplies `now`.
 */
export function erasureAuthorization(
  user: ErasureAuthorizationInput,
  now: number,
): ErasureAuthorization {
  if (user.email.startsWith(E2E_PREFIX)) {
    return { authorized: true, basis: "e2e-test-user" };
  }
  if (user.deletionConfirmedAt === null) {
    return { authorized: false, reason: "no confirmed deletion request" };
  }
  if (user.deletionScheduledAt === null) {
    return { authorized: false, reason: "confirmed deletion has no scheduled time" };
  }
  if (user.deletionScheduledAt.getTime() > now) {
    return { authorized: false, reason: "scheduled deletion time not yet reached" };
  }
  return { authorized: true, basis: "scheduled-deletion-due" };
}

export async function runDeleteAccount(
  payload: unknown,
  ctx: DeleteAccountContext,
): Promise<void> {
  // Validate here as well as at the container's dispatcher seam: the AWS
  // entrypoint reaches this core directly, and the guarantee must not depend
  // on which host delivered the message. A throw leaves it un-acked (→ DLQ).
  const parsed = DeleteAccountPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `delete-account: payload failed schema validation (${formatIssuePaths(parsed.error)}) — refusing erasure`,
    );
  }
  const { userId } = parsed.data;

  // 0. GDPR fail-closed gate (finding 2): resolve + assert the tombstone key
  //    BEFORE any deletion. A throw here leaves the message un-acked.
  //    Hardened (test-critique F3): a non-string resolver return or a
  //    whitespace-only value is as unkeyed as "" — `HMAC("\t\n", …)` is just
  //    as guessable — so the gate trims and type-checks, matching
  //    startup-validation and the nightly/deleteUserData gates.
  const pseudonymSecret = await ctx.resolvePseudonymSecret();
  if (typeof pseudonymSecret !== "string" || pseudonymSecret.trim().length === 0) {
    throw new Error(
      "delete-account: empty/whitespace pseudonym tombstone secret — refusing erasure (fail-closed)",
    );
  }

  // 1. Look up the user: the email (needed for the external-identity
  //    deletion below) and the deletion state the authorization reads.
  const user = await ctx.db.user.findUnique({
    where: { id: userId },
    select: { email: true, deletionConfirmedAt: true, deletionScheduledAt: true },
  });

  if (!user) {
    ctx.logger.warn("User not found, may already be deleted", { userId });
    return;
  }

  // 1b. W3: the row, not the message, authorizes the erasure. Refusal is a
  //     throw, not an ack-drop: nothing legitimate produces a message this
  //     rejects, so the message goes to the DLQ as evidence.
  const authorization = erasureAuthorization(user, ctx.clock());
  if (!authorization.authorized) {
    ctx.logger.error("delete-account: refusing erasure — no due deletion recorded for this user", {
      userId,
      reason: authorization.reason,
    });
    throw new Error(`delete-account: refusing erasure (${authorization.reason})`);
  }

  // 2. Delete the external identity FIRST (see the module contract): a
  //    failure throws before anything is erased, so redelivery retries it.
  if (ctx.identity) {
    await ctx.identity.deleteUser({ email: user.email });
  }

  // 3. Delete all database records. Media erasure happens inside
  //    deleteUserData (AR7 / GDPR Art. 17): the user's MediaFile rows are
  //    soft-deleted into the nightly GC purge, which reclaims their CAS
  //    bytes (`cas/{tenantId}/{contentHash}`) within its bounded window.
  const result = await deleteUserData(ctx.db, userId, { pseudonymSecret });

  // 4. Delete the user-scoped STAGING objects (`pending/…`, `processing/…`)
  //    reported by the erasure — the GC purge does not cover staging keys.
  //    Never touches `cas/*` (the helper refuses cas/ keys defensively).
  const staging = await ctx.deleteStagingObjects(result.mediaStagingKeys);
  // An Art. 17 erasure that did not erase is an ERROR, not a warning. The
  // staging keys are derived, not stored (user-media-erasure.ts builds them
  // from `tenantId` + `uploadId`/`contentHash`), so they are recoverable only
  // while the soft-deleted MediaFile rows survive — the nightly purge's
  // 7-day window. Past that the bytes are unreachable and unattributable.
  const stagingCleanupIncomplete = staging.failedBatches > 0 || staging.truncated;
  if (stagingCleanupIncomplete) {
    ctx.logger.error("Staging object cleanup incomplete", { userId, ...staging });
  }

  // The completion record must not read as an unqualified success when part of
  // the erasure did not happen. This line is what an operator (or an Art. 17
  // response) is read off; "Account deleted" with no qualifier while media
  // remains in the bucket is the actual defect, not the failed delete itself.
  ctx.logger.info("Account deleted", {
    userId,
    basis: authorization.basis,
    stagingCleanupIncomplete,
    itemsDeleted: { ...result, mediaStagingKeys: result.mediaStagingKeys.length },
  });
}
