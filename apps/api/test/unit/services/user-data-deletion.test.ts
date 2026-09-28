import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ExtensionModelRegistryEntry } from "../../../src/lib/extension-model-registry.js";

const { mockGetParameter, mockResolveSecret, mockRegistry } = vi.hoisted(() => ({
  mockGetParameter: vi.fn(),
  mockResolveSecret: vi.fn(),
  // Mutable stand-in for EXTENSION_MODEL_REGISTRY (real one is empty today —
  // O-1 is infra ahead of its first table-owner). Tests below push/clear
  // entries to exercise the erasure loop without waiting on L2's composer.
  mockRegistry: [] as ExtensionModelRegistryEntry[],
}));

// WS-2 §5.3: the SSM SecureString now resolves via the foundation port
// (resolveParameter), not powertools — one secrets path.
vi.mock("@de-otio/saas-foundation/secrets", () => ({
  resolveSecret: mockResolveSecret,
  resolveParameter: mockGetParameter,
  secretRef: vi.fn((arn: string) => ({ arn })),
}));

vi.mock("../../../src/lib/extension-model-registry.js", () => ({
  EXTENSION_MODEL_REGISTRY: mockRegistry,
  // The erasure flow now reads the boot-injected registry via the getter (plan
  // 011 Phase B); return the same mutable stand-in so the existing push/clear
  // tests still drive it.
  getExtensionModelRegistry: () => mockRegistry,
}));

import {
  deleteUserData,
  pseudonymizeUserId,
  resolvePseudonymSecret,
} from "../../../src/lib/services/user-data-deletion.js";

// WS-2 findings 2+7: the tombstone key is now a REQUIRED caller-supplied
// argument (deleteUserData never resolves secrets / reads process.env itself).
const TEST_SECRET = "unit-test-pseudonym-secret";

describe("deleteUserData", () => {
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.length = 0;
    mockDb = {
      commentSentiment: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
      postSentiment: { deleteMany: vi.fn().mockResolvedValue({ count: 3 }) },
      postComment: {
        findMany: vi.fn().mockResolvedValue([{ id: "comment-1" }, { id: "comment-2" }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      postCommentMedia: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      post: {
        findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      postSubject: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      postTaxonomyTag: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      postMedia: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      entity: {
        findMany: vi.fn().mockResolvedValue([{ id: "entity-1" }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      entityTaxonomyTag: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      entityOwnership: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      directMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      customAudienceMember: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      customAudience: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      securityEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 4 }) },
      consent: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      invitation: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      // Surveillance-hardening Phase 0 (P2): target-side InteractionEvent erasure.
      interactionEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 5 }) },
      // Surveillance-hardening Phase 0 (P4): ACCOUNT-report pseudonymization.
      report: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      // RESTRICT-FK rows the final user.delete() would otherwise fail on.
      notification: { deleteMany: vi.fn().mockResolvedValue({ count: 6 }) },
      notificationPreference: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      connectionCode: {
        findMany: vi.fn().mockResolvedValue([{ id: "code-1" }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      connectionCodeRedemption: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
      parentalLink: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      // Personal tenant (step 15f). Default: the user has none.
      tenant: {
        findFirst: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      tenantMember: { count: vi.fn().mockResolvedValue(0) },
      tenantDirectoryProfile: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      event: { count: vi.fn().mockResolvedValue(0) },
      group: { count: vi.fn().mockResolvedValue(0) },
      user: { delete: vi.fn().mockResolvedValue({ id: "user-123" }) },
      // AR7 — GDPR media erasure: MediaFile rows + reference lookups.
      mediaFile: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    mockDb.postMedia.groupBy = vi.fn().mockResolvedValue([]);
    mockDb.postCommentMedia.groupBy = vi.fn().mockResolvedValue([]);
  });

  it("should delete all user data in correct order and return counts", async () => {
    const result = await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

    expect(result).toEqual({
      commentSentiments: 2,
      postSentiments: 3,
      comments: 2,
      posts: 1,
      entities: 1,
      follows: 0, // Follow relationships now handled by graph DB
      directMessages: 0,
      audienceMembers: 0,
      audiences: 0,
      securityEvents: 4,
      crossRegionConsents: 1,
      invitations: 0,
      interactionEventsAsTarget: 5,
      accountReportsPseudonymized: 0,
      mediaFilesErased: 0,
      mediaFilesRetainedShared: 0,
      mediaStagingKeys: [],
      extensionRowsErased: 0,
      notifications: 6,
      notificationPreferences: 1,
      connectionCodes: 1,
      connectionCodeRedemptions: 2,
      parentalLinks: 1,
      personalTenant: "none",
    });

    // Verify deletion order: sentiments before comments, comments before posts, posts before entities
    const calls = vi.mocked(mockDb.commentSentiment.deleteMany).mock.invocationCallOrder[0];
    const commentDeleteOrder = vi.mocked(mockDb.postComment.deleteMany).mock.invocationCallOrder[0];
    const postDeleteOrder = vi.mocked(mockDb.post.deleteMany).mock.invocationCallOrder[0];
    const entityDeleteOrder = vi.mocked(mockDb.entity.deleteMany).mock.invocationCallOrder[0];
    const userDeleteOrder = vi.mocked(mockDb.user.delete).mock.invocationCallOrder[0];

    expect(calls).toBeLessThan(commentDeleteOrder);
    expect(commentDeleteOrder).toBeLessThan(postDeleteOrder);
    expect(postDeleteOrder).toBeLessThan(entityDeleteOrder);
    expect(entityDeleteOrder).toBeLessThan(userDeleteOrder);
  });

  it("should delete user as the final step", async () => {
    await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

    expect(mockDb.user.delete).toHaveBeenCalledWith({
      where: { id: "user-123" },
    });
  });

  it("should handle user with no comments or posts gracefully", async () => {
    mockDb.postComment.findMany.mockResolvedValue([]);
    mockDb.post.findMany.mockResolvedValue([]);
    mockDb.entity.findMany.mockResolvedValue([]);

    const result = await deleteUserData(mockDb, "user-empty", { pseudonymSecret: TEST_SECRET });

    // Should not attempt to delete comment media or post junction tables
    expect(mockDb.postCommentMedia.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.postSubject.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.postTaxonomyTag.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.postMedia.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.entityTaxonomyTag.deleteMany).not.toHaveBeenCalled();

    // Should still delete the user
    expect(mockDb.user.delete).toHaveBeenCalledWith({
      where: { id: "user-empty" },
    });

    expect(result.comments).toBe(2); // deleteMany still called for comments table
    expect(result.posts).toBe(1);
  });

  // "should delete follows in both directions" test removed:
  // Follow relationships are now handled by the graph DB (AuraDB), not Postgres.

  it("should delete direct messages sent and received", async () => {
    await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

    expect(mockDb.directMessage.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [{ senderId: "user-123" }, { recipientId: "user-123" }],
      },
    });
  });

  it("should delete invitations created and used", async () => {
    await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

    expect(mockDb.invitation.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [{ createdBy: "user-123" }, { usedBy: "user-123" }],
      },
    });
  });

  // Regression: entity deletion had no scope — `deleteMany({ owners: { none:
  // {} } })` removed every ownerless entity on the platform, in every tenant,
  // on each account erasure; and taxonomy tags were stripped from every entity
  // the user co-owned, including those that survive with another owner.
  describe("entity deletion is scoped to the user's own entities", () => {
    it("deletes only candidates the user owned, never a platform-wide ownerless sweep", async () => {
      mockDb.entity.findMany
        .mockResolvedValueOnce([{ id: "e-sole" }, { id: "e-shared" }]) // user's entities
        .mockResolvedValueOnce([{ id: "e-sole" }]); // …of which now ownerless

      await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

      expect(mockDb.entity.findMany).toHaveBeenNthCalledWith(2, {
        where: { id: { in: ["e-sole", "e-shared"] }, owners: { none: {} } },
        select: { id: true },
      });
      expect(mockDb.entity.deleteMany).toHaveBeenCalledTimes(1);
      expect(mockDb.entity.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["e-sole"] }, owners: { none: {} } },
      });
      // The orphan check runs after the user's ownerships are gone.
      expect(mockDb.entityOwnership.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
        mockDb.entity.findMany.mock.invocationCallOrder[1],
      );
    });

    it("keeps the taxonomy tags of an entity that still has another owner", async () => {
      mockDb.entity.findMany
        .mockResolvedValueOnce([{ id: "e-sole" }, { id: "e-shared" }])
        .mockResolvedValueOnce([{ id: "e-sole" }]);

      await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

      expect(mockDb.entityTaxonomyTag.deleteMany).toHaveBeenCalledTimes(1);
      expect(mockDb.entityTaxonomyTag.deleteMany).toHaveBeenCalledWith({
        where: { entityId: { in: ["e-sole"] } },
      });
    });

    it("issues no entity delete at all when the user owned nothing", async () => {
      mockDb.entity.findMany.mockResolvedValue([]);

      const result = await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

      expect(mockDb.entity.deleteMany).not.toHaveBeenCalled();
      expect(result.entities).toBe(0);
    });

    it("considers ownerships of any status, not only ACTIVE ones", async () => {
      await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

      expect(mockDb.entity.findMany).toHaveBeenNthCalledWith(1, {
        where: { owners: { some: { userId: "user-123" } } },
        select: { id: true },
      });
    });
  });

  // Regression: the personal tenant's FK to the user is SET NULL, so it
  // survived erasure named after the user (displayName = handle).
  describe("the user's personal tenant", () => {
    const TENANT = "t-personal";
    beforeEach(() => {
      mockDb.tenant.findFirst.mockResolvedValue({ id: TENANT });
      mockDb.post.count = vi.fn().mockResolvedValue(0);
      mockDb.postComment.count = vi.fn().mockResolvedValue(0);
      mockDb.entity.count = vi.fn().mockResolvedValue(0);
    });

    it("is looked up by its personal owner", async () => {
      await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });
      expect(mockDb.tenant.findFirst).toHaveBeenCalledWith({
        where: { personalOwnerUserId: "user-123", type: "PERSONAL" },
        select: { id: true },
      });
    });

    it("is deleted when nothing in it belongs to anyone else", async () => {
      const result = await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

      expect(mockDb.tenant.delete).toHaveBeenCalledWith({ where: { id: TENANT } });
      expect(mockDb.tenant.update).not.toHaveBeenCalled();
      expect(result.personalTenant).toBe("deleted");
      expect(mockDb.tenant.delete.mock.invocationCallOrder[0]).toBeLessThan(
        mockDb.user.delete.mock.invocationCallOrder[0],
      );
    });

    it.each([
      ["another member", "tenantMember"],
      ["another user's entity (e.g. a co-owned dog)", "entity"],
      ["a post", "post"],
      ["a comment", "postComment"],
      ["an event", "event"],
      ["a group", "group"],
    ])("is kept but anonymised when it still holds %s", async (_label, model) => {
      mockDb[model].count = vi.fn().mockResolvedValue(1);

      const result = await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

      expect(mockDb.tenant.delete).not.toHaveBeenCalled();
      expect(mockDb.tenant.update).toHaveBeenCalledWith({
        where: { id: TENANT },
        data: { displayName: "Deleted account", slug: `deleted-${TENANT}` },
      });
      expect(mockDb.tenantDirectoryProfile.deleteMany).toHaveBeenCalledWith({
        where: { tenantId: TENANT },
      });
      expect(result.personalTenant).toBe("anonymised");
    });

    it("counts only OTHER members, never the user being erased", async () => {
      await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });
      expect(mockDb.tenantMember.count).toHaveBeenCalledWith({
        where: { tenantId: TENANT, userId: { not: "user-123" } },
      });
    });
  });

  // Regression: these four tables reference users(id) ON DELETE RESTRICT
  // (prisma/migrations/20260705050826_init) and nothing removed them, so
  // user.delete() failed for any account with a notification — after the
  // rest of the erasure had already run, with no transaction to undo it. The
  // nightly purge then retried, and failed, every night. Proven against real
  // Postgres in test/integration/account-deletion-grace-purge.integration.test.ts.
  describe("rows that would block the final user.delete() (RESTRICT FKs)", () => {
    it("removes the user's notifications and notification preferences", async () => {
      await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

      expect(mockDb.notification.deleteMany).toHaveBeenCalledWith({
        where: { userId: "user-123" },
      });
      expect(mockDb.notificationPreference.deleteMany).toHaveBeenCalledWith({
        where: { userId: "user-123" },
      });
    });

    it("removes the user's connection codes, their redemptions, and the user's own redemptions", async () => {
      await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

      expect(mockDb.connectionCode.findMany).toHaveBeenCalledWith({
        where: { creatorId: "user-123" },
        select: { id: true },
      });
      expect(mockDb.connectionCodeRedemption.deleteMany).toHaveBeenCalledWith({
        where: { OR: [{ userId: "user-123" }, { codeId: { in: ["code-1"] } }] },
      });
      expect(mockDb.connectionCode.deleteMany).toHaveBeenCalledWith({
        where: { creatorId: "user-123" },
      });
      // Redemptions first: redemption → code is RESTRICT as well.
      expect(
        mockDb.connectionCodeRedemption.deleteMany.mock.invocationCallOrder[0],
      ).toBeLessThan(mockDb.connectionCode.deleteMany.mock.invocationCallOrder[0]);
    });

    it("scopes redemptions to the user alone when they created no codes", async () => {
      mockDb.connectionCode.findMany.mockResolvedValue([]);
      await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

      expect(mockDb.connectionCodeRedemption.deleteMany).toHaveBeenCalledWith({
        where: { userId: "user-123" },
      });
    });

    it("removes guardian/child links in which the user is either party", async () => {
      await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

      expect(mockDb.parentalLink.deleteMany).toHaveBeenCalledWith({
        where: { OR: [{ childId: "user-123" }, { guardianId: "user-123" }] },
      });
    });

    it("clears all of them BEFORE deleting the user row", async () => {
      await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

      const userDelete = mockDb.user.delete.mock.invocationCallOrder[0];
      for (const fn of [
        mockDb.notification.deleteMany,
        mockDb.notificationPreference.deleteMany,
        mockDb.connectionCodeRedemption.deleteMany,
        mockDb.connectionCode.deleteMany,
        mockDb.parentalLink.deleteMany,
      ]) {
        expect(fn.mock.invocationCallOrder[0]).toBeLessThan(userDelete);
      }
    });
  });

  it("erases target-side interaction events (GDPR Art. 17, P2)", async () => {
    await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

    // Actor-side rows cascade via FK on user.delete(); target-side rows (about
    // the deleted user) have no FK and need this explicit deleteMany.
    expect(mockDb.interactionEvent.deleteMany).toHaveBeenCalledWith({
      where: { targetType: "user", targetId: "user-123" },
    });
  });

  it("pseudonymizes ACCOUNT reports about the deleted user (GDPR Art. 17, P4)", async () => {
    await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

    // The tombstone key is resolved at runtime (resolvePseudonymSecret), so
    // assert the where-clause exactly and the resourceId structurally.
    expect(mockDb.report.updateMany).toHaveBeenCalledWith({
      where: { reportType: "ACCOUNT", resourceType: "user", resourceId: "user-123" },
      data: { resourceId: expect.stringMatching(/^deleted:[0-9a-f]{32}$/) },
    });
  });

  // Worker review W3: the sink guard. Every filter is `{ where: { fk: userId } }`,
  // so a non-string userId would be an all-rows predicate.
  describe("userId type guard at the sink (W3)", () => {
    it.each([
      ["a Prisma operator object", { not: "" }],
      ["an empty string", ""],
      ["a number", 42],
      ["undefined", undefined],
    ])("throws BEFORE any deletion when userId is %s", async (_label, userId) => {
      await expect(
        deleteUserData(mockDb, userId as unknown as string, { pseudonymSecret: TEST_SECRET }),
      ).rejects.toThrow(/userId must be a non-empty string/);

      expect(mockDb.commentSentiment.deleteMany).not.toHaveBeenCalled();
      expect(mockDb.report.updateMany).not.toHaveBeenCalled();
      expect(mockDb.user.delete).not.toHaveBeenCalled();
    });
  });

  // WS-2 finding 2: the fail-closed tombstone-key gate.
  describe("pseudonym-secret fail-closed gate (finding 2)", () => {
    it("throws BEFORE any deletion when the secret is empty", async () => {
      await expect(
        deleteUserData(mockDb, "user-123", { pseudonymSecret: "" }),
      ).rejects.toThrow(/fail-closed/);

      // Nothing was deleted and no tombstone was written.
      expect(mockDb.commentSentiment.deleteMany).not.toHaveBeenCalled();
      expect(mockDb.report.updateMany).not.toHaveBeenCalled();
      expect(mockDb.user.delete).not.toHaveBeenCalled();
    });

    it("throws BEFORE any deletion when the secret is absent (untyped caller)", async () => {
      await expect(
        deleteUserData(mockDb, "user-123", { pseudonymSecret: undefined as unknown as string }),
      ).rejects.toThrow(/fail-closed/);
      expect(mockDb.user.delete).not.toHaveBeenCalled();
    });

    it("never resolves secrets itself — no SSM/Secrets Manager call from deleteUserData (finding 7)", async () => {
      await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });
      expect(mockGetParameter).not.toHaveBeenCalled();
      expect(mockResolveSecret).not.toHaveBeenCalled();
    });

    it("uses the caller-supplied key for the tombstone", async () => {
      await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });
      expect(mockDb.report.updateMany).toHaveBeenCalledWith({
        where: { reportType: "ACCOUNT", resourceType: "user", resourceId: "user-123" },
        data: { resourceId: pseudonymizeUserId("user-123", TEST_SECRET) },
      });
    });
  });

  it("should propagate database errors", async () => {
    mockDb.commentSentiment.deleteMany.mockRejectedValue(new Error("DB connection lost"));

    await expect(deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET })).rejects.toThrow("DB connection lost");
  });

  // ── AR7: GDPR media erasure ────────────────────────────────────────────────
  // The user's MediaFile rows must be erased on account deletion. The account-
  // deletion path previously never touched media_files at all (the S3 half
  // targeted the obsolete `originals/user-{id}/` prefix), so account deletion
  // removed ZERO media bytes — a GDPR Art. 17 erasure gap.
  describe("GDPR media erasure (AR7)", () => {
    const TENANT = "cabcdefghijklmnopqrstuvwx"; // valid CUID shape for key builders
    const HASH = "a".repeat(64);
    const UPLOAD_ID = "cupload00000000000000001x";

    it("erases the user's MediaFile rows: unreferenced rows are soft-deleted into the existing GC purge and staging keys are returned", async () => {
      mockDb.mediaFile.findMany
        .mockResolvedValueOnce([
          {
            id: "media-1",
            tenantId: TENANT,
            contentHash: HASH,
            uploadId: UPLOAD_ID,
            deletedAt: null,
          },
        ])
        .mockResolvedValue([]);

      const result = await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

      // The row is soft-deleted (deletedAt set) + the personal link scrubbed —
      // this is what hands the CAS object to the existing nightly GC purge.
      expect(mockDb.mediaFile.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { in: ["media-1"] } }),
          data: expect.objectContaining({
            deletedAt: expect.any(Date),
            uploadedBy: null,
          }),
        }),
      );
      expect(result.mediaFilesErased).toBe(1);
      expect(result.mediaFilesRetainedShared).toBe(0);
      // The worker can delete the user-scoped staging objects directly.
      expect(result.mediaStagingKeys).toEqual(
        expect.arrayContaining([
          `pending/${TENANT}/${UPLOAD_ID}`,
          `processing/${TENANT}/${HASH}`,
        ]),
      );
    });

    it("retains a media row still referenced by another user's content, scrubbing only the personal link", async () => {
      mockDb.mediaFile.findMany
        .mockResolvedValueOnce([
          {
            id: "media-shared",
            tenantId: TENANT,
            contentHash: HASH,
            uploadId: null,
            deletedAt: null,
          },
        ])
        .mockResolvedValue([]);
      // Another user's post still references the row (dedup reference).
      mockDb.postMedia.groupBy.mockResolvedValue([{ mediaId: "media-shared" }]);

      const result = await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

      // Retained: uploadedBy scrubbed, NOT soft-deleted (no deletedAt write).
      expect(mockDb.mediaFile.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { in: ["media-shared"] } }),
          data: { uploadedBy: null },
        }),
      );
      const softDeleteCalls = mockDb.mediaFile.updateMany.mock.calls.filter(
        (c: any[]) => c[0]?.data?.deletedAt,
      );
      expect(softDeleteCalls).toHaveLength(0);
      expect(result.mediaFilesErased).toBe(0);
      expect(result.mediaFilesRetainedShared).toBe(1);
      expect(result.mediaStagingKeys).toEqual([]);
    });

    it("runs media erasure after the user's own posts/comments (and their junction rows) are deleted", async () => {
      mockDb.mediaFile.findMany
        .mockResolvedValueOnce([
          { id: "media-1", tenantId: TENANT, contentHash: HASH, uploadId: null, deletedAt: null },
        ])
        .mockResolvedValue([]);

      await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

      const postMediaOrder = vi.mocked(mockDb.postMedia.deleteMany).mock.invocationCallOrder[0];
      const mediaScanOrder = vi.mocked(mockDb.mediaFile.findMany).mock.invocationCallOrder[0];
      const userDeleteOrder = vi.mocked(mockDb.user.delete).mock.invocationCallOrder[0];
      expect(postMediaOrder).toBeLessThan(mediaScanOrder);
      expect(mediaScanOrder).toBeLessThan(userDeleteOrder);
    });
  });

  // ── O-1 L4: extension-owned (`ext_*`) erasure participation ────────────────
  describe("extension-owned erasure (O-1 design §6 / §12.4 item 1)", () => {
    it("registry empty (today's default): the erasure loop is a clean no-op", async () => {
      // mockRegistry is cleared in the outer beforeEach — assert the default
      // shipped state (no extension owns a table yet) behaves cleanly.
      const result = await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

      expect(result.extensionRowsErased).toBe(0);
    });

    it("deletes per-subject rows for a subject-scoped model BEFORE db.user.delete()", async () => {
      mockRegistry.push({
        model: "dogReminder",
        tenantField: "tenantId",
        erasureSubjectField: "userId",
      });
      mockDb.dogReminder = { deleteMany: vi.fn().mockResolvedValue({ count: 3 }) };

      const result = await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

      expect(mockDb.dogReminder.deleteMany).toHaveBeenCalledWith({
        where: { userId: "user-123" },
      });
      const eraseOrder = vi.mocked(mockDb.dogReminder.deleteMany).mock.invocationCallOrder[0];
      const userDeleteOrder = vi.mocked(mockDb.user.delete).mock.invocationCallOrder[0];
      expect(eraseOrder).toBeLessThan(userDeleteOrder);
      expect(result.extensionRowsErased).toBe(3);
    });

    it("skips cascade-only models (erasureSubjectField: null) — relies on FK cascade", async () => {
      mockRegistry.push({
        model: "dogPhoto",
        tenantField: "tenantId",
        erasureSubjectField: null,
      });
      mockDb.dogPhoto = { deleteMany: vi.fn().mockResolvedValue({ count: 99 }) };

      const result = await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

      expect(mockDb.dogPhoto.deleteMany).not.toHaveBeenCalled();
      expect(result.extensionRowsErased).toBe(0);
    });

    it("sums counts across multiple subject-scoped models", async () => {
      mockRegistry.push(
        { model: "dogReminder", tenantField: "tenantId", erasureSubjectField: "userId" },
        { model: "dogNote", tenantField: "tenantId", erasureSubjectField: "authorId" },
      );
      mockDb.dogReminder = { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) };
      mockDb.dogNote = { deleteMany: vi.fn().mockResolvedValue({ count: 5 }) };

      const result = await deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET });

      expect(mockDb.dogNote.deleteMany).toHaveBeenCalledWith({
        where: { authorId: "user-123" },
      });
      expect(result.extensionRowsErased).toBe(7);
    });

    it("throws on registry/schema drift instead of silently skipping (Art. 17 safety)", async () => {
      mockRegistry.push({
        model: "modelNotOnClient",
        tenantField: "tenantId",
        erasureSubjectField: "userId",
      });
      // mockDb intentionally has no `modelNotOnClient` delegate.

      await expect(deleteUserData(mockDb, "user-123", { pseudonymSecret: TEST_SECRET })).rejects.toThrow(
        /modelNotOnClient/,
      );
      // Must fail BEFORE the user row is deleted — otherwise a drifted
      // registry entry would leave orphaned data with no way to retry erasure.
      expect(mockDb.user.delete).not.toHaveBeenCalled();
    });
  });
});

describe("pseudonymizeUserId", () => {
  const KEY = "test-pseudonym-key-32-characters!!";

  it("is deterministic per (key, id) and does not leak the plaintext id", () => {
    const a = pseudonymizeUserId("user-123", KEY);
    const b = pseudonymizeUserId("user-123", KEY);
    expect(a).toBe(b);
    expect(a).not.toContain("user-123");
    expect(a.startsWith("deleted:")).toBe(true);
  });

  it("maps different ids to different tombstones", () => {
    expect(pseudonymizeUserId("a", KEY)).not.toBe(pseudonymizeUserId("b", KEY));
  });

  it("is keyed — a different key yields a different tombstone for the same id", () => {
    expect(pseudonymizeUserId("user-123", KEY)).not.toBe(
      pseudonymizeUserId("user-123", "a-different-key-32-characters-long!"),
    );
  });
});

describe("resolvePseudonymSecret", () => {
  const ENV_KEYS = [
    "REPORT_PSEUDONYM_SECRET",
    "REPORT_PSEUDONYM_SECRET_PARAM",
    "SESSION_SECRET",
    "SESSION_SECRET_ARN",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("prefers the plaintext REPORT_PSEUDONYM_SECRET (local/dev/CI)", async () => {
    process.env.REPORT_PSEUDONYM_SECRET = "plain-secret";
    await expect(resolvePseudonymSecret()).resolves.toBe("plain-secret");
    expect(mockGetParameter).not.toHaveBeenCalled();
  });

  it("resolves the SSM SecureString when REPORT_PSEUDONYM_SECRET_PARAM is set (production path, foundation resolveParameter)", async () => {
    process.env.REPORT_PSEUDONYM_SECRET_PARAM = "/app/dev/report-pseudonym-key";
    mockGetParameter.mockResolvedValue(Buffer.from("ssm-secret", "utf-8"));
    await expect(resolvePseudonymSecret()).resolves.toBe("ssm-secret");
    expect(mockGetParameter).toHaveBeenCalledWith("/app/dev/report-pseudonym-key");
  });

  it("does NOT fall back to SESSION_SECRET when the SSM parameter resolves empty (DP-10)", async () => {
    process.env.REPORT_PSEUDONYM_SECRET_PARAM = "/app/dev/report-pseudonym-key";
    process.env.SESSION_SECRET = "session-secret-that-must-never-key-a-tombstone";
    mockGetParameter.mockResolvedValue(Buffer.from("", "utf-8"));
    await expect(resolvePseudonymSecret()).rejects.toThrow(/no SESSION_SECRET fallback/);
  });

  it("a missing SSM parameter THROWS (fail-closed, unchanged semantics)", async () => {
    process.env.REPORT_PSEUDONYM_SECRET_PARAM = "/app/dev/report-pseudonym-key";
    mockGetParameter.mockRejectedValue(new Error("Parameter not found"));
    await expect(resolvePseudonymSecret()).rejects.toThrow("Parameter not found");
  });

  it("does NOT fall back to the session secret via SESSION_SECRET_ARN either (DP-10)", async () => {
    process.env.SESSION_SECRET_ARN = "arn:aws:secretsmanager:eu-central-1:123:secret:session";
    mockResolveSecret.mockResolvedValue(Buffer.from("sm-secret", "utf-8"));
    await expect(resolvePseudonymSecret()).rejects.toThrow(/failing closed/);
    expect(mockResolveSecret).not.toHaveBeenCalled();
  });

  it("a plaintext SESSION_SECRET alone is a misconfiguration, not a key (DP-10)", async () => {
    process.env.SESSION_SECRET = "session-secret-that-must-never-key-a-tombstone";
    await expect(resolvePseudonymSecret()).rejects.toThrow(/REPORT_PSEUDONYM_SECRET/);
  });

  it("THROWS when nothing is configured (fail-closed, WS-2 finding 2 — never an empty key)", async () => {
    await expect(resolvePseudonymSecret()).rejects.toThrow(/failing closed/);
  });
});
