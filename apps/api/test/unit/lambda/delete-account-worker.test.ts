/**
 * Unit Tests: Delete Account Worker Lambda
 *
 * Tests for the SQS-triggered Lambda that handles full account deletion:
 * database records, S3 media, and Cognito identity.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockS3Send, mockGetSecret, mockCognitoSend, mockDeleteUserData, mockPrismaFindUnique } = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
  mockGetSecret: vi.fn(),
  mockCognitoSend: vi.fn(),
  mockDeleteUserData: vi.fn(),
  mockPrismaFindUnique: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => {
  const S3Client = vi.fn();
  S3Client.prototype.send = mockS3Send;
  return {
    S3Client,
    DeleteObjectsCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
    ListObjectsV2Command: vi.fn(function (this: any, input: any) { this.input = input; }),
  };
});

vi.mock("@aws-lambda-powertools/parameters/secrets", () => ({
  getSecret: mockGetSecret,
}));

vi.mock("@aws-sdk/client-cognito-identity-provider", () => {
  const CognitoIdentityProviderClient = vi.fn();
  CognitoIdentityProviderClient.prototype.send = mockCognitoSend;
  return {
    CognitoIdentityProviderClient,
    AdminDeleteUserCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
  };
});

vi.mock("@prisma/client", () => {
  return {
    PrismaClient: class {
      user = { findUnique: mockPrismaFindUnique };
      constructor() {}
    },
  };
});

vi.mock("../../../src/lib/services/user-data-deletion", () => ({
  deleteUserData: mockDeleteUserData,
}));

describe("DeleteAccountWorker Lambda", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.AWS_REGION = "us-east-1";
    process.env.MEDIA_BUCKET_NAME = "test-media-bucket";
    process.env.DB_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123:secret:db";
    process.env.COGNITO_USER_POOL_ID = "us-east-1_TestPool";

    // Default: getSecret returns DB credentials (json-transformed)
    mockGetSecret.mockResolvedValue({ username: "test", password: "pass", host: "localhost", port: 5432, dbname: "testdb" });

    // Default: user exists
    mockPrismaFindUnique.mockResolvedValue({ email: "user@test.com" });

    // Default: deleteUserData succeeds (AR7: media erasure happens inside it
    // and reports the staging keys the worker must delete from S3)
    mockDeleteUserData.mockResolvedValue({
      posts: 1, comments: 2, entities: 0, follows: 3,
      mediaFilesErased: 0, mediaFilesRetainedShared: 0, mediaStagingKeys: [],
    });

    // Default: S3 returns no objects
    mockS3Send.mockResolvedValue({ Contents: undefined, NextContinuationToken: undefined });

    // Default: Cognito delete succeeds
    mockCognitoSend.mockResolvedValue({});
  });

  async function loadHandler() {
    const mod = await import("../../../src/lambda/delete-account-worker.js");
    return mod.handler;
  }

  function makeSQSEvent(records: Array<{ messageId: string; body: string }>) {
    return {
      Records: records.map((r) => ({
        messageId: r.messageId,
        body: r.body,
        receiptHandle: "receipt-handle",
        attributes: {},
        messageAttributes: {},
        md5OfBody: "",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:us-east-1:123456:test-queue",
        awsRegion: "us-east-1",
      })),
    } as any;
  }

  it("should perform full deletion flow: DB -> S3 staging cleanup -> Cognito", async () => {
    // deleteUserData erased the media rows and reports one staging key for
    // the worker to delete from S3 (AR7).
    mockDeleteUserData.mockResolvedValueOnce({
      posts: 1, comments: 2, entities: 0, follows: 3,
      mediaFilesErased: 1, mediaFilesRetainedShared: 0,
      mediaStagingKeys: [`processing/cabcdefghijklmnopqrstuvwx/${"a".repeat(64)}`],
    });
    mockS3Send.mockResolvedValueOnce({}); // staging batch delete

    const handler = await loadHandler();
    const event = makeSQSEvent([
      { messageId: "msg-1", body: JSON.stringify({ userId: "u1" }) },
    ]);

    const result = await handler(event, {} as any, () => {});

    expect(result).toBeUndefined();
    expect(mockPrismaFindUnique).toHaveBeenCalledWith({ where: { id: "u1" }, select: { email: true } });
    expect(mockDeleteUserData).toHaveBeenCalled();
    expect(mockS3Send).toHaveBeenCalledTimes(1); // one DeleteObjects batch
    expect(mockCognitoSend).toHaveBeenCalled();
  });

  it("should skip deletion if user not found", async () => {
    mockPrismaFindUnique.mockResolvedValueOnce(null);

    const handler = await loadHandler();
    const event = makeSQSEvent([
      { messageId: "msg-1", body: JSON.stringify({ userId: "gone" }) },
    ]);

    const result = await handler(event, {} as any, () => {});

    expect(result).toBeUndefined();
    expect(mockDeleteUserData).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });

  it("should return batchItemFailures for records that fail", async () => {
    // First record succeeds
    mockPrismaFindUnique.mockResolvedValueOnce({ email: "user1@test.com" });
    mockDeleteUserData.mockResolvedValueOnce({ posts: 0, mediaStagingKeys: [] });

    // Second record: deleteUserData fails
    mockPrismaFindUnique.mockResolvedValueOnce({ email: "user2@test.com" });
    mockDeleteUserData.mockRejectedValueOnce(new Error("DB connection lost"));

    const handler = await loadHandler();
    const event = makeSQSEvent([
      { messageId: "msg-1", body: JSON.stringify({ userId: "u1" }) },
      { messageId: "msg-2", body: JSON.stringify({ userId: "u2" }) },
    ]);

    const result: any = await handler(event, {} as any, () => {});

    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe("msg-2");
  });

  it("should handle invalid JSON in message body", async () => {
    const handler = await loadHandler();
    const event = makeSQSEvent([
      { messageId: "msg-bad", body: "not json" },
    ]);

    const result: any = await handler(event, {} as any, () => {});

    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe("msg-bad");
  });

  // ── AR7: GDPR media erasure — the CAS key scheme ──────────────────────────
  // The user's media lives under `cas/{tenantId}/{hash}` (approved bytes),
  // `processing/{tenantId}/{hash}` and `pending/{tenantId}/{uploadId}`
  // (staging). The old code enumerated the obsolete `originals/user-{id}/`
  // prefix, which matches NOTHING under the CAS scheme — so account deletion
  // removed zero media bytes (GDPR erasure gap).
  describe("GDPR media erasure (AR7)", () => {
    const TENANT = "cabcdefghijklmnopqrstuvwx";
    const HASH = "a".repeat(64);
    const UPLOAD_ID = "cupload00000000000000001x";
    const PROCESSING_KEY = `processing/${TENANT}/${HASH}`;
    const PENDING_KEY = `pending/${TENANT}/${UPLOAD_ID}`;
    const CAS_KEY = `cas/${TENANT}/${HASH}`;

    let fakeBucket: Set<string>;

    beforeEach(() => {
      // Simulated S3 bucket holding the user's media under CAS-scheme keys.
      fakeBucket = new Set([PROCESSING_KEY, PENDING_KEY, CAS_KEY]);
      // mockReset (not clear): drop any mockResolvedValueOnce queue left by
      // earlier tests, so the simulated bucket sees every send.
      mockS3Send.mockReset();
      mockS3Send.mockImplementation(async (cmd: any) => {
        const input = cmd?.input ?? {};
        if (input.Delete) {
          for (const o of input.Delete.Objects) fakeBucket.delete(o.Key);
          return {};
        }
        if (input.Prefix !== undefined) {
          const keys = [...fakeBucket].filter((k) => k.startsWith(input.Prefix));
          return {
            Contents: keys.length ? keys.map((Key) => ({ Key })) : undefined,
            NextContinuationToken: undefined,
          };
        }
        return {};
      });
      // deleteUserData reports the user-scoped staging keys it computed while
      // erasing the MediaFile rows.
      mockDeleteUserData.mockResolvedValue({
        posts: 1,
        comments: 0,
        entities: 0,
        mediaFilesErased: 1,
        mediaFilesRetainedShared: 0,
        mediaStagingKeys: [PROCESSING_KEY, PENDING_KEY],
      });
    });

    it("deletes the user-scoped staging objects under the CAS key scheme", async () => {
      const handler = await loadHandler();
      const event = makeSQSEvent([
        { messageId: "msg-1", body: JSON.stringify({ userId: "u1" }) },
      ]);

      const result = await handler(event, {} as any, () => {});

      expect(result).toBeUndefined();
      // The staging objects the worker CAN delete must be gone.
      expect(fakeBucket.has(PROCESSING_KEY)).toBe(false);
      expect(fakeBucket.has(PENDING_KEY)).toBe(false);
    });

    it("never deletes cas/ objects directly — byte reclamation goes through the GC purge (nightly soft-deleted-media sweep)", async () => {
      const handler = await loadHandler();
      const event = makeSQSEvent([
        { messageId: "msg-1", body: JSON.stringify({ userId: "u1" }) },
      ]);

      await handler(event, {} as any, () => {});

      // cas/ is reclaimed by the existing GC path once the soft-deleted row
      // ages out — the worker must not race it (and by design the media
      // prefix cas/* is IAM-immutable to the media workers).
      expect(fakeBucket.has(CAS_KEY)).toBe(true);
    });
  });

  it("should continue if Cognito deletion fails", async () => {
    mockCognitoSend.mockRejectedValueOnce(new Error("UserNotFoundException"));

    const handler = await loadHandler();
    const event = makeSQSEvent([
      { messageId: "msg-1", body: JSON.stringify({ userId: "u1" }) },
    ]);

    const result = await handler(event, {} as any, () => {});

    // Should succeed despite Cognito failure
    expect(result).toBeUndefined();
    expect(mockDeleteUserData).toHaveBeenCalled();
  });
});
