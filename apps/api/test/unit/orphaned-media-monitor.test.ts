/**
 * Unit tests for OrphanedMediaMonitor
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { OrphanedMediaMonitor } from "../../src/lib/scheduled/orphaned-media-monitor.js";
import type {
  CleanupMetrics,
  HealthStatus,
} from "../../src/lib/scheduled/orphaned-media-monitor.js";

// Mock environment
const createMockEnv = () => {
  const kvStore = new Map<string, string>();

  return {
    RATE_LIMIT_KV: {
      get: vi.fn(async (key: string) => kvStore.get(key) || null),
      put: vi.fn(async (key: string, value: string) => {
        kvStore.set(key, value);
      }),
    },
    LOG_LEVEL: "info",
  } as any;
};

describe("OrphanedMediaMonitor", () => {
  let monitor: OrphanedMediaMonitor;
  let env: any;

  beforeEach(() => {
    env = createMockEnv();
    monitor = new OrphanedMediaMonitor(env);
  });

  describe("recordMetrics", () => {
    it("should store metrics in KV", async () => {
      const metrics: CleanupMetrics = {
        timestamp: "2026-01-18T03:00:00.000Z",
        orphanedCleaned: 100,
        r2Deleted: 50,
        r2Errors: 2,
        duration: 5000,
        regions: [
          {
            region: "US",
            orphanedCleaned: 60,
            r2Deleted: 30,
            hasMore: false,
          },
          {
            region: "EU",
            orphanedCleaned: 40,
            r2Deleted: 20,
            hasMore: false,
          },
        ],
      };

      await monitor.recordMetrics(metrics, env);

      expect(env.RATE_LIMIT_KV.put).toHaveBeenCalledTimes(2);

      // Check last run record
      const lastRunCall = env.RATE_LIMIT_KV.put.mock.calls.find(
        (call: any) => call[0] === "orphaned_cleanup_last_run",
      );
      expect(lastRunCall).toBeDefined();

      const lastRunData = JSON.parse(lastRunCall[1]);
      expect(lastRunData.timestamp).toBe(metrics.timestamp);
      expect(lastRunData.metrics).toEqual(metrics);
    });

    it("should handle KV unavailable gracefully", async () => {
      env.RATE_LIMIT_KV = null;

      const metrics: CleanupMetrics = {
        timestamp: "2026-01-18T03:00:00.000Z",
        orphanedCleaned: 100,
        r2Deleted: 50,
        r2Errors: 2,
        duration: 5000,
        regions: [],
      };

      // Should not throw
      await expect(
        monitor.recordMetrics(metrics, env),
      ).resolves.toBeUndefined();
    });
  });

  describe("checkHealth", () => {
    it("should return healthy status when job ran recently", async () => {
      const recentTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
      const metrics: CleanupMetrics = {
        timestamp: recentTimestamp.toISOString(),
        orphanedCleaned: 100,
        r2Deleted: 50,
        r2Errors: 2,
        duration: 5000,
        regions: [
          {
            region: "US",
            orphanedCleaned: 100,
            r2Deleted: 50,
            hasMore: false,
          },
        ],
      };

      await monitor.recordMetrics(metrics, env);
      const health = await monitor.checkHealth(env);

      expect(health.healthy).toBe(true);
      expect(health.lastRun).toBe(recentTimestamp.toISOString());
      expect(health.hoursSinceLastRun).toBeCloseTo(2, 1);
      expect(health.errorRate).toBeCloseTo(0.038, 2); // 2/(50+2)
      expect(health.issues).toHaveLength(0);
    });

    it("should detect job not running on schedule", async () => {
      const oldTimestamp = new Date(Date.now() - 30 * 60 * 60 * 1000); // 30 hours ago
      const metrics: CleanupMetrics = {
        timestamp: oldTimestamp.toISOString(),
        orphanedCleaned: 100,
        r2Deleted: 50,
        r2Errors: 2,
        duration: 5000,
        regions: [
          {
            region: "US",
            orphanedCleaned: 100,
            r2Deleted: 50,
            hasMore: false,
          },
        ],
      };

      await monitor.recordMetrics(metrics, env);
      const health = await monitor.checkHealth(env);

      console.log("Health status:", JSON.stringify(health, null, 2));

      expect(health.healthy).toBe(false);
      expect(health.hoursSinceLastRun).toBeCloseTo(30, 0);
      expect(health.issues.length).toBeGreaterThan(0);
      expect(
        health.issues.some((issue) =>
          issue.includes("Cleanup job hasn't run in"),
        ),
      ).toBe(true);
    });

    it("should detect high error rate", async () => {
      const recentTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const metrics: CleanupMetrics = {
        timestamp: recentTimestamp.toISOString(),
        orphanedCleaned: 100,
        r2Deleted: 50,
        r2Errors: 10, // 10/(50+10) = 16.7% error rate
        duration: 5000,
        regions: [
          {
            region: "US",
            orphanedCleaned: 100,
            r2Deleted: 50,
            hasMore: false,
          },
        ],
      };

      await monitor.recordMetrics(metrics, env);
      const health = await monitor.checkHealth(env);

      console.log(
        "Health status (high error):",
        JSON.stringify(health, null, 2),
      );

      expect(health.healthy).toBe(false);
      expect(health.errorRate).toBeCloseTo(0.167, 2);
      expect(health.issues.length).toBeGreaterThan(0);
      expect(
        health.issues.some((issue) => issue.includes("High error rate")),
      ).toBe(true);
    });

    it("should detect backlog", async () => {
      const recentTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const metrics: CleanupMetrics = {
        timestamp: recentTimestamp.toISOString(),
        orphanedCleaned: 1000,
        r2Deleted: 500,
        r2Errors: 5,
        duration: 25000,
        regions: [
          {
            region: "US",
            orphanedCleaned: 1000,
            r2Deleted: 500,
            hasMore: true, // Backlog detected
          },
        ],
      };

      await monitor.recordMetrics(metrics, env);
      const health = await monitor.checkHealth(env);

      console.log("Health status (backlog):", JSON.stringify(health, null, 2));

      expect(health.backlogEstimate).toBe(2000); // 1000 * 2
      expect(health.issues.length).toBeGreaterThan(0);
      expect(
        health.issues.some((issue) =>
          issue.includes("Cleanup backlog detected"),
        ),
      ).toBe(true);
      // Backlog alone doesn't make it unhealthy
      expect(health.healthy).toBe(true);
    });

    it("should return unhealthy when no job has run", async () => {
      const health = await monitor.checkHealth(env);

      expect(health.healthy).toBe(false);
      expect(health.lastRun).toBeNull();
      expect(health.hoursSinceLastRun).toBeNull();
      expect(health.issues).toContain("No cleanup job has run yet");
    });

    it("should handle KV unavailable", async () => {
      env.RATE_LIMIT_KV = null;

      const health = await monitor.checkHealth(env);

      expect(health.healthy).toBe(false);
      expect(health.issues).toContain("KV namespace not available");
    });
  });

  describe("sendAlert", () => {
    it("should not send alert when healthy", async () => {
      const healthyStatus: HealthStatus = {
        healthy: true,
        lastRun: new Date().toISOString(),
        hoursSinceLastRun: 2,
        backlogEstimate: 0,
        errorRate: 0.02,
        issues: [],
      };

      // Mock fetch
      global.fetch = vi.fn();

      await monitor.sendAlert(healthyStatus, env);

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should send webhook alert when unhealthy", async () => {
      const unhealthyStatus: HealthStatus = {
        healthy: false,
        lastRun: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
        hoursSinceLastRun: 30,
        backlogEstimate: 2000,
        errorRate: 0.15,
        issues: [
          "Cleanup job hasn't run in 30.0 hours (expected: 24h)",
          "High error rate: 15.0% (threshold: 10.0%)",
        ],
      };

      env.ORPHANED_MEDIA_ALERT_WEBHOOK = "https://example.com/webhook";

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      await monitor.sendAlert(unhealthyStatus, env);

      expect(global.fetch).toHaveBeenCalledWith(
        "https://example.com/webhook",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        }),
      );

      const callArgs = (global.fetch as any).mock.calls[0];
      const payload = JSON.parse(callArgs[1].body);

      expect(payload.severity).toBe("warning");
      expect(payload.title).toContain("Warning");
      expect(payload.health).toEqual(unhealthyStatus);
    });

    it("should send critical alert for severe issues", async () => {
      const criticalStatus: HealthStatus = {
        healthy: false,
        lastRun: new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString(),
        hoursSinceLastRun: 50,
        backlogEstimate: 5000,
        errorRate: 0.6,
        issues: [
          "Cleanup job hasn't run in 50.0 hours (expected: 24h)",
          "High error rate: 60.0% (threshold: 10.0%)",
        ],
      };

      env.ORPHANED_MEDIA_ALERT_WEBHOOK = "https://example.com/webhook";

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      await monitor.sendAlert(criticalStatus, env);

      const callArgs = (global.fetch as any).mock.calls[0];
      const payload = JSON.parse(callArgs[1].body);

      expect(payload.severity).toBe("critical");
      expect(payload.title).toContain("CRITICAL");
    });

    it("should send Slack alert when configured", async () => {
      const unhealthyStatus: HealthStatus = {
        healthy: false,
        lastRun: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
        hoursSinceLastRun: 30,
        backlogEstimate: 2000,
        errorRate: 0.15,
        issues: ["Test issue"],
      };

      env.ORPHANED_MEDIA_SLACK_WEBHOOK = "https://hooks.slack.com/test";

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      await monitor.sendAlert(unhealthyStatus, env);

      expect(global.fetch).toHaveBeenCalledWith(
        "https://hooks.slack.com/test",
        expect.objectContaining({
          method: "POST",
        }),
      );

      const callArgs = (global.fetch as any).mock.calls[0];
      const payload = JSON.parse(callArgs[1].body);

      expect(payload.text).toContain("⚠️");
      expect(payload.attachments).toBeDefined();
      expect(payload.attachments[0].color).toBe("warning");
    });

    it("should handle webhook failures gracefully", async () => {
      const unhealthyStatus: HealthStatus = {
        healthy: false,
        lastRun: null,
        hoursSinceLastRun: null,
        backlogEstimate: 0,
        errorRate: 0,
        issues: ["Test issue"],
      };

      env.ORPHANED_MEDIA_ALERT_WEBHOOK = "https://example.com/webhook";

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      // Should not throw
      await expect(
        monitor.sendAlert(unhealthyStatus, env),
      ).resolves.toBeUndefined();
    });
  });
});
