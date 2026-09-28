import { createHmac } from "node:crypto";
import { resolveParameter } from "@de-otio/saas-foundation/secrets";
import type { PrismaClient } from "@prisma/client";
import { getExtensionModelRegistry } from "../extension-model-registry.js";
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
 *
 * There is NO session-secret fallback (security deep pass DP-10). The
 * tombstone key must be a dedicated, never-rotated secret: `SESSION_SECRET`
 * is the one value the estate rotates as a kill-switch, and re-keying the
 * tombstone HMAC silently changes every future tombstone for already-deleted
 * users, breaking the per-target counts the tombstone exists to preserve. A
 * deployment without a dedicated key is misconfigured, and the deletion
 * fails closed (below) rather than quietly keying off the wrong secret.
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
    // Foundation resolver (WS-2 §5.3 — the ONE secrets port): SSM
    // SecureString with decryption (the default). How the key is USED is
    // unchanged; only the fetch path moved off powertools. A missing
    // parameter throws (fail-closed), exactly as before.
    const value = (await resolveParameter(ssmParam)).toString("utf-8");
    if (value) return value;
  }
  throw new Error(
    "resolvePseudonymSecret: no erasure-tombstone HMAC key resolvable " +
      "(set REPORT_PSEUDONYM_SECRET or REPORT_PSEUDONYM_SECRET_PARAM) — " +
      "failing closed; there is no SESSION_SECRET fallback and an unkeyed " +
      "tombstone would be reversible",
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
  /** The user's notification inbox rows (FK to User is RESTRICT). */
  notifications: number;
  /** The user's saved notification preferences (FK to User is RESTRICT). */
  notificationPreferences: number;
  /** Connection codes the user created (FK to User is RESTRICT). */
  connectionCodes: number;
  /** Redemptions by the user, and redemptions of the user's own codes. */
  connectionCodeRedemptions: number;
  /** Guardian/child links the user was either party to (both FKs RESTRICT). */
  parentalLinks: number;
  /** What happened to the user's personal tenant: deleted outright, kept with
   *  its names anonymised (something in it belongs to someone else), or none. */
  personalTenant: PersonalTenantOutcome;
  /** Rows that reference the user (or the user's deleted entities) with NO
   *  foreign key, so nothing cascades them — erased across all tenants. */
  unlinkedReferences: {
    relationshipEdges: number;
    proposalsDeattributed: number;
    events: number;
    eventRsvps: number;
    eventShiftSignups: number;
    collections: number;
    collectionItems: number;
    groups: number;
    groupMemberships: number;
  };
}

export type PersonalTenantOutcome = "deleted" | "anonymised" | "none";

/** Display name an anonymised personal tenant is left with. */
export const ERASED_TENANT_DISPLAY_NAME = "Deleted account";

/**
 * Delete or anonymise the erased user's personal tenant (see step 15f).
 * Runs after the user's own content is gone, so any row still counted here
 * belongs to someone else.
 */
async function erasePersonalTenant(
  db: PrismaClient,
  userId: string,
): Promise<PersonalTenantOutcome> {
  const tenant = await db.tenant.findFirst({
    where: { personalOwnerUserId: userId, type: "PERSONAL" },
    select: { id: true },
  });
  if (!tenant) return "none";
  const tenantId = tenant.id;

  const [otherMembers, posts, comments, entities, events, groups] = await Promise.all([
    db.tenantMember.count({ where: { tenantId, userId: { not: userId } } }),
    db.post.count({ where: { tenantId } }),
    db.postComment.count({ where: { tenantId } }),
    db.entity.count({ where: { tenantId } }),
    db.event.count({ where: { tenantId } }),
    db.group.count({ where: { tenantId } }),
  ]);

  if (otherMembers + posts + comments + entities + events + groups === 0) {
    await db.tenant.delete({ where: { id: tenantId } });
    return "deleted";
  }

  // Something in it is someone else's: keep the tenant, drop what identifies
  // the erased user. The directory profile can hold a location and a
  // self-description.
  await db.tenantDirectoryProfile.deleteMany({ where: { tenantId } });
  await db.tenant.update({
    where: { id: tenantId },
    data: { displayName: ERASED_TENANT_DISPLAY_NAME, slug: `deleted-${tenantId}` },
  });
  return "anonymised";
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
  // Type-confusion guard at the sink (worker review W3): every filter below is
  // `{ where: { <fk>: userId } }`, so a non-string here — e.g. `{ not: "" }`
  // from an unvalidated queue payload — is an all-rows predicate. The callers
  // validate; this makes the guarantee independent of call order.
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("deleteUserData: userId must be a non-empty string — refusing erasure");
  }

  // FAIL-CLOSED gate (finding 2): assert the tombstone key BEFORE any
  // deletion, so an unkeyed run can never delete data and then write a
  // reversible `HMAC("", …)` tombstone in step 15c. Re-asserted here (not
  // only at caller startup) because a secret can rotate to empty mid-process.
  const pseudonymSecret = options.pseudonymSecret;
  if (typeof pseudonymSecret !== "string" || pseudonymSecret.trim().length === 0) {
    throw new Error(
      "deleteUserData: empty/absent/whitespace pseudonym tombstone secret — refusing erasure " +
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

  // 7. Entities this user owns ALONE: at least one ownership row, and every
  //    ownership row (any status) is theirs. These — and only these — are
  //    deleted; the previous `deleteMany({ owners: { none: {} } })` had no
  //    scope and deleted every ownerless entity on the platform.
  //
  //    ORDER MATTERS FOR RETRY. Erasure is not one transaction, and a failed
  //    account is simply re-run the next night, so each step must be finishable
  //    from any state an earlier failure left behind. The entity is therefore
  //    deleted BEFORE the user's ownership rows: if the ownerships went first
  //    and anything after them failed, the retry could no longer tell which
  //    entities were this user's, and those pets would survive forever.
  //    Ownerships, taxonomy tags and post_subjects cascade from the entity.
  const soleOwnedIds = (
    await db.entity.findMany({
      where: { owners: { some: { userId }, every: { userId } } },
      select: { id: true },
    })
  ).map((e) => e.id);
  let entities = { count: 0 };
  let entityEdges = 0;
  if (soleOwnedIds.length > 0) {
    // Rows keyed by these entities with NO foreign key — nothing cascades
    // them. Removed while the ids are still discoverable (i.e. before the
    // entities go), for the same retry reason as above.
    const { count: toEntityEdges } = await db.relationship.deleteMany({
      where: { targetType: "entity", targetId: { in: soleOwnedIds } },
    });
    const { count: entityToEntityEdges } = await db.entityRelationship.deleteMany({
      where: {
        OR: [{ entityId: { in: soleOwnedIds } }, { relatedEntityId: { in: soleOwnedIds } }],
      },
    });
    await db.collectionItem.deleteMany({
      where: { targetType: "entity", targetId: { in: soleOwnedIds } },
    });
    // The pet's location (PostGIS, keyed by entity id) — often the owner's home.
    await db.entityLocation.deleteMany({ where: { entityId: { in: soleOwnedIds } } });
    entityEdges = toEntityEdges + entityToEntityEdges;
    entities = await db.entity.deleteMany({
      where: { id: { in: soleOwnedIds }, owners: { every: { userId } } },
    });
  }

  // 8. The user's remaining ownerships are of entities someone else also
  //    owns: those entities stay (tags included), only the user's row goes.
  await db.entityOwnership.deleteMany({
    where: { userId: userId },
  });

  // 9. References to the user with NO foreign key. Nothing cascades them off
  //    the users row, so each is found by user id — across ALL tenants: a
  //    user's edges, RSVPs and memberships live in other people's tenants.
  //    (SyncOps.removeUser refuses to run without an ambient tenant because an
  //    unscoped delete on a polymorphic target is dangerous as a FALLBACK;
  //    erasure is the explicit, separately-authorised operation its comment
  //    asks for, and every predicate here is pinned to this one user id —
  //    guarded non-empty at the top of this function.)
  const subject = await db.user.findUnique({
    where: { id: userId },
    select: { actorUri: true },
  });
  // Relationship edges from the user, and pointing at the user.
  const { count: userEdges } = await db.relationship.deleteMany({
    where: { OR: [{ userId }, { targetType: "user", targetId: userId }] },
  });
  // Entity↔entity edges the user proposed between entities that survive:
  // the edge is the two owners' shared record, so it stays and only the
  // attribution goes — replaced by the same keyed tombstone ACCOUNT reports
  // get (15c), which keeps the column NOT NULL and the extension DTO
  // (`proposedByUserId: string`) unchanged, and never matches a real user.
  const { count: proposalsDeattributed } = await db.entityRelationship.updateMany({
    where: { proposedByUserId: userId },
    data: { proposedByUserId: pseudonymizeUserId(userId, pseudonymSecret) },
  });
  // Events the user created (RSVPs, shifts and signups cascade), and the
  // user's RSVPs / shift signups on anyone else's events.
  const { count: events } = await db.event.deleteMany({ where: { creatorId: userId } });
  const { count: eventRsvps } = await db.rsvp.deleteMany({ where: { userId } });
  const { count: eventShiftSignups } = await db.shiftSignup.deleteMany({ where: { userId } });
  // The user's own lists (items cascade), and items in other people's lists
  // that point at the user.
  const { count: collections } = await db.collection.deleteMany({
    where: { ownerUserId: userId },
  });
  const { count: collectionItems } = await db.collectionItem.deleteMany({
    where: { targetType: "user", targetId: userId },
  });
  // Group membership is keyed by actor URI. Groups whose only member is the
  // user go first (retry-safe, as with entities), then the user's other
  // memberships.
  let groups = 0;
  let groupMemberships = 0;
  if (subject?.actorUri) {
    const actorUri = subject.actorUri;
    ({ count: groups } = await db.group.deleteMany({
      where: { members: { some: { actorUri }, every: { actorUri } } },
    }));
    ({ count: groupMemberships } = await db.groupMember.deleteMany({ where: { actorUri } }));
  }

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
  for (const entry of getExtensionModelRegistry()) {
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

  // 15e. Rows whose foreign key to User is ON DELETE RESTRICT and that no step
  //      above removes. Any one of them left behind makes the final
  //      user.delete() fail — AFTER every step above has run, since there is
  //      no transaction — so the account is left half-erased, stays due, and
  //      fails again on every nightly run while its identity is never
  //      deleted. The notification inbox alone is enough: nearly every active
  //      account has one row in it.
  const notifications = await db.notification.deleteMany({ where: { userId } });
  const notificationPreferences = await db.notificationPreference.deleteMany({
    where: { userId },
  });
  // Codes the user created, and every redemption row pointing at them (the
  // redemption → code FK is RESTRICT too), plus the user's own redemptions of
  // other people's codes. The relationship a redemption created lives in the
  // graph edge tables, not here.
  const ownCodeIds = (
    await db.connectionCode.findMany({
      where: { creatorId: userId },
      select: { id: true },
    })
  ).map((c) => c.id);
  const connectionCodeRedemptions = await db.connectionCodeRedemption.deleteMany({
    where:
      ownCodeIds.length > 0
        ? { OR: [{ userId }, { codeId: { in: ownCodeIds } }] }
        : { userId },
  });
  const connectionCodes = await db.connectionCode.deleteMany({
    where: { creatorId: userId },
  });
  // Guardian↔child links in either direction. A link is a relation between
  // two accounts; with one of them erased it describes nobody, so it goes
  // (both FKs are RESTRICT). The surviving account keeps its own age tier —
  // this removes the pairing, not any age-based restriction.
  const parentalLinks = await db.parentalLink.deleteMany({
    where: { OR: [{ childId: userId }, { guardianId: userId }] },
  });
  // entity_ownerships.added_by_user_id and tenant_invitations.invited_by_user_id
  // are ON DELETE SET NULL (migration 20260928120000): those rows belong to
  // another owner / to the tenant, so the database nulls the reference rather
  // than this service deleting someone else's data.

  // 15f. The user's PERSONAL tenant. Its FK to the user is SET NULL, so it
  //      used to survive erasure under its original name — the user's handle
  //      (displayName) and `personal-<userId>` (slug). Delete it when nothing
  //      in it belongs to anyone else; otherwise keep it (a tenant delete
  //      CASCADES to every tenant-scoped row, e.g. a dog the user co-owned
  //      with a friend lives in this tenant) and strip the identifying names.
  //      MediaFile rows carry no FK to tenants, so soft-deleted media stays in
  //      the GC purge either way.
  const personalTenantOutcome = await erasePersonalTenant(db, userId);

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
    notifications: notifications.count,
    notificationPreferences: notificationPreferences.count,
    connectionCodes: connectionCodes.count,
    connectionCodeRedemptions: connectionCodeRedemptions.count,
    parentalLinks: parentalLinks.count,
    personalTenant: personalTenantOutcome,
    unlinkedReferences: {
      relationshipEdges: userEdges + entityEdges,
      proposalsDeattributed,
      events,
      eventRsvps,
      eventShiftSignups,
      collections,
      collectionItems,
      groups,
      groupMemberships,
    },
  };
}
