/**
 * Integration: account deletion — grace period → nightly purge (GDPR Art. 17).
 *
 * Request, confirm and cancel were covered; the step that actually erases an
 * account was not. The nightly-cron unit suites mock `user.findMany` and
 * return canned rows whatever the `where` says, and mock `deleteUserData`
 * wholesale — so neither the due-account predicate nor the erasure against a
 * real schema (foreign keys included) was ever executed. This suite runs both
 * for real:
 *
 *   - the REAL `UserDeletionHandlerEnhanced` puts each account into its state
 *     (request → confirm → optional cancel), so a cancel that left a stale
 *     `deletionScheduledAt`/`deletionConfirmedAt` behind would be caught here;
 *   - the REAL `runNightlyCron` (the worker core the scheduled "nightly" job
 *     runs) with a REAL PrismaClient and a frozen, injected clock;
 *   - the REAL `deleteUserData` against the migrated schema.
 *
 * Only the out-of-process ports are fakes, and they record what they were
 * asked to do: the identity-provider admin port, object storage, the
 * completion-email port and the cron-lock KV.
 *
 * ISOLATION: `runNightlyCron` is platform-wide by design — it purges every
 * due account, every aged soft-deleted media row and every expired invitation
 * in the database it is given. It therefore runs against a DEDICATED
 * throwaway database created (and migrated) here, never the lane's shared one
 * and never a developer's `trellis_dev`.
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sharedDatabaseConnectionManager } from "../../src/lib/database-connection-manager.js";
import { UserDeletionHandlerEnhanced } from "../../src/lib/user-deletion-handler-enhanced.js";
import { makeKvCronLock } from "../../src/lib/workers/cron-lock.js";
import { CapturingMetrics } from "../../src/lib/workers/metrics-port.js";
import { runNightlyCron } from "../../src/lib/workers/nightly-cron.js";
import type { Logger } from "../../src/lib/logger.js";
import type { KVNamespace } from "../../src/types/cloudflare-compat.js";

// Hyperdrive guard: the default unit config's test/setup.ts forces a fake
// hyperdrive URL; fall back to the docker-compose credentials in that case.
const ENV_DB_URL = process.env.DATABASE_URL;
const ADMIN_DB_URL =
  ENV_DB_URL !== undefined && !ENV_DB_URL.includes("hyperdrive")
    ? ENV_DB_URL
    : "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";
const TEST_DB_NAME = "trellis_deletion_grace_purge_it";
const TEST_DB_URL = ADMIN_DB_URL.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB_NAME}$1`);

const DAY = 24 * 60 * 60 * 1000;
const GRACE_DAYS = 7;
const PSEUDONYM_SECRET = "deletion-grace-purge-it-pseudonym-secret";

let db: PrismaClient;
let seq = 0;

/** Minimal in-memory stand-in for the deletion-confirmation KV binding. */
function makeKv(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

const kv = makeKv();
const handlerEnv = () => ({ DATABASE_URL: TEST_DB_URL, DELETE_JOBS_KV: kv });
const handler = new UserDeletionHandlerEnhanced();

function session(userId: string) {
  return { userId } as never;
}

function silentLogger(): Logger & { errors: unknown[][] } {
  const errors: unknown[][] = [];
  return {
    errors,
    error: (...a: unknown[]) => {
      errors.push(a);
    },
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
  } as unknown as Logger & { errors: unknown[][] };
}

/** cuid-shaped id accepted by the cas-keys allowlist (`c` + 24 [a-z0-9]). */
function cuidLike(n: number): string {
  return `c${n.toString(36).padStart(24, "0")}`;
}

interface Account {
  id: string;
  email: string;
  tenantId: string;
  postId: string;
  commentId: string;
  mediaId: string;
  soleEntityId: string;
  sharedEntityId: string;
  /** The friend's co-ownership of the shared dog — added BY this user. */
  friendOwnershipId: string;
  /** An invitation to the friend's tenant that this user sent. */
  sentInvitationId: string;
  handle: string;
  actorUri: string;
  /** References WITHOUT a foreign key, seeded across both tenants. */
  noFk: {
    friendDogId: string;
    survivingEdgeId: string;
    friendEventId: string;
    friendCollectionId: string;
    friendGroupId: string;
    ownGroupId: string;
  };
  /** Whether the personal tenant still holds someone else's data after erasure. */
  tenantHoldsOthersData: boolean;
  stagingKeys: string[];
}

interface Bystander {
  id: string;
  email: string;
  tenantId: string;
  postId: string;
  ownerlessEntityId: string;
}

async function createUser(label: string) {
  const n = ++seq;
  return db.user.create({
    data: { email: `${label}-${n}@deletion-it.example.com`, handle: `${label}-${n}` },
  });
}

async function createTenant(label: string) {
  const n = ++seq;
  return db.tenant.create({
    data: { slug: `${label}-${n}`, displayName: `${label} ${n}`, type: "PERSONAL" },
  });
}

/**
 * Another user whose data must survive every purge: their own post, and an
 * entity with NO owners at all in a different tenant.
 */
async function seedBystander(): Promise<Bystander> {
  const user = await createUser("bystander");
  const tenant = await createTenant("bystander");
  const post = await db.post.create({
    data: { tenantId: tenant.id, authorId: user.id, text: "bystander post" },
  });
  const ownerless = await db.entity.create({
    data: { tenantId: tenant.id, name: `ownerless entity ${seq}` },
  });
  return {
    id: user.id,
    email: user.email,
    tenantId: tenant.id,
    postId: post.id,
    ownerlessEntityId: ownerless.id,
  };
}

/**
 * An account with the everyday footprint of an alpha user: a post with an
 * uploaded image, a comment on someone else's post, a DM, a notification and
 * saved notification preferences, a connection code a friend redeemed, a dog
 * profile they own alone and one they co-own with a friend.
 */
async function seedAccount(
  label: string,
  friend: Bystander,
  opts: { sharedDogInOwnTenant?: boolean } = {},
): Promise<Account> {
  const sharedDogInOwnTenant = opts.sharedDogInOwnTenant ?? true;
  const user = await createUser(label);
  const tenant = await createTenant(label);
  // Make it the user's PERSONAL tenant, the way provisioning does: named after
  // the handle, owned by and linked to the user, with the user as OWNER.
  await db.tenant.update({
    where: { id: tenant.id },
    data: { displayName: user.handle, personalOwnerUserId: user.id },
  });
  await db.user.update({ where: { id: user.id }, data: { personalTenantId: tenant.id } });
  await db.tenantMember.create({
    data: { tenantId: tenant.id, userId: user.id, role: "OWNER" },
  });
  const n = ++seq;

  const contentHash = n.toString(16).padStart(64, "a");
  const uploadId = cuidLike(n);
  const media = await db.mediaFile.create({
    data: {
      tenantId: tenant.id,
      contentHash,
      mimeType: "image/jpeg",
      size: 1024,
      uploadId,
      originalKey: `cas/${tenant.id}/${contentHash}`,
      lifecycle: "APPROVED",
      uploadedBy: user.id,
    },
  });
  const post = await db.post.create({
    data: { tenantId: tenant.id, authorId: user.id, text: `${label} post` },
  });
  await db.postMedia.create({
    data: { tenantId: tenant.id, postId: post.id, mediaId: media.id },
  });
  const comment = await db.postComment.create({
    data: {
      tenantId: friend.tenantId,
      postId: friend.postId,
      authorId: user.id,
      text: `${label} comment on a friend's post`,
    },
  });
  await db.directMessage.create({
    data: { senderId: user.id, recipientId: friend.id, text: `${label} dm` },
  });
  await db.notification.create({
    data: {
      tenantId: tenant.id,
      userId: user.id,
      type: "SYSTEM",
      title: "Welcome",
      body: "Welcome to the alpha",
    },
  });
  await db.notificationPreference.create({
    data: { userId: user.id, digestEnabled: false },
  });
  const code = await db.connectionCode.create({
    data: {
      tenantId: tenant.id,
      code: `code-${label}-${n}`,
      creatorId: user.id,
      expiresAt: new Date(Date.now() + 30 * DAY),
      maxUses: 5,
      useCount: 1,
    },
  });
  await db.connectionCodeRedemption.create({
    data: { codeId: code.id, userId: friend.id, tenantId: tenant.id },
  });

  const soleEntity = await db.entity.create({
    data: { tenantId: tenant.id, name: `${label} sole dog` },
  });
  await db.entityOwnership.create({
    data: {
      tenantId: tenant.id,
      entityId: soleEntity.id,
      userId: user.id,
      role: "PRIMARY_OWNER",
      addedByUserId: user.id,
    },
  });
  // The dog co-owned with the friend. By default it lives in the user's own
  // tenant, so that tenant still holds someone else's data after erasure.
  const sharedTenantId = sharedDogInOwnTenant ? tenant.id : friend.tenantId;
  const sharedEntity = await db.entity.create({
    data: { tenantId: sharedTenantId, name: `${label} shared dog` },
  });
  await db.entityOwnership.create({
    data: {
      tenantId: sharedTenantId,
      entityId: sharedEntity.id,
      userId: user.id,
      role: "PRIMARY_OWNER",
      addedByUserId: user.id,
    },
  });
  await db.entityOwnership.create({
    data: {
      tenantId: sharedTenantId,
      entityId: sharedEntity.id,
      userId: friend.id,
      role: "CO_OWNER",
      // The user added the friend as co-owner: the row is the FRIEND's, and
      // it references the user being erased (added_by_user_id).
      addedByUserId: user.id,
    },
  });
  const friendOwnership = await db.entityOwnership.findUniqueOrThrow({
    where: { entityId_userId: { entityId: sharedEntity.id, userId: friend.id } },
  });
  // An invitation the user sent to the friend's tenant (invited_by_user_id).
  const invitation = await db.tenantInvitation.create({
    data: {
      tenantId: friend.tenantId,
      email: `invitee-${n}@deletion-it.example.com`,
      role: "MEMBER",
      token: `invite-token-${label}-${n}`,
      expiresAt: new Date(Date.now() + 30 * DAY),
      invitedByUserId: user.id,
    },
  });
  // A guardian link: the user is the friend's guardian (both FKs RESTRICT).
  await db.parentalLink.create({
    data: { childId: friend.id, guardianId: user.id, status: "ACTIVE" },
  });

  // ── References with NO foreign key: nothing cascades them, so erasure must
  //    find them by user id — in the friend's tenant as much as the user's.
  const actorUri = `https://deletion-it.example.com/users/${user.handle}`;
  await db.user.update({ where: { id: user.id }, data: { actorUri } });
  // Relationship edges: the user's own, one pointing AT the user, and one
  // pointing at the user's solely-owned dog.
  await db.relationship.create({
    data: { tenantId: friend.tenantId, userId: user.id, targetType: "user", targetId: friend.id, connectionMethod: "code" },
  });
  await db.relationship.create({
    data: { tenantId: friend.tenantId, userId: friend.id, targetType: "user", targetId: user.id, connectionMethod: "code" },
  });
  await db.relationship.create({
    data: { tenantId: friend.tenantId, userId: friend.id, targetType: "entity", targetId: soleEntity.id, connectionMethod: "discovery" },
  });
  // Entity↔entity edges: one touching the sole dog (goes with it), one the
  // user PROPOSED between the shared dog and the friend's dog (stays,
  // de-attributed).
  const friendDog = await db.entity.create({
    data: { tenantId: friend.tenantId, name: `${label} friend's dog` },
  });
  await db.entityOwnership.create({
    data: { tenantId: friend.tenantId, entityId: friendDog.id, userId: friend.id, role: "PRIMARY_OWNER", addedByUserId: friend.id },
  });
  await db.entityRelationship.create({
    data: { tenantId: tenant.id, entityId: soleEntity.id, relatedEntityId: friendDog.id, type: "PACK_MATE", proposedByUserId: user.id },
  });
  const survivingEdge = await db.entityRelationship.create({
    data: { tenantId: sharedTenantId, entityId: sharedEntity.id, relatedEntityId: friendDog.id, type: "SIBLING", proposedByUserId: user.id },
  });
  // The sole dog's (home) location — a PostGIS row keyed by entity, no FK.
  await db.$executeRaw`INSERT INTO entity_location (entity_id, tenant_id, location, lat, lng)
    VALUES (${soleEntity.id}, ${tenant.id}, ST_SetSRID(ST_MakePoint(13.4, 52.5), 4326)::geography, 52.5, 13.4)`;
  // Events: one the user created; an RSVP and a shift signup on the friend's.
  await db.event.create({
    data: { tenantId: tenant.id, creatorId: user.id, title: `${label} walk`, startsAt: new Date(Date.now() + 7 * DAY) },
  });
  const friendEvent = await db.event.create({
    data: { tenantId: friend.tenantId, creatorId: friend.id, title: `friend walk ${n}`, startsAt: new Date(Date.now() + 7 * DAY) },
  });
  await db.rsvp.create({
    data: { tenantId: friend.tenantId, eventId: friendEvent.id, userId: user.id, status: "GOING" },
  });
  const shift = await db.eventShift.create({
    data: { tenantId: friend.tenantId, eventId: friendEvent.id, title: "setup", capacity: 3 },
  });
  await db.shiftSignup.create({
    data: { tenantId: friend.tenantId, shiftId: shift.id, userId: user.id, status: "CONFIRMED" },
  });
  // Collections: the user's own list, and the friend's list featuring the user
  // and the user's sole dog.
  await db.collection.create({
    data: {
      tenantId: tenant.id,
      ownerUserId: user.id,
      title: `${label} favourites`,
      items: { create: [{ targetType: "entity", targetId: friendDog.id, position: 0 }] },
    },
  });
  const friendCollection = await db.collection.create({
    data: {
      tenantId: friend.tenantId,
      ownerUserId: friend.id,
      title: `friend list ${n}`,
      items: {
        create: [
          { targetType: "user", targetId: user.id, position: 0 },
          { targetType: "entity", targetId: soleEntity.id, position: 1 },
          { targetType: "entity", targetId: friendDog.id, position: 2 },
        ],
      },
    },
  });
  // Groups (membership is keyed by actor URI): a group only the user is in,
  // and the friend's group the user joined.
  const group = (t: string, name: string) => ({
    tenantId: t,
    name,
    actorUri: `https://deletion-it.example.com/groups/${name}`,
    inboxUrl: "https://deletion-it.example.com/inbox",
    outboxUrl: "https://deletion-it.example.com/outbox",
    followersUrl: "https://deletion-it.example.com/followers",
    publicKey: "test-public-key",
    privateKey: "test-private-key",
    privacy: "PRIVATE" as const,
  });
  const ownGroup = await db.group.create({ data: group(tenant.id, `own-${label}-${n}`) });
  await db.groupMember.create({
    data: { tenantId: tenant.id, groupId: ownGroup.id, actorUri, role: "ADMIN" },
  });
  const friendGroup = await db.group.create({ data: group(friend.tenantId, `friend-${label}-${n}`) });
  await db.groupMember.create({
    data: { tenantId: friend.tenantId, groupId: friendGroup.id, actorUri: `https://deletion-it.example.com/users/friend-${n}`, role: "ADMIN" },
  });
  await db.groupMember.create({
    data: { tenantId: friend.tenantId, groupId: friendGroup.id, actorUri, role: "MEMBER" },
  });

  return {
    id: user.id,
    email: user.email,
    tenantId: tenant.id,
    postId: post.id,
    commentId: comment.id,
    mediaId: media.id,
    soleEntityId: soleEntity.id,
    sharedEntityId: sharedEntity.id,
    friendOwnershipId: friendOwnership.id,
    handle: user.handle,
    actorUri,
    noFk: {
      friendDogId: friendDog.id,
      survivingEdgeId: survivingEdge.id,
      friendEventId: friendEvent.id,
      friendCollectionId: friendCollection.id,
      friendGroupId: friendGroup.id,
      ownGroupId: ownGroup.id,
    },
    tenantHoldsOthersData: sharedDogInOwnTenant,
    sentInvitationId: invitation.id,
    stagingKeys: [
      `pending/${tenant.id}/${uploadId}`,
      `processing/${tenant.id}/${contentHash}`,
    ],
  };
}

/** Request (and by default confirm) deletion through the real handler. */
async function requestDeletion(
  userId: string,
  opts: { confirm?: boolean } = {},
): Promise<{ requestedAt: Date; scheduledAt: Date }> {
  await handler.requestDeletion(session(userId), handlerEnv() as never);
  if (opts.confirm ?? true) {
    const stored = kv.store.get(`deletion-confirm:${userId}`);
    expect(stored, "confirmation code must have been stored").toBeDefined();
    const { code } = JSON.parse(stored!) as { code: string };
    await handler.confirmDeletion(userId, code, handlerEnv() as never);
  }
  const row = await db.user.findUniqueOrThrow({ where: { id: userId } });
  return { requestedAt: row.deletionRequestedAt!, scheduledAt: row.deletionScheduledAt! };
}

interface PurgeRun {
  identityDeletes: string[];
  stagingDeletes: string[][];
  emails: string[];
  metrics: CapturingMetrics;
  logger: Logger & { errors: unknown[][] };
}

/**
 * One nightly fire at the frozen instant `nowMs`. `wrapDb` lets a test inject
 * a fault into the real client.
 */
async function runPurge(
  nowMs: number,
  wrapDb: (real: PrismaClient) => PrismaClient = (real) => real,
  /** Emails whose identity-provider delete fails in THIS run. */
  identityFailsFor: readonly string[] = [],
): Promise<PurgeRun> {
  const run: PurgeRun = {
    identityDeletes: [],
    stagingDeletes: [],
    emails: [],
    metrics: new CapturingMetrics(),
    logger: silentLogger(),
  };
  const result = await runNightlyCron({
    getDb: async () => wrapDb(db),
    logger: run.logger,
    metrics: run.metrics,
    cronLock: makeKvCronLock(new MemoryKvStore()),
    clock: () => nowMs,
    resolvePseudonymSecret: async () => PSEUDONYM_SECRET,
    deleteStagingObjects: async (keys: readonly string[]) => {
      run.stagingDeletes.push([...keys]);
      return { requested: keys.length, failedBatches: 0, truncated: false };
    },
    objectStore: { deleteObjects: async () => {} },
    identity: {
      deleteUser: async ({ email }: { email: string }) => {
        if (identityFailsFor.includes(email)) {
          throw new Error("identity provider unavailable (injected)");
        }
        run.identityDeletes.push(email);
      },
    },
    email: {
      sendAccountDeleted: async ({ to }: { to: string }) => {
        run.emails.push(to);
      },
    },
    // Steps 5/6 (age tiers, sentiment digest) are out of scope and fail open.
    getAppEnv: async () => {
      throw new Error("app env not available in this suite");
    },
  } as never);
  expect(result.acquired).toBe(true);
  return run;
}

function deletionCounts(run: PurgeRun): Record<string, number> {
  const out: Record<string, number> = {};
  for (const blob of run.metrics.emitted) {
    for (const m of blob.metrics) out[m.name] = m.value;
  }
  return out;
}

async function expectAccountIntact(a: Account): Promise<void> {
  const user = await db.user.findUnique({ where: { id: a.id } });
  expect(user, `${a.email} must still exist`).not.toBeNull();
  const personal = await db.tenant.findUniqueOrThrow({ where: { id: a.tenantId } });
  expect(personal.displayName).toBe(a.handle);
  expect(await db.post.findUnique({ where: { id: a.postId } })).not.toBeNull();
  expect(await db.postComment.findUnique({ where: { id: a.commentId } })).not.toBeNull();
  expect(await db.notification.count({ where: { userId: a.id } })).toBe(1);
  expect(await db.entity.findUnique({ where: { id: a.soleEntityId } })).not.toBeNull();
  const media = await db.mediaFile.findUniqueOrThrow({ where: { id: a.mediaId } });
  expect(media.deletedAt).toBeNull();
  expect(media.uploadedBy).toBe(a.id);
}

async function expectAccountErased(a: Account): Promise<void> {
  expect(await db.user.findUnique({ where: { id: a.id } })).toBeNull();
  expect(await db.post.findUnique({ where: { id: a.postId } })).toBeNull();
  expect(await db.postComment.findUnique({ where: { id: a.commentId } })).toBeNull();
  expect(
    await db.directMessage.count({
      where: { OR: [{ senderId: a.id }, { recipientId: a.id }] },
    }),
  ).toBe(0);
  expect(await db.notification.count({ where: { userId: a.id } })).toBe(0);
  expect(await db.notificationPreference.count({ where: { userId: a.id } })).toBe(0);
  expect(await db.connectionCode.count({ where: { creatorId: a.id } })).toBe(0);
  expect(await db.entityOwnership.count({ where: { userId: a.id } })).toBe(0);
  // Solely-owned entity goes; the co-owned one stays with its other owner.
  expect(await db.entity.findUnique({ where: { id: a.soleEntityId } })).toBeNull();
  expect(await db.entity.findUnique({ where: { id: a.sharedEntityId } })).not.toBeNull();
  // Someone else's rows that merely POINT at the user survive, de-referenced:
  // the friend keeps their co-ownership, the tenant keeps its invitation.
  const friendOwnership = await db.entityOwnership.findUnique({
    where: { id: a.friendOwnershipId },
  });
  expect(friendOwnership, "the co-owner's ownership must survive").not.toBeNull();
  expect(friendOwnership!.addedByUserId).toBeNull();
  const invitation = await db.tenantInvitation.findUnique({ where: { id: a.sentInvitationId } });
  expect(invitation, "the tenant's invitation must survive").not.toBeNull();
  expect(invitation!.invitedByUserId).toBeNull();
  // References with no FK, across every tenant.
  expect(
    await db.relationship.count({
      where: { OR: [{ userId: a.id }, { targetType: "user", targetId: a.id }] },
    }),
    "relationship edges from or to the user",
  ).toBe(0);
  expect(
    await db.relationship.count({ where: { targetType: "entity", targetId: a.soleEntityId } }),
    "relationship edges to the user's deleted dog",
  ).toBe(0);
  expect(
    await db.entityRelationship.count({
      where: { OR: [{ entityId: a.soleEntityId }, { relatedEntityId: a.soleEntityId }] },
    }),
    "entity edges touching the deleted dog",
  ).toBe(0);
  expect(await db.entityRelationship.count({ where: { proposedByUserId: a.id } })).toBe(0);
  const edge = await db.entityRelationship.findUnique({ where: { id: a.noFk.survivingEdgeId } });
  expect(edge, "an edge between two surviving dogs stays").not.toBeNull();
  expect(edge!.proposedByUserId).toMatch(/^deleted:[0-9a-f]{32}$/);
  const loc = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM entity_location WHERE entity_id = ${a.soleEntityId}`;
  expect(Number(loc[0].n), "the deleted dog's location").toBe(0);
  expect(await db.event.count({ where: { creatorId: a.id } })).toBe(0);
  expect(await db.rsvp.count({ where: { userId: a.id } })).toBe(0);
  expect(await db.shiftSignup.count({ where: { userId: a.id } })).toBe(0);
  expect(await db.event.findUnique({ where: { id: a.noFk.friendEventId } })).not.toBeNull();
  expect(await db.collection.count({ where: { ownerUserId: a.id } })).toBe(0);
  expect(
    await db.collectionItem.count({
      where: {
        OR: [
          { targetType: "user", targetId: a.id },
          { targetType: "entity", targetId: a.soleEntityId },
        ],
      },
    }),
    "other people's list items pointing at the user or their deleted dog",
  ).toBe(0);
  expect(
    await db.collectionItem.count({ where: { collectionId: a.noFk.friendCollectionId } }),
    "the friend's list keeps its other items",
  ).toBe(1);
  expect(await db.groupMember.count({ where: { actorUri: a.actorUri } })).toBe(0);
  expect(await db.group.findUnique({ where: { id: a.noFk.ownGroupId } }), "a group left with no members").toBeNull();
  expect(await db.group.findUnique({ where: { id: a.noFk.friendGroupId } })).not.toBeNull();
  expect(await db.entity.findUnique({ where: { id: a.noFk.friendDogId } })).not.toBeNull();

  // The personal tenant no longer carries the user's name: deleted outright,
  // or — when someone else's data still lives in it — kept and anonymised.
  const personal = await db.tenant.findUnique({ where: { id: a.tenantId } });
  if (a.tenantHoldsOthersData) {
    expect(personal, "a tenant holding a co-owner's dog must be kept").not.toBeNull();
    expect(personal!.displayName).toBe("Deleted account");
    expect(personal!.slug).toBe(`deleted-${a.tenantId}`);
    expect(personal!.personalOwnerUserId).toBeNull();
  } else {
    expect(personal, "a personal tenant with nothing of anyone else's must go").toBeNull();
  }
  expect(await db.tenant.count({ where: { displayName: a.handle } })).toBe(0);
  // A pairing with an erased account describes nobody.
  expect(
    await db.parentalLink.count({ where: { OR: [{ childId: a.id }, { guardianId: a.id }] } }),
  ).toBe(0);
  // Media handed to the GC purge: soft-deleted with the personal link
  // scrubbed — or already hard-deleted by a later run's step-1 GC purge.
  const media = await db.mediaFile.findUnique({ where: { id: a.mediaId } });
  if (media !== null) {
    expect(media.deletedAt).not.toBeNull();
    expect(media.uploadedBy).toBeNull();
  }
}

async function expectBystanderIntact(b: Bystander): Promise<void> {
  expect(await db.user.findUnique({ where: { id: b.id } })).not.toBeNull();
  expect(await db.post.findUnique({ where: { id: b.postId } })).not.toBeNull();
  expect(
    await db.entity.findUnique({ where: { id: b.ownerlessEntityId } }),
    "an unrelated ownerless entity must survive another user's erasure",
  ).not.toBeNull();
}

beforeAll(async () => {
  const { Client } = await import("pg");
  const admin = new Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  await admin.end();

  // The real migrations (not `db push`): the FK actions under test —
  // ON DELETE RESTRICT vs CASCADE — are what the migrations say they are.
  execSync("npx prisma migrate deploy", {
    cwd: path.resolve(__dirname, "../.."),
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: TEST_DB_URL, DIRECT_DATABASE_URL: TEST_DB_URL },
  });

  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_DB_URL }) });
  await db.$connect();
}, 180_000);

afterAll(async () => {
  try {
    await sharedDatabaseConnectionManager.shutdown();
  } catch {
    /* best-effort */
  }
  try {
    await db?.$disconnect();
    const { Client } = await import("pg");
    const admin = new Client({ connectionString: ADMIN_DB_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
    await admin.end();
  } catch {
    /* best-effort */
  }
}, 60_000);

describe("account deletion — grace period and nightly purge (real DB)", () => {
  it(`a request schedules the purge exactly ${GRACE_DAYS} days out and suspends the account`, async () => {
    const friend = await seedBystander();
    const a = await seedAccount("grace-len", friend);
    const { requestedAt, scheduledAt } = await requestDeletion(a.id);

    // The grace period users are told about is this number. Change it and the
    // user-facing copy (and any privacy text) must change with it.
    expect(scheduledAt.getTime() - requestedAt.getTime()).toBe(GRACE_DAYS * DAY);
    const row = await db.user.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.suspended).toBe(true);
    expect(row.deletionConfirmedAt).not.toBeNull();
  });

  it("does NOT purge a confirmed account still inside its grace period", async () => {
    const friend = await seedBystander();
    const a = await seedAccount("in-grace", friend);
    const { requestedAt } = await requestDeletion(a.id);

    const run = await runPurge(requestedAt.getTime() + (GRACE_DAYS - 1) * DAY);

    await expectAccountIntact(a);
    expect(run.identityDeletes).not.toContain(a.email);
    expect(run.emails).not.toContain(a.email);
    expect(await db.deletionAuditLog.count({ where: { userId: a.id } })).toBe(0);
  });

  it("boundary: not purged 1 ms before the scheduled instant, purged AT it", async () => {
    const friend = await seedBystander();
    const a = await seedAccount("boundary", friend);
    const { scheduledAt } = await requestDeletion(a.id);

    const before = await runPurge(scheduledAt.getTime() - 1);
    await expectAccountIntact(a);
    expect(before.identityDeletes).not.toContain(a.email);

    // Cancel refuses from this instant on (`now >= scheduledAt`), so the purge
    // must take it from this instant on too — no instant where neither applies.
    const at = await runPurge(scheduledAt.getTime());
    await expectAccountErased(a);
    expect(at.identityDeletes).toContain(a.email);
    await expectBystanderIntact(friend);
  });

  it("purges an account whose grace period has expired: data, identity, staging bytes, audit, email", async () => {
    const friend = await seedBystander();
    const a = await seedAccount("expired", friend);
    const { requestedAt, scheduledAt } = await requestDeletion(a.id);

    const run = await runPurge(scheduledAt.getTime() + 3 * DAY);

    await expectAccountErased(a);
    // First run: the upload is soft-deleted into the GC window, not skipped.
    const media = await db.mediaFile.findUniqueOrThrow({ where: { id: a.mediaId } });
    expect(media.deletedAt).not.toBeNull();
    expect(media.uploadedBy).toBeNull();
    await expectBystanderIntact(friend);
    // The friend's co-ownership of the shared dog is untouched.
    expect(
      await db.entityOwnership.count({ where: { entityId: a.sharedEntityId, userId: friend.id } }),
    ).toBe(1);

    // External identity deleted exactly once, by the account's email.
    expect(run.identityDeletes.filter((e) => e === a.email)).toHaveLength(1);
    // The user-scoped staging objects of the erased upload were handed to storage.
    expect(run.stagingDeletes.flat()).toEqual(expect.arrayContaining(a.stagingKeys));
    expect(run.emails).toContain(a.email);

    const audit = await db.deletionAuditLog.findMany({ where: { userId: a.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0].email).toBe(a.email);
    expect(audit[0].requestedAt.getTime()).toBe(requestedAt.getTime());
    expect(audit[0].itemsDeleted).toMatchObject({ posts: 1, comments: 1, mediaFilesErased: 1 });
    expect(deletionCounts(run).FailedCount).toBe(0);
  });

  it("deletes the personal tenant outright when nothing in it belongs to anyone else", async () => {
    const friend = await seedBystander();
    const a = await seedAccount("solo-tenant", friend, { sharedDogInOwnTenant: false });
    const { scheduledAt } = await requestDeletion(a.id);

    await runPurge(scheduledAt.getTime() + DAY);

    await expectAccountErased(a);
    expect(await db.tenant.findUnique({ where: { id: a.tenantId } })).toBeNull();
    // The co-owned dog now lives in the friend's tenant and survives there.
    expect(await db.entity.findUnique({ where: { id: a.sharedEntityId } })).not.toBeNull();
    await expectBystanderIntact(friend);
  });

  it("does NOT purge a cancelled request, even long after its original scheduled instant", async () => {
    const friend = await seedBystander();
    const a = await seedAccount("cancelled", friend);
    const { scheduledAt } = await requestDeletion(a.id);
    await handler.cancelDeletion(session(a.id), handlerEnv() as never);

    const row = await db.user.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.suspended).toBe(false);

    const run = await runPurge(scheduledAt.getTime() + 30 * DAY);

    await expectAccountIntact(a);
    expect(run.identityDeletes).not.toContain(a.email);
    expect(run.emails).not.toContain(a.email);
  });

  it("does NOT purge a request that was never confirmed", async () => {
    const friend = await seedBystander();
    const a = await seedAccount("unconfirmed", friend);
    const { scheduledAt } = await requestDeletion(a.id, { confirm: false });

    const run = await runPurge(scheduledAt.getTime() + 30 * DAY);

    await expectAccountIntact(a);
    expect(run.identityDeletes).not.toContain(a.email);
  });

  it("is idempotent: a rerun after a purge deletes nothing more and repeats no side effect", async () => {
    const friend = await seedBystander();
    const a = await seedAccount("rerun", friend);
    const { scheduledAt } = await requestDeletion(a.id);
    const now = scheduledAt.getTime() + DAY;

    const first = await runPurge(now);
    expect(first.identityDeletes).toContain(a.email);
    await expectAccountErased(a);

    const second = await runPurge(now);
    expect(second.identityDeletes).not.toContain(a.email);
    expect(second.emails).not.toContain(a.email);
    expect(await db.deletionAuditLog.count({ where: { userId: a.id } })).toBe(1);
    expect(deletionCounts(second)).toMatchObject({ ProcessedCount: 0, FailedCount: 0 });
    await expectAccountErased(a);
    await expectBystanderIntact(friend);
  });

  it("one account failing does not stop the others; the failed one stays due and is retried", async () => {
    const friend = await seedBystander();
    // Created first so the (unordered) due-account scan is overwhelmingly
    // likely to meet it first — asserted below, so the test cannot pass
    // vacuously by processing the failing account last.
    const failing = await seedAccount("fails", friend);
    const ok = await seedAccount("succeeds", friend);
    const { scheduledAt: s1 } = await requestDeletion(failing.id);
    const { scheduledAt: s2 } = await requestDeletion(ok.id);
    const now = Math.max(s1.getTime(), s2.getTime()) + DAY;

    const attempts: string[] = [];
    const run = await runPurge(now, (real) =>
      injectUserDeleteFault(real, failing.id, attempts),
    );

    expect(attempts.indexOf(failing.id)).toBeGreaterThanOrEqual(0);
    expect(attempts.indexOf(failing.id)).toBeLessThan(attempts.indexOf(ok.id));

    await expectAccountErased(ok);
    expect(run.identityDeletes).toContain(ok.email);
    // The failed account keeps its row and its due state, so the next night
    // retries it. (Its identity was deleted first, before the DB fault; the
    // retry re-issues that delete, which adapters treat as idempotent.)
    const stillDue = await db.user.findUniqueOrThrow({ where: { id: failing.id } });
    expect(stillDue.deletionConfirmedAt).not.toBeNull();
    expect(stillDue.deletionScheduledAt!.getTime()).toBeLessThanOrEqual(now);
    expect(deletionCounts(run)).toMatchObject({ ProcessedCount: 1, FailedCount: 1 });

    // Next night, fault gone: it is purged.
    const retry = await runPurge(now + DAY);
    expect(await db.user.findUnique({ where: { id: failing.id } })).toBeNull();
    expect(retry.identityDeletes).toContain(failing.email);
    await expectBystanderIntact(friend);
  });
});

describe("account deletion — a partial failure is finished by the retry", () => {
  it("a fault right after the user's ownerships are removed does not strand their solely-owned entity", async () => {
    const friend = await seedBystander();
    const a = await seedAccount("partial", friend);
    const { scheduledAt } = await requestDeletion(a.id);
    const now = scheduledAt.getTime() + DAY;

    // Fail the first database call that follows `entityOwnership.deleteMany`
    // — whatever step that is. Erasure is not one transaction, so the retry
    // must be able to finish from ANY intermediate state.
    const first = await runPurge(now, (real) =>
      injectFaultAfter(real, "entityOwnership", "deleteMany"),
    );
    expect(deletionCounts(first)).toMatchObject({ FailedCount: 1 });
    expect(await db.user.findUnique({ where: { id: a.id } })).not.toBeNull();

    await runPurge(now + DAY);

    // Before the fix the ownership row was already gone, so the retry's
    // "entities this user owns" query found nothing and the dog survived,
    // ownerless, forever.
    await expectAccountErased(a);
    expect(await db.entity.findUnique({ where: { id: a.soleEntityId } })).toBeNull();
    await expectBystanderIntact(friend);
  });
});

describe("account deletion — identity-provider failure is retried, not lost", () => {
  it("a failed identity delete leaves the account due and untouched; the next run deletes identity and data", async () => {
    const friend = await seedBystander();
    const a = await seedAccount("idp-down", friend);
    const other = await seedAccount("idp-ok", friend);
    const { scheduledAt: s1 } = await requestDeletion(a.id);
    const { scheduledAt: s2 } = await requestDeletion(other.id);
    const now = Math.max(s1.getTime(), s2.getTime()) + DAY;

    const first = await runPurge(now, undefined, [a.email]);

    // Before: the identity delete ran AFTER the DB erasure and its failure was
    // swallowed — the row was gone, nothing recorded that the identity still
    // existed, and it was never retried. Now nothing is erased for that
    // account, so its row is still the record of the outstanding work.
    await expectAccountIntact(a);
    const row = await db.user.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.deletionConfirmedAt).not.toBeNull();
    expect(row.deletionScheduledAt!.getTime()).toBeLessThanOrEqual(now);
    expect(first.identityDeletes).not.toContain(a.email);
    expect(first.emails).not.toContain(a.email);
    expect(await db.deletionAuditLog.count({ where: { userId: a.id } })).toBe(0);
    // …and it did not hold up the other account.
    await expectAccountErased(other);
    expect(deletionCounts(first)).toMatchObject({ ProcessedCount: 1, FailedCount: 1 });

    const retry = await runPurge(now + DAY);
    expect(retry.identityDeletes).toContain(a.email);
    await expectAccountErased(a);
    expect(retry.emails).toContain(a.email);
    expect(await db.deletionAuditLog.count({ where: { userId: a.id } })).toBe(1);
    await expectBystanderIntact(friend);
  });
});

/**
 * Wrap the real client so that, once `<model>.<method>` has completed, the
 * NEXT delegate call of any kind throws — exactly once.
 */
function injectFaultAfter(real: PrismaClient, model: string, method: string): PrismaClient {
  let armed = false;
  let fired = false;
  const wrapDelegate = (name: string, delegate: object) =>
    new Proxy(delegate, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return async (...args: unknown[]) => {
          if (armed && !fired) {
            fired = true;
            throw new Error(`injected fault after ${model}.${method} (at ${name}.${String(prop)})`);
          }
          const out = await (v as (...a: unknown[]) => unknown).apply(target, args);
          if (name === model && prop === method && !fired) armed = true;
          return out;
        };
      },
    });
  return new Proxy(real, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof prop === "string" && !prop.startsWith("$") && v && typeof v === "object") {
        return wrapDelegate(prop, v as object);
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/**
 * Wrap the real client so `user.delete` for one id throws (a stand-in for any
 * per-account failure) and every `user.delete` attempt is recorded in order.
 */
function injectUserDeleteFault(
  real: PrismaClient,
  failId: string,
  attempts: string[],
): PrismaClient {
  const userDelegate = real.user;
  const wrappedUser = new Proxy(userDelegate, {
    get(target, prop, receiver) {
      if (prop === "delete") {
        return async (args: { where: { id: string } }) => {
          attempts.push(args.where.id);
          if (args.where.id === failId) {
            throw new Error("injected per-account failure");
          }
          return target.delete(args as never);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "user") return wrappedUser;
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
