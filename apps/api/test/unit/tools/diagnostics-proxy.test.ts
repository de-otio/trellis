import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDynamoSend, mockAgentSend } = vi.hoisted(() => {
  process.env.STAGE = "dev";
  process.env.DYNAMODB_TABLE = "dev-trellis";
  process.env.AWS_REGION = "us-east-1";
  process.env.RUNTIME_ID = "test-runtime";
  process.env.MAX_DAILY_INVOCATIONS = "50";
  process.env.COOLDOWN_SECONDS = "300";
  return { mockDynamoSend: vi.fn(), mockAgentSend: vi.fn() };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {
    send = mockDynamoSend;
  },
  PutItemCommand: class {
    _type = "PutItemCommand";
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  UpdateItemCommand: class {
    _type = "UpdateItemCommand";
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
}));

vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: class {
    send = mockAgentSend;
  },
  InvokeAgentCommand: class {
    _type = "InvokeAgentCommand";
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
}));

// Set env vars before importing so module-level constants capture them
process.env.STAGE = "dev";
process.env.DYNAMODB_TABLE = "dev-trellis";
process.env.AWS_REGION = "us-east-1";
process.env.RUNTIME_ID = "test-runtime";
process.env.MAX_DAILY_INVOCATIONS = "50";
process.env.COOLDOWN_SECONDS = "300";

import { handler } from "../../../src/lambda/diagnostics-proxy.js";

function makeSnsEvent(
  messageBody: Record<string, unknown> | string,
): { Records: any[] } {
  const message =
    typeof messageBody === "string"
      ? messageBody
      : JSON.stringify(messageBody);
  return {
    Records: [{ Sns: { Message: message } }],
  };
}

describe("diagnostics-proxy handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ALARM state triggers diagnostics invocation", async () => {
    mockDynamoSend.mockImplementation((cmd: any) => {
      if (cmd._type === "PutItemCommand") {
        return Promise.resolve({});
      }
      if (cmd._type === "UpdateItemCommand") {
        return Promise.resolve({
          Attributes: { count: { N: "1" } },
        });
      }
      return Promise.resolve({});
    });
    mockAgentSend.mockResolvedValueOnce({});

    const event = makeSnsEvent({
      NewStateValue: "ALARM",
      AlarmName: "high-cpu",
      AlarmDescription: "CPU over 90%",
      NewStateReason: "Threshold exceeded",
      StateChangeTime: "2026-03-18T10:00:00Z",
      Trigger: { MetricName: "CPUUtilization" },
    });

    const result = await handler(event);

    expect(result).toEqual({ processed: 1 });
    expect(mockAgentSend).toHaveBeenCalledOnce();
    const agentCmd = mockAgentSend.mock.calls[0][0];
    expect(agentCmd.input.agentId).toBe("test-runtime");
    expect(agentCmd.input.agentAliasId).toBe("TSTALIASID");
    expect(agentCmd.input.inputText).toContain("high-cpu");
  });

  it("OK state is skipped (no invocation)", async () => {
    const event = makeSnsEvent({
      NewStateValue: "OK",
      AlarmName: "high-cpu",
    });

    const result = await handler(event);

    expect(result).toEqual({ processed: 1 });
    expect(mockDynamoSend).not.toHaveBeenCalled();
    expect(mockAgentSend).not.toHaveBeenCalled();
  });

  it("INSUFFICIENT_DATA state is skipped", async () => {
    const event = makeSnsEvent({
      NewStateValue: "INSUFFICIENT_DATA",
      AlarmName: "high-cpu",
    });

    const result = await handler(event);

    expect(result).toEqual({ processed: 1 });
    expect(mockAgentSend).not.toHaveBeenCalled();
  });

  it("alarm in cooldown is skipped (ConditionalCheckFailedException)", async () => {
    mockDynamoSend.mockRejectedValueOnce(
      Object.assign(new Error("Condition not met"), {
        name: "ConditionalCheckFailedException",
      }),
    );

    const event = makeSnsEvent({
      NewStateValue: "ALARM",
      AlarmName: "high-cpu",
    });

    const result = await handler(event);

    expect(result).toEqual({ processed: 1 });
    expect(mockAgentSend).not.toHaveBeenCalled();
  });

  it("daily cap exceeded is skipped", async () => {
    mockDynamoSend.mockImplementation((cmd: any) => {
      if (cmd._type === "PutItemCommand") {
        return Promise.resolve({});
      }
      if (cmd._type === "UpdateItemCommand") {
        return Promise.resolve({
          Attributes: { count: { N: "51" } },
        });
      }
      return Promise.resolve({});
    });

    const event = makeSnsEvent({
      NewStateValue: "ALARM",
      AlarmName: "high-cpu",
    });

    const result = await handler(event);

    expect(result).toEqual({ processed: 1 });
    expect(mockAgentSend).not.toHaveBeenCalled();
  });

  it("alarm name is sanitized (truncated, non-printable stripped)", async () => {
    mockDynamoSend.mockImplementation((cmd: any) => {
      if (cmd._type === "PutItemCommand") {
        return Promise.resolve({});
      }
      if (cmd._type === "UpdateItemCommand") {
        return Promise.resolve({
          Attributes: { count: { N: "1" } },
        });
      }
      return Promise.resolve({});
    });
    mockAgentSend.mockResolvedValueOnce({});

    const longName = "A".repeat(300) + "\x00\x01\x02";
    const event = makeSnsEvent({
      NewStateValue: "ALARM",
      AlarmName: longName,
    });

    await handler(event);

    // The cooldown PutItem should have the sanitized name (256 chars, no non-printable)
    const putCmd = mockDynamoSend.mock.calls.find(
      (c: any) => c[0]._type === "PutItemCommand",
    );
    expect(putCmd).toBeDefined();
    const pk = putCmd![0].input.Item.pk.S;
    const sanitizedName = pk.replace("diag-cooldown:", "");
    expect(sanitizedName).toHaveLength(256);
    expect(sanitizedName).toBe("A".repeat(256));
  });

  it("non-JSON SNS message is skipped", async () => {
    const event = {
      Records: [{ Sns: { Message: "this is not valid JSON" } }],
    };

    const result = await handler(event);

    expect(result).toEqual({ processed: 1 });
    expect(mockDynamoSend).not.toHaveBeenCalled();
    expect(mockAgentSend).not.toHaveBeenCalled();
  });

  it("DynamoDB error propagates", async () => {
    mockDynamoSend.mockRejectedValueOnce(
      new Error("Internal server error"),
    );

    const event = makeSnsEvent({
      NewStateValue: "ALARM",
      AlarmName: "high-cpu",
    });

    await expect(handler(event)).rejects.toThrow("Internal server error");
  });
});
