/**
 * Unit Tests: un-implemented stub workers must FAIL CLOSED (AR6)
 *
 * Several SQS workers shipped as stubs that logged and silently ACKED real
 * traffic (a resolved handler deletes the batch from the queue). For
 * link-check that silently disabled a live security control (Safe Browsing
 * threat-intel on posted links). Fail-closed means: the handler THROWS, the
 * batch returns to the queue, retries (maxReceiveCount 3), dead-letters,
 * and the `*-dlq-not-empty` alarm pages.
 *
 * (The fourth stub, media-reconciliation, was removed entirely along with
 * its only producer — the batch-upload MediaUploadService cas/-bypass — so
 * there is nothing left to fail closed.)
 *
 * federation-outbox is the one exception: the feature is gated off
 * (ACTIVITYPUB_ENABLED, fail-closed default). When the flag is off the
 * worker must stay INERT (no throw — nothing should be enqueueing, and with
 * federation off there is no outbound delivery to lose); when the flag is
 * on it must throw like the others.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQSEvent } from "aws-lambda";

function sqsEvent(bodies: unknown[], queueName: string): SQSEvent {
  return {
    Records: bodies.map((body, i) => ({
      messageId: `test-message-${i}`,
      receiptHandle: `receipt-handle-${i}`,
      body: JSON.stringify(body),
      attributes: {
        ApproximateReceiveCount: "1",
        SentTimestamp: "1700000000000",
        SenderId: "test-sender",
        ApproximateFirstReceiveTimestamp: "1700000000000",
      },
      messageAttributes: {},
      md5OfBody: "",
      eventSource: "aws:sqs",
      eventSourceARN: `arn:aws:sqs:eu-central-1:123456789012:${queueName}`,
      awsRegion: "eu-central-1",
    })),
  };
}

const lambdaContext = {} as never;
const noopCallback = () => undefined;

describe("stub workers fail closed (AR6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.ACTIVITYPUB_ENABLED;
  });

  describe("link-check-worker (live security control — Safe Browsing)", () => {
    it("throws on a representative link-check message instead of silently acking", async () => {
      const { handler } = await import("../../../src/lambda/link-check-worker.js");
      // Representative producer message (post-handler.ts / comment-handler.ts):
      const event = sqsEvent(
        [{ linkCheckId: "lc_123", url: "https://example.com/some/path", domain: "example.com" }],
        "dev-link-check",
      );

      await expect(handler(event, lambdaContext, noopCallback)).rejects.toThrow(
        /link-check-worker: not implemented/,
      );
    });

    it("throws for multi-record batches too (whole batch must retry)", async () => {
      const { handler } = await import("../../../src/lambda/link-check-worker.js");
      const event = sqsEvent(
        [
          { linkCheckId: "lc_1", url: "https://a.example/x", domain: "a.example" },
          { linkCheckId: "lc_2", url: "https://b.example/y", domain: "b.example" },
        ],
        "dev-link-check",
      );

      await expect(handler(event, lambdaContext, noopCallback)).rejects.toThrow();
    });
  });

  describe("followers-events-worker", () => {
    it("throws on a representative followers event instead of silently acking", async () => {
      const { handler } = await import("../../../src/lambda/followers-events-worker.js");
      const event = sqsEvent(
        [{ eventType: "FOLLOWED", followerId: "user_1", followeeId: "entity_9" }],
        "dev-followers-events",
      );

      await expect(handler(event, lambdaContext, noopCallback)).rejects.toThrow(
        /followers-events-worker: not implemented/,
      );
    });
  });

  describe("federation-outbox-worker (feature-gated)", () => {
    const activityBody = {
      activityId: "https://social.example/activities/1",
      actorId: "https://social.example/actors/dog",
      type: "Create",
    };

    it("stays inert (no throw) when ACTIVITYPUB_ENABLED is not set", async () => {
      const { handler } = await import("../../../src/lambda/federation-outbox-worker.js");
      const event = sqsEvent([activityBody], "dev-federation-outbox");

      await expect(handler(event, lambdaContext, noopCallback)).resolves.toBeUndefined();
    });

    it("stays inert (no throw) when ACTIVITYPUB_ENABLED is explicitly not 'true'", async () => {
      process.env.ACTIVITYPUB_ENABLED = "false";
      const { handler } = await import("../../../src/lambda/federation-outbox-worker.js");
      const event = sqsEvent([activityBody], "dev-federation-outbox");

      await expect(handler(event, lambdaContext, noopCallback)).resolves.toBeUndefined();
    });

    it("throws (fail closed) when the federation feature IS enabled", async () => {
      process.env.ACTIVITYPUB_ENABLED = "true";
      const { handler } = await import("../../../src/lambda/federation-outbox-worker.js");
      const event = sqsEvent([activityBody], "dev-federation-outbox");

      await expect(handler(event, lambdaContext, noopCallback)).rejects.toThrow(
        /federation-outbox-worker: not implemented/,
      );
    });
  });
});
