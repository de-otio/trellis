/**
 * Unit Tests: Scaling Health
 *
 * Tests the evaluateScalingHealth function with various infrastructure configurations.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock CloudWatch before importing the module
const mockCloudWatchSend = vi.fn();
vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: class {
    send = mockCloudWatchSend;
  },
  GetMetricDataCommand: class {
    constructor(public input: any) {}
  },
}));

import { evaluateScalingHealth } from "../../src/lib/scaling-health.js";

describe("evaluateScalingHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: CloudWatch returns no data
    mockCloudWatchSend.mockResolvedValue({ MetricDataResults: [] });
  });

  describe("Phase 0 detection (per-request pool)", () => {
    it("should detect per-request pool as action-needed", async () => {
      const result = await evaluateScalingHealth(
        { STAGE: "dev", AWS_REGION: "eu-central-1", DATABASE_POOL_MAX: "1" },
        10,
        5,
      );

      expect(result.currentPhase).toBe(0);
      expect(result.phaseName).toBe("Fix Connection Pool");
      expect(result.overallStatus).toBe("action-needed");
      expect(result.infrastructure.poolConnectionModel).toBe("per-request");
      expect(result.infrastructure.poolMaxPerTask).toBe(1);

      const poolIndicator = result.indicators.find(
        (i) => i.name === "Connection Pool",
      );
      expect(poolIndicator?.status).toBe("red");
      expect(
        result.recommendations.some((r) => r.includes("Phase 0")),
      ).toBe(true);
    });

    it("should detect singleton pool as healthy", async () => {
      const result = await evaluateScalingHealth(
        { STAGE: "dev", AWS_REGION: "eu-central-1", DATABASE_POOL_MAX: "10" },
        10,
        5,
      );

      expect(result.infrastructure.poolConnectionModel).toBe("singleton");
      expect(result.infrastructure.poolMaxPerTask).toBe(10);

      const poolIndicator = result.indicators.find(
        (i) => i.name === "Connection Pool",
      );
      expect(poolIndicator?.status).toBe("green");
    });
  });

  describe("infrastructure detection by stage", () => {
    it("should use dev config for dev stage", async () => {
      const result = await evaluateScalingHealth(
        { STAGE: "dev", DATABASE_POOL_MAX: "10" },
        50,
        10,
      );

      expect(result.infrastructure.rdsInstance).toBe("db.t4g.micro");
      expect(result.infrastructure.rdsMaxConnections).toBe(112);
      expect(result.infrastructure.ecsMaxTasks).toBe(2);
      expect(result.infrastructure.ecsTaskCount).toBe(1);
    });

    it("should use prod config for prod stage", async () => {
      const result = await evaluateScalingHealth(
        { STAGE: "prod", DATABASE_POOL_MAX: "15" },
        500,
        100,
      );

      expect(result.infrastructure.rdsInstance).toBe("db.t4g.micro");
      expect(result.infrastructure.rdsMaxConnections).toBe(112);
      expect(result.infrastructure.ecsMaxTasks).toBe(4);
      expect(result.infrastructure.ecsTaskCount).toBe(2);
    });
  });

  describe("CloudWatch metrics integration", () => {
    it("should report RDS CPU as red when above 80%", async () => {
      mockCloudWatchSend.mockResolvedValue({
        MetricDataResults: [
          { Id: "cpu", Values: [85.5] },
          { Id: "connections", Values: [20] },
          { Id: "freemem", Values: [500 * 1024 * 1024] },
        ],
      });

      const result = await evaluateScalingHealth(
        { STAGE: "dev", AWS_REGION: "eu-central-1", DATABASE_POOL_MAX: "10" },
        100,
        30,
      );

      const cpuIndicator = result.indicators.find(
        (i) => i.name === "RDS CPU",
      );
      expect(cpuIndicator).toBeDefined();
      expect(cpuIndicator?.status).toBe("red");
      expect(cpuIndicator?.value).toBe(85.5);
      expect(
        result.recommendations.some((r) => r.includes("Upsize RDS")),
      ).toBe(true);
    });

    it("should report RDS CPU as green when below 60%", async () => {
      mockCloudWatchSend.mockResolvedValue({
        MetricDataResults: [
          { Id: "cpu", Values: [25.0] },
          { Id: "connections", Values: [10] },
          { Id: "freemem", Values: [800 * 1024 * 1024] },
        ],
      });

      const result = await evaluateScalingHealth(
        { STAGE: "dev", AWS_REGION: "eu-central-1", DATABASE_POOL_MAX: "10" },
        100,
        30,
      );

      const cpuIndicator = result.indicators.find(
        (i) => i.name === "RDS CPU",
      );
      expect(cpuIndicator?.status).toBe("green");
    });

    it("should report RDS connections as red when above 80% of max", async () => {
      mockCloudWatchSend.mockResolvedValue({
        MetricDataResults: [
          { Id: "cpu", Values: [30] },
          { Id: "connections", Values: [100] }, // 100/112 = 89%
          { Id: "freemem", Values: [500 * 1024 * 1024] },
        ],
      });

      const result = await evaluateScalingHealth(
        { STAGE: "dev", AWS_REGION: "eu-central-1", DATABASE_POOL_MAX: "10" },
        100,
        30,
      );

      const connIndicator = result.indicators.find(
        (i) => i.name === "RDS Connections",
      );
      expect(connIndicator?.status).toBe("red");
      expect(
        result.recommendations.some((r) => r.includes("RDS Proxy")),
      ).toBe(true);
    });

    it("should report low RDS memory as red", async () => {
      mockCloudWatchSend.mockResolvedValue({
        MetricDataResults: [
          { Id: "cpu", Values: [30] },
          { Id: "connections", Values: [10] },
          { Id: "freemem", Values: [50 * 1024 * 1024] }, // 50 MB
        ],
      });

      const result = await evaluateScalingHealth(
        { STAGE: "dev", AWS_REGION: "eu-central-1", DATABASE_POOL_MAX: "10" },
        100,
        30,
      );

      const memIndicator = result.indicators.find(
        (i) => i.name === "RDS Free Memory",
      );
      expect(memIndicator?.status).toBe("red");
      expect(memIndicator?.value).toBe(50);
    });

    it("should handle CloudWatch failure gracefully", async () => {
      mockCloudWatchSend.mockRejectedValue(new Error("Access Denied"));

      const result = await evaluateScalingHealth(
        { STAGE: "dev", AWS_REGION: "eu-central-1", DATABASE_POOL_MAX: "10" },
        100,
        30,
      );

      // Should still return a result without CloudWatch indicators
      expect(result).toBeDefined();
      expect(result.infrastructure.rdsInstance).toBe("db.t4g.micro");
      // No RDS CPU/Connections/Memory indicators when CloudWatch fails
      const cwIndicators = result.indicators.filter((i) =>
        i.name.startsWith("RDS"),
      );
      expect(cwIndicators).toHaveLength(0);
    });
  });

  describe("deploy headroom calculation", () => {
    it("should show green headroom when pool is small", async () => {
      const result = await evaluateScalingHealth(
        { STAGE: "dev", AWS_REGION: "eu-central-1", DATABASE_POOL_MAX: "10" },
        100,
        30,
      );

      // dev: 1 task * 10 pool = 10, deploy doubles to 20, usable = 99
      // headroom = (99 - 20) / 99 = 79%
      const deployIndicator = result.indicators.find(
        (i) => i.name === "Deploy Headroom",
      );
      expect(deployIndicator?.status).toBe("green");
      expect(deployIndicator!.value).toBeGreaterThan(40);
    });

    it("should show red headroom when pool is too large", async () => {
      const result = await evaluateScalingHealth(
        { STAGE: "dev", AWS_REGION: "eu-central-1", DATABASE_POOL_MAX: "45" },
        100,
        30,
      );

      // dev: 1 task * 45 pool = 45, deploy doubles to 90, usable = 99
      // headroom = (99 - 90) / 99 = 9%
      const deployIndicator = result.indicators.find(
        (i) => i.name === "Deploy Headroom",
      );
      expect(deployIndicator?.status).toBe("red");
    });
  });

  describe("scaling phase progression", () => {
    it("should mark Phase 0 as done when singleton pool", async () => {
      const result = await evaluateScalingHealth(
        { STAGE: "dev", AWS_REGION: "eu-central-1", DATABASE_POOL_MAX: "10" },
        100,
        30,
      );

      const phase0 = result.phases.find((p) => p.id === 0);
      expect(phase0?.status).toBe("done");
    });

    it("should mark Phase 0 as active when per-request pool", async () => {
      const result = await evaluateScalingHealth(
        { STAGE: "dev", AWS_REGION: "eu-central-1", DATABASE_POOL_MAX: "1" },
        100,
        30,
      );

      const phase0 = result.phases.find((p) => p.id === 0);
      expect(phase0?.status).toBe("active");
    });

    it("should include all 8 phases", async () => {
      const result = await evaluateScalingHealth(
        { STAGE: "dev", AWS_REGION: "eu-central-1", DATABASE_POOL_MAX: "10" },
        100,
        30,
      );

      expect(result.phases).toHaveLength(8);
      expect(result.phases[0].name).toBe("Fix Connection Pool");
      expect(result.phases[7].name).toBe("Multi-Region");
    });
  });

  describe("overall status", () => {
    it("should be healthy when all indicators are green", async () => {
      mockCloudWatchSend.mockResolvedValue({
        MetricDataResults: [
          { Id: "cpu", Values: [20] },
          { Id: "connections", Values: [10] },
          { Id: "freemem", Values: [800 * 1024 * 1024] },
        ],
      });

      const result = await evaluateScalingHealth(
        { STAGE: "dev", AWS_REGION: "eu-central-1", DATABASE_POOL_MAX: "10" },
        100,
        5,
      );

      expect(result.overallStatus).toBe("healthy");
    });

    it("should be action-needed when any indicator is red", async () => {
      const result = await evaluateScalingHealth(
        { STAGE: "dev", AWS_REGION: "eu-central-1", DATABASE_POOL_MAX: "1" },
        100,
        5,
      );

      expect(result.overallStatus).toBe("action-needed");
    });
  });

  describe("capacity estimation", () => {
    it("should estimate higher capacity for singleton pool", async () => {
      const singletonResult = await evaluateScalingHealth(
        { STAGE: "dev", AWS_REGION: "eu-central-1", DATABASE_POOL_MAX: "10" },
        100,
        30,
      );

      const perRequestResult = await evaluateScalingHealth(
        { STAGE: "dev", AWS_REGION: "eu-central-1", DATABASE_POOL_MAX: "1" },
        100,
        30,
      );

      expect(singletonResult.infrastructure.estimatedMaxReqPerSec).toBeGreaterThan(
        perRequestResult.infrastructure.estimatedMaxReqPerSec,
      );
    });
  });

  describe("response structure", () => {
    it("should include all required fields", async () => {
      const result = await evaluateScalingHealth(
        { STAGE: "dev", AWS_REGION: "eu-central-1", DATABASE_POOL_MAX: "10" },
        100,
        30,
      );

      expect(result).toHaveProperty("currentPhase");
      expect(result).toHaveProperty("phaseName");
      expect(result).toHaveProperty("overallStatus");
      expect(result).toHaveProperty("indicators");
      expect(result).toHaveProperty("phases");
      expect(result).toHaveProperty("recommendations");
      expect(result).toHaveProperty("infrastructure");
      expect(result).toHaveProperty("timestamp");

      expect(result.infrastructure).toHaveProperty("rdsInstance");
      expect(result.infrastructure).toHaveProperty("rdsMaxConnections");
      expect(result.infrastructure).toHaveProperty("ecsTaskCount");
      expect(result.infrastructure).toHaveProperty("ecsMaxTasks");
      expect(result.infrastructure).toHaveProperty("poolMaxPerTask");
      expect(result.infrastructure).toHaveProperty("poolConnectionModel");
      expect(result.infrastructure).toHaveProperty("totalUsers");
      expect(result.infrastructure).toHaveProperty("estimatedDAU");
      expect(result.infrastructure).toHaveProperty("estimatedMaxReqPerSec");
    });

    it("should include ISO timestamp", async () => {
      const result = await evaluateScalingHealth(
        { STAGE: "dev", DATABASE_POOL_MAX: "10" },
        100,
        30,
      );

      expect(() => new Date(result.timestamp)).not.toThrow();
      expect(new Date(result.timestamp).getTime()).toBeGreaterThan(0);
    });
  });
});
