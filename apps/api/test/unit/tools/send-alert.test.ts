import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSend } = vi.hoisted(() => {
  // Set env vars early so module-level constants capture them
  process.env.STAGE = "dev";
  process.env.DYNAMODB_TABLE = "dev-trellis";
  process.env.AWS_REGION = "us-east-1";
  process.env.ALERT_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789:test-topic";
  return { mockSend: vi.fn() };
});

vi.mock("@aws-sdk/client-sns", () => ({
  SNSClient: class {
    send = mockSend;
  },
  PublishCommand: class {
    _type = "PublishCommand";
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
}));

import { handler } from "../../../src/lambda/tools/send-alert.js";

describe("send-alert handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes with correct TopicArn, Subject, Message", async () => {
    mockSend.mockResolvedValueOnce({ MessageId: "msg-123" });

    const result = await handler({
      subject: "Test Alert",
      message: "Something went wrong",
    });

    expect(result).toEqual({ messageId: "msg-123", sent: true });

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.TopicArn).toBe(
      "arn:aws:sns:us-east-1:123456789:test-topic",
    );
    expect(cmd.input.Subject).toBe("Test Alert");
    expect(cmd.input.Message).toBe("Something went wrong");
  });

  it("sets MessageAttributes.source to 'agent' for loop prevention", async () => {
    mockSend.mockResolvedValueOnce({ MessageId: "msg-456" });

    await handler({ subject: "Alert", message: "body" });

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.MessageAttributes).toEqual({
      source: {
        DataType: "String",
        StringValue: "agent",
      },
    });
  });

  it("truncates subject to 100 characters", async () => {
    mockSend.mockResolvedValueOnce({ MessageId: "msg-789" });
    const longSubject = "A".repeat(150);

    await handler({ subject: longSubject, message: "body" });

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.Subject).toHaveLength(100);
    expect(cmd.input.Subject).toBe("A".repeat(100));
  });

  it("throws when subject is missing", async () => {
    await expect(
      handler({ subject: "", message: "body" } as any),
    ).rejects.toThrow("subject and message are required");
  });

  it("throws when message is missing", async () => {
    await expect(
      handler({ subject: "Alert", message: "" } as any),
    ).rejects.toThrow("subject and message are required");
  });
});
