/**
 * Unit Tests: Nightly Cron Lambda.
 *
 * Focus: the GDPR account-deletion path (AR7) — media erasure happens inside
 * deleteUserData, the cron deletes the reported user-scoped STAGING keys, and
 * it must never enumerate the obsolete `originals/user-{id}/` prefix (which
 * matches nothing under the CAS key scheme and silently deleted zero bytes).
 * Also covers step 1, the soft-deleted-media purge — the GC path that
 * reclaims the CAS bytes the erasure soft-deletes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  kvState,
  mockDynamoSend,
  mockS3Send,
  mockCognitoSend,
  mockSesSend,
  mockDeleteUserData,
  mockResolvePseudonymSecret,
  mockDb,
} = vi.hoisted(() => ({
  // WS-2 T3b: the cron lock goes through the kv-provider seam now.
  kvState: { kv: undefined as unknown },
  mockDynamoSend: vi.fn(),
  mockS3Send: vi.fn(),
  mockCognitoSend: vi.fn(),
  mockSesSend: vi.fn(),
  mockDeleteUserData: vi.fn(),
  mockResolvePseudonymSecret: vi.fn(),
  mockDb: {
    mediaFile: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    invitation: { deleteMany: vi.fn() },
    user: { findMany: vi.fn(), count: vi.fn() },
    deletionAuditLog: { create: vi.fn() },
  } as any,
}));

vi.mock("@aws-sdk/client-dynamodb", () => {
  const DynamoDBClient = vi.fn();
  DynamoDBClient.prototype.send = mockDynamoSend;
  return {
    DynamoDBClient,
    PutItemCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
    DeleteItemCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
  };
});

vi.mock("@aws-sdk/client-s3", () => {
  const S3Client = vi.fn();
  S3Client.prototype.send = mockS3Send;
  return {
    S3Client,
    DeleteObjectsCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
    ListObjectsV2Command: vi.fn(function (this: any, input: any) { this.input = input; }),
  };
});

vi.mock("@aws-sdk/client-cognito-identity-provider", () => {
  const CognitoIdentityProviderClient = vi.fn();
  CognitoIdentityProviderClient.prototype.send = mockCognitoSend;
  return {
    CognitoIdentityProviderClient,
    AdminDeleteUserCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
  };
});

vi.mock("@aws-sdk/client-ses", () => {
  const SESClient = vi.fn();
  SESClient.prototype.send = mockSesSend;
  return {
    SESClient,
    SendEmailCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
  };
});

vi.mock("@aws-sdk/util-dynamodb", () => ({
  marshall: vi.fn((obj: any) => obj),
}));

vi.mock("../../../src/lib/lambda-prisma", () => ({
  getLambdaPrisma: vi.fn(async () => mockDb),
}));

vi.mock("../../../src/lib/kv/kv-provider.js", () => ({
  getKvStore: vi.fn(() => kvState.kv),
}));

vi.mock("../../../src/lib/services/user-data-deletion", () => ({
  deleteUserData: mockDeleteUserData,
  resolvePseudonymSecret: mockResolvePseudonymSecret,
}));

vi.mock("../../../src/lib/age-tier-transition", () => ({
  checkAgeTierTransitions: vi.fn(async () => ({ transitioned: 0, errors: 0 })),
}));

vi.mock("../../../src/env", () => ({
  buildEnv: vi.fn(async () => ({})),
}));

vi.mock("../../../src/lib/sentiment-digest", () => ({
  generateSentimentDigest: vi.fn(async () => ({ posts: [] })),
}));

vi.mock("../../../src/lib/notification-handler", () => ({
  NotificationHandler: vi.fn(function (this: any) {
    this.createNotification = vi.fn();
  }),
}));

import { MemoryKvStore } from "@de-otio/saas-foundation/kv";

const TENANT = "cabcdefghijklmnopqrstuvwx";
const HASH = "a".repeat(64);
const STAGING_KEY = `processing/${TENANT}/${HASH}`;
const CAS_KEY = `cas/${TENANT}/${HASH}`;
const TEST_SECRET = "test-pseudonym-secret";

describe("NightlyCron Lambda", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.AWS_REGION = "us-east-1";
    process.env.DYNAMODB_TABLE = "test-table";
    process.env.MEDIA_BUCKET_NAME = "test-media-bucket";
    process.env.COGNITO_USER_POOL_ID = "us-east-1_TestPool";
    process.env.DOMAIN = "example.com";

    kvState.kv = new MemoryKvStore(); // fresh lock namespace → lock acquired
    mockResolvePseudonymSecret.mockResolvedValue(TEST_SECRET);
    mockDynamoSend.mockResolvedValue({});
    mockS3Send.mockReset();
    mockS3Send.mockResolvedValue({});
    mockCognitoSend.mockResolvedValue({});
    mockSesSend.mockResolvedValue({});
    mockDb.mediaFile.findMany.mockResolvedValue([]);
    mockDb.mediaFile.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.invitation.deleteMany.mockResolvedValue({ count: 0 });
    mockDb.user.findMany.mockResolvedValue([]);
    mockDb.user.count.mockResolvedValue(0);
    mockDb.deletionAuditLog.create.mockResolvedValue({});
    mockDeleteUserData.mockResolvedValue({
      posts: 0, comments: 0, entities: 0,
      mediaFilesErased: 0, mediaFilesRetainedShared: 0, mediaStagingKeys: [],
    });
  });

  async function loadHandler() {
    const mod = await import("../../../src/lambda/nightly-cron.js");
    return mod.handler;
  }

  it("skips when the cron lock is held", async () => {
    await (kvState.kv as MemoryKvStore).putIfAbsent(
      "nightly",
      { lockedAt: Math.floor(Date.now() / 1000), owner: "other" },
      { ttlSeconds: 3600 },
    );
    const handler = await loadHandler();
    await handler();
    expect(mockDb.mediaFile.findMany).not.toHaveBeenCalled();
  });

  describe("step 1 — soft-deleted media purge (the GC path for CAS bytes)", () => {
    it("hard-deletes aged soft-deleted rows and batch-deletes their S3 keys (incl. cas/)", async () => {
      mockDb.mediaFile.findMany.mockResolvedValueOnce([
        { id: "m1", originalKey: CAS_KEY, thumbnailKey: null, optimizedKey: null },
      ]);
      mockDb.mediaFile.deleteMany.mockResolvedValueOnce({ count: 1 });

      const handler = await loadHandler();
      await handler();

      const deleteCalls = mockS3Send.mock.calls
        .map((c: any[]) => c[0]?.input)
        .filter((i: any) => i?.Delete);
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0].Delete.Objects).toEqual([{ Key: CAS_KEY }]);
      expect(mockDb.mediaFile.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["m1"] } },
      });
    });

    // REVERSED 2026-08-08. This previously read "tolerates an S3 batch failure
    // and still hard-deletes the DB rows", and asserted `deleteMany` WAS
    // called. That made the orphan bug a specified behaviour rather than an
    // oversight: the row is the only record of which objects exist, so
    // deleting it after a failed object delete strands the bytes with no key
    // left to derive them from.
    //
    // "Tolerates" was the right instinct aimed at the wrong subject. The cron
    // must indeed not throw — one bad batch cannot take down the other four
    // steps — but tolerating the failure means *keeping* the row, not
    // discarding it. Keeping it is also what makes the next run retry.
    it("tolerates an S3 batch failure WITHOUT hard-deleting the DB rows", async () => {
      mockDb.mediaFile.findMany.mockResolvedValueOnce([
        { id: "m1", originalKey: CAS_KEY, thumbnailKey: null, optimizedKey: null },
      ]);
      mockS3Send.mockRejectedValueOnce(new Error("S3 down"));

      const handler = await loadHandler();
      // Still resolves: the purge failure must not abort the rest of the cron.
      await expect(handler()).resolves.toBeUndefined();
      // But the row survives, soft-deleted, inside the cutoff window — so the
      // next run picks it up and tries again.
      expect(mockDb.mediaFile.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe("step 4 — scheduled account deletions (GDPR Art. 17, AR7)", () => {
    const userToDelete = {
      id: "u1",
      email: "u1@test.com",
      deletionRequestedAt: new Date("2026-06-01T00:00:00Z"),
      deletionConfirmedAt: new Date("2026-06-02T00:00:00Z"),
    };

    beforeEach(() => {
      mockDb.user.findMany
        .mockResolvedValueOnce([userToDelete]) // step 4 scheduled deletions
        .mockResolvedValue([]); // step 6 digest scan
    });

    it("deletes the staging keys reported by deleteUserData and never lists the obsolete originals/user-{id}/ prefix", async () => {
      mockDeleteUserData.mockResolvedValueOnce({
        posts: 2, comments: 1, entities: 0,
        mediaFilesErased: 1, mediaFilesRetainedShared: 0,
        mediaStagingKeys: [STAGING_KEY],
      });

      const handler = await loadHandler();
      await handler();

      expect(mockDeleteUserData).toHaveBeenCalledWith(mockDb, "u1", {
        pseudonymSecret: TEST_SECRET,
      });
      const inputs = mockS3Send.mock.calls.map((c: any[]) => c[0]?.input);
      // Staging batch delete happened…
      expect(inputs.some((i: any) => i?.Delete?.Objects?.some((o: any) => o.Key === STAGING_KEY))).toBe(true);
      // …and no prefix enumeration (the obsolete originals/user-… scheme) ran.
      expect(inputs.some((i: any) => i?.Prefix !== undefined)).toBe(false);
      expect(mockCognitoSend).toHaveBeenCalled();
    });

    it("writes the audit row with a staging-key COUNT, not raw storage keys", async () => {
      mockDeleteUserData.mockResolvedValueOnce({
        posts: 0, comments: 0, entities: 0,
        mediaFilesErased: 2, mediaFilesRetainedShared: 1,
        mediaStagingKeys: [STAGING_KEY, `pending/${TENANT}/cupload00000000000000001x`],
      });

      const handler = await loadHandler();
      await handler();

      expect(mockDb.deletionAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "u1",
          itemsDeleted: expect.objectContaining({
            mediaFilesErased: 2,
            mediaFilesRetainedShared: 1,
            mediaStagingKeys: 2,
          }),
        }),
      });
    });

    it("sends the completion email and continues when Cognito deletion fails", async () => {
      mockCognitoSend.mockRejectedValueOnce(new Error("UserNotFoundException"));

      const handler = await loadHandler();
      await expect(handler()).resolves.toBeUndefined();
      expect(mockSesSend).toHaveBeenCalled();
    });

    it("From uses FROM_EMAIL + EMAIL_BRAND_NAME so the sender aligns with DMARC", async () => {
      process.env.FROM_EMAIL = "noreply@mail.dev.skybber.com";
      process.env.EMAIL_BRAND_NAME = "Skybber";
      try {
        const handler = await loadHandler();
        await handler();
        const source = mockSesSend.mock.calls[0][0].input.Source;
        expect(source).toBe("Skybber <noreply@mail.dev.skybber.com>");
      } finally {
        delete process.env.FROM_EMAIL;
        delete process.env.EMAIL_BRAND_NAME;
      }
    });

    it("From falls back to Trellis <noreply@${DOMAIN}> when FROM_EMAIL is unset (byte-identical to pre-fix)", async () => {
      delete process.env.FROM_EMAIL;
      delete process.env.EMAIL_BRAND_NAME;
      const handler = await loadHandler();
      await handler();
      const source = mockSesSend.mock.calls[0][0].input.Source;
      expect(source).toBe("Trellis <noreply@example.com>");
    });

    it("counts a failed deletion without aborting the run", async () => {
      mockDeleteUserData.mockRejectedValueOnce(new Error("DB connection lost"));

      const handler = await loadHandler();
      await expect(handler()).resolves.toBeUndefined();
      // The run completes (lock released path / later steps still executed).
      expect(mockDb.user.count).toHaveBeenCalled();
    });

    it("skips Cognito and the completion email when their config is absent", async () => {
      delete process.env.COGNITO_USER_POOL_ID;
      delete process.env.DOMAIN;

      const handler = await loadHandler();
      await expect(handler()).resolves.toBeUndefined();
      expect(mockCognitoSend).not.toHaveBeenCalled();
      expect(mockSesSend).not.toHaveBeenCalled();
    });

    it("FAIL-CLOSED (finding 2): an unresolvable pseudonym key aborts step 4 before any deletion", async () => {
      mockResolvePseudonymSecret.mockRejectedValueOnce(
        new Error("failing closed: no tombstone key"),
      );

      const handler = await loadHandler();
      await expect(handler()).resolves.toBeUndefined(); // step-4 catch, run continues

      expect(mockDeleteUserData).not.toHaveBeenCalled();
      expect(mockCognitoSend).not.toHaveBeenCalled();
      expect(mockSesSend).not.toHaveBeenCalled();
    });

    it("FAIL-CLOSED (finding 2): an EMPTY pseudonym key aborts step 4 before any deletion", async () => {
      mockResolvePseudonymSecret.mockResolvedValueOnce("");

      const handler = await loadHandler();
      await expect(handler()).resolves.toBeUndefined();

      expect(mockDeleteUserData).not.toHaveBeenCalled();
    });

    it("cleans the DynamoDB profile-cache entry for each deleted user (step 4d)", async () => {
      const handler = await loadHandler();
      await handler();

      const cacheDeletes = mockDynamoSend.mock.calls
        .map((c: any[]) => c[0]?.input)
        .filter((i: any) => i?.Key?.pk === "user:u1");
      expect(cacheDeletes).toHaveLength(1);
      expect(cacheDeletes[0].Key.sk).toBe("profile");
    });
  });

  describe("other sections", () => {
    it("logs expired-invitation cleanup when rows were removed", async () => {
      mockDb.invitation.deleteMany.mockResolvedValueOnce({ count: 3 });
      const handler = await loadHandler();
      await expect(handler()).resolves.toBeUndefined();
      expect(mockDb.invitation.deleteMany).toHaveBeenCalledWith({
        where: { expiresAt: { lte: expect.any(Date) }, usedAt: null },
      });
    });

    it("purges DB rows even when a media row has no S3 keys (pre-transcode video)", async () => {
      mockDb.mediaFile.findMany.mockResolvedValueOnce([
        { id: "m1", originalKey: null, thumbnailKey: null, optimizedKey: null },
      ]);
      mockDb.mediaFile.deleteMany.mockResolvedValueOnce({ count: 1 });

      const handler = await loadHandler();
      await handler();

      const deleteCalls = mockS3Send.mock.calls
        .map((c: any[]) => c[0]?.input)
        .filter((i: any) => i?.Delete);
      expect(deleteCalls).toHaveLength(0);
      expect(mockDb.mediaFile.deleteMany).toHaveBeenCalled();
    });

    it("reports age-tier transitions when they occur", async () => {
      const ageTier = await import("../../../src/lib/age-tier-transition.js");
      vi.mocked(ageTier.checkAgeTierTransitions).mockResolvedValueOnce({
        transitioned: 2,
        errors: 0,
      } as any);
      const handler = await loadHandler();
      await expect(handler()).resolves.toBeUndefined();
      expect(ageTier.checkAgeTierTransitions).toHaveBeenCalled();
    });

    it("creates sentiment-digest notifications for users with reactions, skips users without a personal tenant, and survives a per-user failure", async () => {
      const digest = await import("../../../src/lib/sentiment-digest.js");
      const { NotificationHandler } = await import("../../../src/lib/notification-handler.js");
      mockDb.user.findMany
        .mockResolvedValueOnce([]) // step 4: no scheduled deletions
        .mockResolvedValueOnce([
          { id: "u-with", ageTier: "ADULT", personalTenantId: "t1" },
          { id: "u-none", ageTier: "ADULT", personalTenantId: null },
          { id: "u-plain", ageTier: "ADULT", personalTenantId: "t2" },
          { id: "u-fail", ageTier: "ADULT", personalTenantId: "t3" },
        ]);
      vi.mocked(digest.generateSentimentDigest)
        .mockResolvedValueOnce({ posts: [{ sentiments: ["heart", "paw"] }] } as any)
        .mockResolvedValueOnce({ posts: [{ sentiments: [] }] } as any)
        .mockRejectedValueOnce(new Error("digest boom"));

      const handler = await loadHandler();
      await expect(handler()).resolves.toBeUndefined();

      // Digest was only generated for users WITH a personal tenant.
      expect(digest.generateSentimentDigest).toHaveBeenCalledTimes(3);
      // Notifications created for the two users with posts (named + generic copy).
      const instances = vi.mocked(NotificationHandler).mock.instances as any[];
      const created = instances.flatMap((i) => i.createNotification.mock.calls);
      expect(created).toHaveLength(2);
      expect(created[0][0]).toBe("u-with");
      expect(created[0][3]).toContain("heart");
      expect(created[1][0]).toBe("u-plain");
      expect(created[1][3]).toContain("new reactions");
    });
  });
});
