import { createHmac } from "node:crypto";
import { getParameter } from "@aws-lambda-powertools/parameters/ssm";
import { resolveSecret, secretRef } from "@de-otio/saas-foundation/secrets";
import type { PrismaClient } from "@prisma/client";
import { EXTENSION_MODEL_REGISTRY } from "../extension-model-registry.js";
import { getLogger } from "../logger.js";

/**
 * Deterministic tombstone for a deleted user's ID in retained aggregate
 * records (Surveillance-hardening Phase 0, P4). Replaces the plaintext user ID
 * in ACCOUNT-report `resourceId` so aggregate pattern analysis survives while
 * the identifier does not — "pattern analysis" is NOT an Art. 17(3) exemption.
 * Same (key, userId) → same tombstone, so per-target report counts stay
 * coherent within a deletion.
 *
 * KEYED HMAC, not a bare hash (security review H1): user IDs are short,
 * enumerable CUIDs, so an unsalted SHA-256 tombstone is rainbow-table
 * reversible by any party holding ONLY the database (operator, backup
 * exfiltration, compelled disclosure). The key lives in a managed secret
 * store — never in the database or the public npm tarball — so the DB alone
 * cannot reverse the tombstone. The key is supplied by the caller
 * (`resolvePseudonymSecret`), NOT read from process.env here: in production
 * the real secret is resolved onto the app's Env/SSM and process.env is empty.
 */
export function pseudonymizeUserId(userId: string, secret: string): string {
  return `deleted:${createHmac("sha256", secret).update(userId).digest("hex").slice(0, 32)}`;
}

/**
 * Resolve the erasure-tombstone HMAC key. Resolution order:
 *   1. `REPORT_PSEUDONYM_SECRET` — plaintext (local / dev / CI / tests).
 *   2. `REPORT_PSEUDONYM_SECRET_PARAM` — name of an SSM Parameter Store
 *      SecureString, fetched + KMS-decrypted + cached via AWS Lambda
 *      Powertools. This is the production path (a dedicated key, separately
 *      rotatable; destroying it crypto-shreds all prior tombstones).
 *   3. Fallback to the session secret (plaintext `SESSION_SECRET`, else
 *      `SESSION_SECRET_ARN` resolved from Secrets Manager via the foundation
 *      resolver) so a deployment without a dedicated key is still keyed, not
 *      unkeyed.
 *
 * Never reads the HMAC key from `process.env` for production secrets — the app
 * resolves those onto Env and deliberately leaves process.env empty.
 * Caches the SSM value across deletions (Powertools default cache).
 *
 * FAIL-CLOSED (WS-2 security finding 2): an unresolvable key is a hard error,
 * never an empty-string default. `HMAC("", userId)` tombstones are reversible
 * (CUID user ids are rainbow-tableable) and mutually correlatable, defeating
 * pseudonymized erasure — so a deployment without a resolvable key must FAIL
 * the deletion (message redelivers / cron retries), not silently erase with
 * an unkeyed tombstone.
 */
export async function resolvePseudonymSecret(): Promise<string> {
  if (process.env.REPORT_PSEUDONYM_SECRET) {
    return process.env.REPORT_PSEUDONYM_SECRET;
  }
  const ssmParam = process.env.REPORT_PSEUDONYM_SECRET_PARAM;
  if (ssmParam) {
    const value = await getParameter(ssmParam, { decrypt: true });
    if (value) return value;
  }
  // Fallback: the session secret (Secrets Manager ARN or plaintext).
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.SESSION_SECRET_ARN) {
    const resolved = (
      await resolveSecret(secretRef(process.env.SESSION_SECRET_ARN))
    ).toString("utf-8");
    if (resolved) return resolved;
  }
  throw new Error(
    "resolvePseudonymSecret: no erasure-tombstone HMAC key resolvable " +
      "(REPORT_PSEUDONYM_SECRET / REPORT_PSEUDONYM_SECRET_PARAM / session secret) — " +
      "failing closed; an unkeyed tombstone would be reversible",
  );
}

/**
 * Minimal delegate shape needed to erase an extension-owned model by subject.
 * Deliberately narrower than a full Prisma delegate — avoids `any` while
 * staying agnostic of the (currently empty, composer-generated) model set.
 */
interface DeleteManyDelegate {
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
}

/**
 * Look up a composed `ext_*` model's delegate on the Prisma client by its
 * registry-declared name. Throws (rather than silently skipping) if the
 * registry and the generated client have drifted — a silent skip would leave
 * a data subject's extension-owned rows behind, which is an Art. 17 failure.
 */
function getExtensionDeleteManyDelegate(
  db: PrismaClient,
  model: string,
): DeleteManyDelegate {
  const delegate = (db as unknown as Record<string, DeleteManyDelegate | undefined>)[
    model
  ];
  if (!delegate || typeof delegate.deleteMany !== "function") {
    throw new Error(
      `deleteUserData: extension model registry entry "${model}" has no ` +
        `deleteMany delegate on PrismaClient (registry/schema drift)`,
    );
  }
  return delegate;
}

export interface DeletionResult {
  commentSentiments: number;
  postSentiments: number;
  comments: number;
  posts: number;
  entities: number;
  follows: number;
  directMessages: number;
  audienceMembers: number;
  audiences: number;
  securityEvents: number;
  crossRegionConsents: number;
  invitations: number;
  /** Target-side InteractionEvent rows (Surveillance-hardening Phase 0, P2).
   *  Actor-side rows cascade via the FK on user.delete(). */
  interactionEventsAsTarget: number;
  /** ACCOUNT-report rows whose resourceId (the reported user) was pseudonymized
   *  (Surveillance-hardening Phase 0, P4 / GDPR Art. 17). Reports filed BY the
   *  user cascade via the reporter FK. */
  accountReportsPseudonymized: number;
  /** MediaFile rows soft-deleted into the nightly GC purge (AR7 / GDPR
   *  Art. 17 — media erasure via the shared storage-accounting invariant). */
  mediaFilesErased: number;
  /** MediaFile rows RETAINED because another user's content still references
   *  them (within-tenant dedup); only the personal link was scrubbed. */
  mediaFilesRetainedShared: number;
  /** User-scoped staging S3 keys (`pending/…`, `processing/…`) the CALLER must
   *  delete — this service is DB-only (see the "Does NOT delete" contract). */
  mediaStagingKeys: string[];
  /** Extension-owned (`ext_*`) rows erased per-subject via the O-1 composed
   *  model registry (design §6 / §12.4 item 1). Registry is empty until an
   *  extension declares a subject-scoped model, so this is 0 today. */
  extensionRowsErased: number;
}

export interface DeleteUserDataOptions {
  /**
   * The GDPR-erasure tombstone HMAC key (WS-2 findings 2 + 7). REQUIRED and
   * resolved by the CALLER (Lambda entrypoint / worker context / route) —
   * this service never reads `process.env` or a secret store itself, so it is
   * hostable in the provider-neutral worker container. An empty value is a
   * hard error before any deletion (fail-closed; see the H1 note on
   * {@link pseudonymizeUserId}).
   */
  readonly pseudonymSecret: string;
}

/**
 * Cascade-deletes all data owned by a user from the database.
 *
 * Does NOT delete:
 * - Cognito identity (caller's responsibility)
 * - S3 objects (caller's responsibility). The user's MediaFile ROWS are
 *   erased here (AR7 / GDPR Art. 17): unreferenced rows are soft-deleted into
 *   the nightly GC purge, which reclaims their CAS bytes; the user-scoped
 *   STAGING keys the purge does not cover are returned as
 *   `mediaStagingKeys` for the caller to delete from S3.
 * - DynamoDB cache entries (caller's responsibility)
 *
 * Does NOT check authorization — caller must verify permissions.
 *
 * Models with onDelete: Cascade on the User relation (MfaEnrollment, and
 * Report via the reporter FK) are automatically deleted by the final
 * user.delete().
 */
export async function deleteUserData(
  db: PrismaClient,
  userId: string,
  options: DeleteUserDataOptions,
): Promise<DeletionResult> {
  // FAIL-CLOSED gate (finding 2): assert the tombstone key BEFORE any
  // deletion, so an unkeyed run can never delete data and then write a
  // reversible `HMAC("", …)` tombstone in step 15c. Re-asserted here (not
  // only at caller startup) because a secret can rotate to empty mid-process.
  const pseudonymSecret = options.pseudonymSecret;
  if (typeof pseudonymSecret !== "string" || pseudonymSecret.length === 0) {
    throw new Error(
      "deleteUserData: empty/absent pseudonym tombstone secret — refusing erasure " +
        "(fail-closed; an unkeyed tombstone would be reversible)",
    );
  }

  // Delete related records first to avoid foreign key constraint violations.
  // Order matters: delete child records before parent records.

  // 1. Delete comment sentiments (references comments)
  const commentSentiments = await db.commentSentiment.deleteMany({
    where: { authorId: userId },
  });

  // 2. Delete post sentiments (references posts)
  const postSentiments = await db.postSentiment.deleteMany({
    where: { authorId: userId },
  });

  // 3. Delete comment media (references comments)
  const userComments = await db.postComment.findMany({
    where: { authorId: userId },
    select: { id: true },
  });
  if (userComments.length > 0) {
    const commentIds = userComments.map((c) => c.id);
    await db.postCommentMedia.deleteMany({
      where: { commentId: { in: commentIds } },
    });
  }

  // 4. Delete comments
  const comments = await db.postComment.deleteMany({
    where: { authorId: userId },
  });

  // 5. Delete post-related records (junction tables, media)
  const userPosts = await db.post.findMany({
    where: { authorId: userId },
    select: { id: true },
  });
  if (userPosts.length > 0) {
    const postIds = userPosts.map((p) => p.id);
    await db.postSubject.deleteMany({ where: { postId: { in: postIds } } });
    await db.postTaxonomyTag.deleteMany({ where: { postId: { in: postIds } } });
    await db.postMedia.deleteMany({ where: { postId: { in: postIds } } });
  }

  // 6. Delete posts
  const posts = await db.post.deleteMany({
    where: { authorId: userId },
  });

  // 6b. Erase the user's media (AR7 / GDPR Art. 17). MUST run after the user's
  //     own posts/comments and their PostMedia/PostCommentMedia junction rows
  //     are gone (steps 3–6) — the erasure service treats any surviving
  //     reference as "another user's content" and retains the row. Unreferenced
  //     rows are soft-deleted, which enqueues their CAS bytes for the existing
  //     GC path (nightly soft-deleted-media purge). Staging S3 keys are
  //     returned to the caller — S3 remains the caller's responsibility.
  const { eraseUserMedia } = await import("./user-media-erasure.js");
  const mediaErasure = await eraseUserMedia(db, userId);

  // 7. Delete entity-related records
  const userEntities = await db.entity.findMany({
    where: { owners: { some: { userId: userId, status: 'ACTIVE' } } },
    select: { id: true },
  });
  if (userEntities.length > 0) {
    const entityIds = userEntities.map((e) => e.id);
    await db.entityTaxonomyTag.deleteMany({
      where: { entityId: { in: entityIds } },
    });
  }

  // 8. Delete entity ownerships and entities
  await db.entityOwnership.deleteMany({
    where: { userId: userId },
  });
  const entities = await db.entity.deleteMany({
    where: { owners: { none: {} } }, // Delete entities with no remaining owners
  });

  // 9. Follow relationships now handled by graph DB — no-op

  // 10. Delete direct messages (sent and received)
  const directMessages = await db.directMessage.deleteMany({
    where: { OR: [{ senderId: userId }, { recipientId: userId }] },
  });

  // 11. Delete custom audience memberships
  const audienceMembers = await db.customAudienceMember.deleteMany({
    where: { memberId: userId },
  });

  // 12. Delete custom audiences created by user
  const audiences = await db.customAudience.deleteMany({
    where: { creatorId: userId },
  });

  // 13. Delete security events
  const securityEvents = await db.securityEvent.deleteMany({
    where: { userId },
  });

  // 14. Delete consents (all purposes: cross-region + research)
  const crossRegionConsents = await db.consent.deleteMany({
    where: { userId },
  });

  // 15. Delete invitations (both created and used)
  const invitations = await db.invitation.deleteMany({
    where: { OR: [{ createdBy: userId }, { usedBy: userId }] },
  });

  // 15b. Delete TARGET-side InteractionEvent rows (Surveillance-hardening Phase
  //      0, P2 / GDPR Art. 17). The ACTOR side (actor_user_id) cascades via FK
  //      on user.delete(); targetId has no FK, so rows ABOUT the deleted user
  //      (targetType "user") need an explicit deleteMany. Erasure must be
  //      prompt — "ages out in ≤120 days" is not Art. 17 compliance.
  const interactionEventsAsTarget = await db.interactionEvent.deleteMany({
    where: { targetType: "user", targetId: userId },
  });

  // 15c. Pseudonymize ACCOUNT reports ABOUT the deleted user (Surveillance-
  //      hardening Phase 0, P4 / GDPR Art. 17). resourceId has no FK; replace
  //      the plaintext user ID with a deterministic tombstone so aggregate
  //      pattern analysis survives but the identifier does not. (No ACCOUNT
  //      reports exist until Phase 1, but the erasure path ships with the model
  //      so Phase 1 cannot forget it.) Reports filed BY the user cascade via the
  //      reporter FK on user.delete().
  const accountReports = await db.report.updateMany({
    where: { reportType: "ACCOUNT", resourceType: "user", resourceId: userId },
    data: { resourceId: pseudonymizeUserId(userId, pseudonymSecret) },
  });

  // 15d. Erase extension-owned (`ext_*`) rows for this subject (O-1 design §6
  //      / §12.4 item 1). Runs BEFORE the final db.user.delete() below so a
  //      subject-scoped ext_* row is explicitly removed rather than left to
  //      race an FK cascade; `cascade-only` models (erasureSubjectField ===
  //      null) are intentionally skipped here and rely on their
  //      onDelete: Cascade FK to User to be cleaned up by user.delete().
  //      EXTENSION_MODEL_REGISTRY is generated by the L2 composer and is
  //      empty today — no extension owns a table yet (O-1 is infra ahead of
  //      its first table-owner) — so this loop is a clean no-op until then.
  let extensionRowsErased = 0;
  for (const entry of EXTENSION_MODEL_REGISTRY) {
    if (!entry.erasureSubjectField) continue;
    const delegate = getExtensionDeleteManyDelegate(db, entry.model);
    const result = await delegate.deleteMany({
      where: { [entry.erasureSubjectField]: userId },
    });
    extensionRowsErased += result.count;
    getLogger().info("deleteUserData: extension-owned rows erased", {
      model: entry.model,
      subjectField: entry.erasureSubjectField,
      count: result.count,
    });
  }

  // 16. Delete the user (cascades to MfaEnrollment, Report (reporter side),
  //     and actor-side InteractionEvent rows)
  await db.user.delete({ where: { id: userId } });

  return {
    commentSentiments: commentSentiments.count,
    postSentiments: postSentiments.count,
    comments: comments.count,
    posts: posts.count,
    entities: entities.count,
    follows: 0, // Follow relationships now handled by graph DB
    directMessages: directMessages.count,
    audienceMembers: audienceMembers.count,
    audiences: audiences.count,
    securityEvents: securityEvents.count,
    crossRegionConsents: crossRegionConsents.count,
    invitations: invitations.count,
    interactionEventsAsTarget: interactionEventsAsTarget.count,
    accountReportsPseudonymized: accountReports.count,
    mediaFilesErased: mediaErasure.erased,
    mediaFilesRetainedShared: mediaErasure.retainedShared,
    mediaStagingKeys: mediaErasure.stagingKeys,
    extensionRowsErased,
  };
}
