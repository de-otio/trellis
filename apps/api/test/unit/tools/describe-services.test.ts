/**
 * Unit Tests: describe-services tool Lambda
 *
 * Tests ECS service description, including deployments, events,
 * service-not-found, and graceful handling of missing data.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSend } = vi.hoisted(() => {
  process.env.STAGE = "dev";
  process.env.DYNAMODB_TABLE = "dev-trellis";
  process.env.AWS_REGION = "us-east-1";
  return { mockSend: vi.fn() };
});

vi.mock("@aws-sdk/client-ecs", () => ({
  ECSClient: class {
    send = mockSend;
  },
  DescribeServicesCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
}));

import { handler } from "../../../src/lambda/tools/describe-services.js";

describe("describe-services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns service details with deployments and lastEvent", async () => {
    const createdAt = new Date("2026-03-18T10:00:00Z");
    const eventDate = new Date("2026-03-18T10:05:00Z");

    mockSend.mockResolvedValueOnce({
      services: [
        {
          serviceName: "trellis-dev-api",
          status: "ACTIVE",
          runningCount: 2,
          desiredCount: 2,
          deployments: [
            {
              id: "deploy-1",
              status: "PRIMARY",
              runningCount: 2,
              desiredCount: 2,
              taskDefinition: "arn:aws:ecs:us-east-1:123:task-definition/trellis-dev-api:42",
              rolloutState: "COMPLETED",
              createdAt,
            },
          ],
          events: [
            {
              message: "service trellis-dev-api has reached a steady state.",
              createdAt: eventDate,
            },
          ],
        },
      ],
    });

    const result = await handler();

    expect(result.serviceName).toBe("trellis-dev-api");
    expect(result.status).toBe("ACTIVE");
    expect(result.runningCount).toBe(2);
    expect(result.desiredCount).toBe(2);
    expect(result.deployments).toHaveLength(1);
    expect(result.deployments![0]).toEqual({
      id: "deploy-1",
      status: "PRIMARY",
      runningCount: 2,
      desiredCount: 2,
      taskDefinition: "arn:aws:ecs:us-east-1:123:task-definition/trellis-dev-api:42",
      rolloutState: "COMPLETED",
      createdAt: "2026-03-18T10:00:00.000Z",
    });
    expect(result.lastEvent).toEqual({
      message: "service trellis-dev-api has reached a steady state.",
      createdAt: "2026-03-18T10:05:00.000Z",
    });

    // Verify correct cluster and service were queried
    const callInput = mockSend.mock.calls[0][0].input;
    expect(callInput.cluster).toBe("trellis-dev");
    expect(callInput.services).toEqual(["trellis-dev-api"]);
  });

  it("throws when service is not found", async () => {
    mockSend.mockResolvedValueOnce({ services: [] });

    await expect(handler()).rejects.toThrow(
      "Service trellis-dev-api not found in cluster trellis-dev",
    );
  });

  it("handles empty deployments and events gracefully", async () => {
    mockSend.mockResolvedValueOnce({
      services: [
        {
          serviceName: "trellis-dev-api",
          status: "ACTIVE",
          runningCount: 0,
          desiredCount: 1,
          deployments: [],
          events: [],
        },
      ],
    });

    const result = await handler();

    expect(result.deployments).toEqual([]);
    expect(result.lastEvent).toBeNull();
  });
});
