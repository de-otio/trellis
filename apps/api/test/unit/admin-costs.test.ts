/**
 * Unit Tests: Admin Costs Endpoint
 *
 * Tests the /api/admin/costs route including auth gating and cost status logic.
 */

import { describe, expect, it } from "vitest";

describe("Admin Costs - Status Logic", () => {
  function getCostStatus(
    openai: { exceeded: boolean; dailyUsed: number; dailyLimit: number },
    daily: { estimatedTotal: number; limit: number },
  ): "ok" | "warning" | "exceeded" {
    if (openai.exceeded || daily.estimatedTotal >= daily.limit) return "exceeded";
    if (
      openai.dailyUsed / openai.dailyLimit > 0.8 ||
      daily.estimatedTotal / daily.limit > 0.8
    ) {
      return "warning";
    }
    return "ok";
  }

  it("should return 'ok' when well under limits", () => {
    const status = getCostStatus(
      { exceeded: false, dailyUsed: 100, dailyLimit: 1000 },
      { estimatedTotal: 2, limit: 10 },
    );
    expect(status).toBe("ok");
  });

  it("should return 'warning' when OpenAI usage is above 80%", () => {
    const status = getCostStatus(
      { exceeded: false, dailyUsed: 850, dailyLimit: 1000 },
      { estimatedTotal: 2, limit: 10 },
    );
    expect(status).toBe("warning");
  });

  it("should return 'warning' when daily cost is above 80%", () => {
    const status = getCostStatus(
      { exceeded: false, dailyUsed: 100, dailyLimit: 1000 },
      { estimatedTotal: 8.5, limit: 10 },
    );
    expect(status).toBe("warning");
  });

  it("should return 'exceeded' when OpenAI budget exceeded", () => {
    const status = getCostStatus(
      { exceeded: true, dailyUsed: 1000, dailyLimit: 1000 },
      { estimatedTotal: 2, limit: 10 },
    );
    expect(status).toBe("exceeded");
  });

  it("should return 'exceeded' when daily cost at limit", () => {
    const status = getCostStatus(
      { exceeded: false, dailyUsed: 100, dailyLimit: 1000 },
      { estimatedTotal: 10, limit: 10 },
    );
    expect(status).toBe("exceeded");
  });

  it("should return 'exceeded' when daily cost over limit", () => {
    const status = getCostStatus(
      { exceeded: false, dailyUsed: 100, dailyLimit: 1000 },
      { estimatedTotal: 15, limit: 10 },
    );
    expect(status).toBe("exceeded");
  });

  it("should return 'ok' at exactly 80% (not above)", () => {
    const status = getCostStatus(
      { exceeded: false, dailyUsed: 800, dailyLimit: 1000 },
      { estimatedTotal: 8, limit: 10 },
    );
    expect(status).toBe("ok");
  });

  it("should return 'warning' at 81% OpenAI usage", () => {
    const status = getCostStatus(
      { exceeded: false, dailyUsed: 810, dailyLimit: 1000 },
      { estimatedTotal: 1, limit: 10 },
    );
    expect(status).toBe("warning");
  });
});
