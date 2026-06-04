/**
 * Unit Tests: Media Processing Worker Lambda
 *
 * Tests for the SQS-triggered Lambda that processes uploaded images
 * (resize to thumbnail + optimized) and stores results in S3.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockS3Send, mockSharp } = vi.hoisted(() => {
  const mockSharpInstance = {
    resize: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from("processed-image")),
  };
  return {
    mockS3Send: vi.fn(),
    mockSharp: vi.fn(() => mockSharpInstance),
  };
});

vi.mock("@aws-sdk/client-s3", () => {
  const S3Client = vi.fn();
  S3Client.prototype.send = mockS3Send;
  return {
    S3Client,
    GetObjectCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
    PutObjectCommand: vi.fn(function (this: any, input: any) { this.input = input; }),
  };
});

vi.mock("sharp", () => ({
  default: mockSharp,
}));

describe("MediaProcessingWorker Lambda", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.AWS_REGION = "us-east-1";
  });

  async function loadHandler() {
    const mod = await import("../../../src/lambda/media-processing-worker.js");
    return mod.handler;
  }

  function makeAsyncIterable(buffer: Buffer): AsyncIterable<Uint8Array> {
    return {
      [Symbol.asyncIterator]() {
        let done = false;
        return {
          async next() {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: new Uint8Array(buffer) };
          },
        };
      },
    };
  }

  function makeSQSEvent(s3Records: Array<{ bucket: string; key: string }>) {
    return {
      Records: s3Records.map((r, i) => ({
        messageId: `msg-${i}`,
        body: JSON.stringify({
          Records: [
            {
              s3: {
                bucket: { name: r.bucket },
                object: { key: encodeURIComponent(r.key).replace(/%2F/g, "/") },
              },
            },
          ],
        }),
        receiptHandle: "receipt",
        attributes: {},
        messageAttributes: {},
        md5OfBody: "",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:us-east-1:123456:test-queue",
        awsRegion: "us-east-1",
      })),
    } as any;
  }

  it("should process an image: create thumbnail and optimized versions", async () => {
    const imageBuffer = Buffer.from("fake-image-data");
    mockS3Send
      .mockResolvedValueOnce({ Body: makeAsyncIterable(imageBuffer) }) // GetObject
      .mockResolvedValueOnce({}) // PutObject (thumbnail)
      .mockResolvedValueOnce({}); // PutObject (optimized)

    const handler = await loadHandler();
    const event = makeSQSEvent([
      { bucket: "media-bucket", key: "originals/user-123/photo.jpg" },
    ]);

    const result = await handler(event, {} as any, () => {});

    expect(result).toBeUndefined(); // no failures
    // GetObject + 2x PutObject (thumbnail + optimized via Promise.all)
    expect(mockS3Send).toHaveBeenCalledTimes(3);
    // sharp should have been called for processing
    expect(mockSharp).toHaveBeenCalled();
  });

  it("should skip non-originals keys", async () => {
    const handler = await loadHandler();
    const event = makeSQSEvent([
      { bucket: "media-bucket", key: "thumbnails/user-123/photo.webp" },
    ]);

    const result = await handler(event, {} as any, () => {});

    expect(result).toBeUndefined();
    // Should not have called S3 GetObject since the key doesn't start with originals/
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it("should return batchItemFailures when S3 GetObject fails", async () => {
    mockS3Send.mockRejectedValueOnce(new Error("S3 GetObject failed"));

    const handler = await loadHandler();
    const event = makeSQSEvent([
      { bucket: "media-bucket", key: "originals/user-456/img.png" },
    ]);

    const result: any = await handler(event, {} as any, () => {});

    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe("msg-0");
  });

  it("should return batchItemFailures when sharp processing fails", async () => {
    const imageBuffer = Buffer.from("corrupt-image");
    mockS3Send.mockResolvedValueOnce({ Body: makeAsyncIterable(imageBuffer) });

    // Make sharp throw
    const sharpInstance = mockSharp();
    sharpInstance.toBuffer.mockRejectedValueOnce(new Error("Invalid image"));
    // Reset the sharp mock to use the failing instance
    mockSharp.mockReturnValueOnce(sharpInstance);

    const handler = await loadHandler();
    const event = makeSQSEvent([
      { bucket: "media-bucket", key: "originals/user-789/bad.jpg" },
    ]);

    const result: any = await handler(event, {} as any, () => {});

    expect(result.batchItemFailures).toHaveLength(1);
  });

  it("should handle multiple records with partial failures", async () => {
    const imageBuffer = Buffer.from("image-data");
    // First record succeeds
    mockS3Send
      .mockResolvedValueOnce({ Body: makeAsyncIterable(imageBuffer) })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    // Second record fails
    mockS3Send.mockRejectedValueOnce(new Error("S3 error"));

    const handler = await loadHandler();
    const event = makeSQSEvent([
      { bucket: "media-bucket", key: "originals/user-1/ok.jpg" },
      { bucket: "media-bucket", key: "originals/user-2/fail.jpg" },
    ]);

    const result: any = await handler(event, {} as any, () => {});

    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe("msg-1");
  });

  it("should handle S3 event with no Records array in body", async () => {
    const event = {
      Records: [
        {
          messageId: "msg-0",
          body: JSON.stringify({}), // no Records field
          receiptHandle: "receipt",
          attributes: {},
          messageAttributes: {},
          md5OfBody: "",
          eventSource: "aws:sqs",
          eventSourceARN: "arn:aws:sqs:us-east-1:123456:test-queue",
          awsRegion: "us-east-1",
        },
      ],
    } as any;

    const handler = await loadHandler();
    const result = await handler(event, {} as any, () => {});

    // Empty Records array means nothing to process — no failures
    expect(result).toBeUndefined();
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});
