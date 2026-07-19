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
 * - External-identity deletion is deliberately best-effort (swallowed): an
 *   identity-provider failure must NOT become a batch-item failure (it would
 *   re-run `deleteUserData` idempotently but re-page).
 * - GDPR fail-closed (findings 2 + 7): the pseudonym tombstone HMAC key is
 *   resolved lazily through `ctx.resolvePseudonymSecret` (never
 *   `process.env`) and re-asserted non-empty BEFORE any deletion; if
 *   empty/unresolvable the worker throws, the message is not acked, and no
 *   `HMAC("", …)` tombstone can ever be written.
 *
 * No `aws-lambda` types, no `@aws-lambda-powertools`, no `process.env` —
 * transitively (`deleteUserData` takes the secret by argument).
 */

import { deleteUserData } from "../services/user-data-deletion.js";
import type { WorkerContext } from "./context.js";

export interface DeleteAccountPayload {
  readonly userId: string;
}

/** The narrowed capability set this worker needs (finding 4: no more). */
export type DeleteAccountContext = Pick<WorkerContext, "db" | "logger" | "identity"> &
  Required<Pick<WorkerContext, "resolvePseudonymSecret" | "deleteStagingObjects">>;

export async function runDeleteAccount(
  payload: DeleteAccountPayload,
  ctx: DeleteAccountContext,
): Promise<void> {
  const { userId } = payload;

  // 0. GDPR fail-closed gate (finding 2): resolve + assert the tombstone key
  //    BEFORE any deletion. A throw here leaves the message un-acked.
  const pseudonymSecret = await ctx.resolvePseudonymSecret();
  if (pseudonymSecret.length === 0) {
    throw new Error(
      "delete-account: empty pseudonym tombstone secret — refusing erasure (fail-closed)",
    );
  }

  // 1. Look up user email before deleting DB records (needed for the
  //    external-identity deletion below).
  const user = await ctx.db.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  if (!user) {
    ctx.logger.warn("User not found, may already be deleted", { userId });
    return;
  }

  // 2. Delete all database records. Media erasure happens inside
  //    deleteUserData (AR7 / GDPR Art. 17): the user's MediaFile rows are
  //    soft-deleted into the nightly GC purge, which reclaims their CAS
  //    bytes (`cas/{tenantId}/{contentHash}`) within its bounded window.
  const result = await deleteUserData(ctx.db, userId, { pseudonymSecret });

  // 3. Delete the user-scoped STAGING objects (`pending/…`, `processing/…`)
  //    reported by the erasure — the GC purge does not cover staging keys.
  //    Never touches `cas/*` (the helper refuses cas/ keys defensively).
  const staging = await ctx.deleteStagingObjects(result.mediaStagingKeys);
  if (staging.failedBatches > 0 || staging.truncated) {
    ctx.logger.warn("Staging object cleanup incomplete", { userId, ...staging });
  }

  // 4. Delete the external identity (best-effort — swallowed by design; see
  //    the module contract above).
  if (ctx.identity) {
    try {
      await ctx.identity.deleteUser({ email: user.email });
    } catch (identityErr) {
      ctx.logger.warn("Identity deletion failed", { userId, error: identityErr });
    }
  }

  ctx.logger.info("Account deleted", {
    userId,
    itemsDeleted: { ...result, mediaStagingKeys: result.mediaStagingKeys.length },
  });
}
