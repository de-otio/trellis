import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSend } = vi.hoisted(() => {
  process.env.AWS_REGION = "us-east-1";
  return { mockSend: vi.fn() };
});

vi.mock("@aws-sdk/client-cost-explorer", () => ({
  CostExplorerClient: class {
    send = mockSend;
  },
  GetCostAndUsageCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
}));

import { handler } from "../../../src/lambda/tools/get-cost-report.js";

describe("get-cost-report handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STAGE = "dev";
    process.env.DYNAMODB_TABLE = "dev-trellis";
    process.env.AWS_REGION = "us-east-1";
  });

  it("returns daily totals and byService sorted by cost desc", async () => {
    mockSend.mockResolvedValueOnce({
      ResultsByTime: [
        {
          TimePeriod: { Start: "2026-03-15" },
          Groups: [
            {
              Keys: ["Amazon EC2"],
              Metrics: { UnblendedCost: { Amount: "5.50", Unit: "USD" } },
            },
            {
              Keys: ["Amazon S3"],
              Metrics: { UnblendedCost: { Amount: "2.25", Unit: "USD" } },
            },
          ],
        },
        {
          TimePeriod: { Start: "2026-03-16" },
          Groups: [
            {
              Keys: ["Amazon EC2"],
              Metrics: { UnblendedCost: { Amount: "6.00", Unit: "USD" } },
            },
            {
              Keys: ["Amazon RDS"],
              Metrics: { UnblendedCost: { Amount: "3.10", Unit: "USD" } },
            },
          ],
        },
      ],
    });

    const result = await handler({ days: 2 });

    expect(result.dailyTotals).toEqual([
      { date: "2026-03-15", cost: 7.75 },
      { date: "2026-03-16", cost: 9.1 },
    ]);
    expect(result.totalCost).toBe(16.85);
    expect(result.currency).toBe("USD");
    expect(result.days).toBe(2);

    // Sorted descending by cost
    expect(result.byService[0].service).toBe("Amazon EC2");
    expect(result.byService[0].cost).toBe(11.5);
    expect(result.byService[1].service).toBe("Amazon RDS");
    expect(result.byService[2].service).toBe("Amazon S3");
  });

  it("caps days at 30 and floors at 1", async () => {
    mockSend.mockResolvedValue({ ResultsByTime: [] });

    const overResult = await handler({ days: 100 });
    expect(overResult.days).toBe(30);

    const underResult = await handler({ days: -5 });
    expect(underResult.days).toBe(1);
  });

  it("defaults to 7 days when no event.days", async () => {
    mockSend.mockResolvedValue({ ResultsByTime: [] });

    const result = await handler({});

    expect(result.days).toBe(7);
  });

  it("returns zero totals for empty ResultsByTime", async () => {
    mockSend.mockResolvedValueOnce({ ResultsByTime: [] });

    const result = await handler({ days: 3 });

    expect(result.totalCost).toBe(0);
    expect(result.dailyTotals).toEqual([]);
    expect(result.byService).toEqual([]);
    expect(result.currency).toBe("USD");
  });
});
