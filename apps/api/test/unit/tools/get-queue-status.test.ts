import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSend } = vi.hoisted(() => {
  process.env.STAGE = "dev";
  process.env.AWS_REGION = "us-east-1";
  return { mockSend: vi.fn() };
});

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class {
    send = mockSend;
  },
  GetQueueUrlCommand: class {
    _type = "GetQueueUrlCommand";
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  GetQueueAttributesCommand: class {
    _type = "GetQueueAttributesCommand";
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
}));

import { handler } from "../../../src/lambda/tools/get-queue-status.js";

describe("get-queue-status handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STAGE = "dev";
    process.env.DYNAMODB_TABLE = "dev-trellis";
    process.env.AWS_REGION = "us-east-1";
  });

  const QUEUE_NAMES = [
    "delete-account",
    "media-processing",
    "media-reconciliation",
    "link-check",
    "followers-events",
  ];

  it("returns status for all 5 queues with DLQ depth", async () => {
    mockSend.mockImplementation((cmd: any) => {
      if (cmd._type === "GetQueueUrlCommand") {
        return Promise.resolve({
          QueueUrl: `https://sqs.us-east-1.amazonaws.com/123/${cmd.input.QueueName}`,
        });
      }
      if (cmd._type === "GetQueueAttributesCommand") {
        const isDlq = cmd.input.QueueUrl?.includes("-dlq");
        return Promise.resolve({
          Attributes: {
            ApproximateNumberOfMessages: isDlq ? "3" : "10",
            ApproximateNumberOfMessagesNotVisible: isDlq ? "0" : "2",
          },
        });
      }
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result.queues).toHaveLength(5);

    for (const q of result.queues) {
      expect(QUEUE_NAMES).toContain(q.name);
      expect(q.visible).toBe(10);
      expect(q.inFlight).toBe(2);
      expect(q.dlqDepth).toBe(3);
    }
  });

  it("propagates error when queue is not found", async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error("Queue not found"), {
        name: "QueueDoesNotExist",
      }),
    );

    await expect(handler()).rejects.toThrow("Queue not found");
  });
});
