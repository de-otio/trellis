/**
 * Unit Tests: Delete Account Worker Lambda
 *
 * Tests for the SQS-triggered Lambda that handles full account deletion:
 * database records, S3 media, and Cognito identity.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockS3Send, mockSecretsManagerSend, mockCognitoSend, mockDeleteUserData, mockPrismaFindUnique } = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
  mockSecretsManagerSend: vi.fn(),
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

vi.mock("@aws-sdk/client-secrets-manager", () => {
  const SecretsManagerClient = vi.fn();
  SecretsManagerClient.prototype.send = mockSecretsManagerSend;
  return {
    SecretsManagerClient,
    GetSecretValueCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
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

    // Default: SecretsManager returns DB credentials
    mockSecretsManagerSend.mockResolvedValue({
      SecretString: JSON.stringify({ username: "test", password: "pass", host: "localhost", port: 5432, dbname: "testdb" }),
    });

    // Default: user exists
    mockPrismaFindUnique.mockResolvedValue({ email: "user@test.com" });

    // Default: deleteUserData succeeds
    mockDeleteUserData.mockResolvedValue({ posts: 1, comments: 2, entities: 0, follows: 3 });

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

  it("should perform full deletion flow: DB -> S3 -> Cognito", async () => {
    mockS3Send.mockResolvedValueOnce({
      Contents: [{ Key: "originals/user-u1/photo1.jpg" }],
      NextContinuationToken: undefined,
    });
    mockS3Send.mockResolvedValueOnce({}); // delete

    const handler = await loadHandler();
    const event = makeSQSEvent([
      { messageId: "msg-1", body: JSON.stringify({ userId: "u1" }) },
    ]);

    const result = await handler(event, {} as any, () => {});

    expect(result).toBeUndefined();
    expect(mockPrismaFindUnique).toHaveBeenCalledWith({ where: { id: "u1" }, select: { email: true } });
    expect(mockDeleteUserData).toHaveBeenCalled();
    expect(mockS3Send).toHaveBeenCalledTimes(2); // list + delete
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
    mockDeleteUserData.mockResolvedValueOnce({ posts: 0 });

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
