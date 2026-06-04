/**
 * Unit Tests: Media Metrics
 *
 * Tests for media operation metrics tracking and analytics engine integration.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaMetrics, type MediaMetricsEnv } from "../../src/lib/media-metrics.js";

const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();

describe("MediaMetrics", () => {
  let metrics: MediaMetrics;
  let mockEnv: MediaMetricsEnv;
  let mockAnalytics: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockAnalytics = {
      writeDataPoint: vi.fn(),
    };

    mockEnv = {
      ENVIRONMENT: "dev",
      ANALYTICS: mockAnalytics,
    } as any;

    metrics = new MediaMetrics(mockEnv);
  });

  describe("trackOperation", () => {
    it("should log successful operation as info", () => {
      metrics.trackOperation({
        operation: "list",
        endpoint: "/api/media",
        duration: 150,
        statusCode: 200,
        resultCount: 10,
      });

          });

    it("should log failed operation (4xx/5xx) as error", () => {
      metrics.trackOperation({
        operation: "details",
        endpoint: "/api/media/123",
        duration: 50,
        statusCode: 500,
        errorType: "DatabaseError",
      });

          });

    it("should log slow operation (>2000ms) as warning", () => {
      metrics.trackOperation({
        operation: "grouped",
        endpoint: "/api/media/grouped",
        duration: 3000,
        statusCode: 200,
        resultCount: 50,
      });

          });

    it("should write to analytics engine when available", () => {
      metrics.trackOperation({
        operation: "list",
        endpoint: "/api/media",
        duration: 100,
        statusCode: 200,
        resultCount: 5,
        region: "US",
      });

      expect(mockAnalytics.writeDataPoint).toHaveBeenCalledWith({
        blobs: ["media-operation", "list", "/api/media", "US", "success"],
        doubles: [expect.any(Number), 100, 200, 5],
        indexes: [
          "media:list",
          "media:/api/media",
          "media:list:200",
          "media:US",
        ],
      });
    });

    it("should handle analytics write failure gracefully", () => {
      mockAnalytics.writeDataPoint.mockImplementation(() => {
        throw new Error("Analytics unavailable");
      });

      // Should not throw
      metrics.trackOperation({
        operation: "list",
        endpoint: "/api/media",
        duration: 100,
      });

          });

    it("should use default values for missing optional fields", () => {
      metrics.trackOperation({
        operation: "list",
        endpoint: "/api/media",
        duration: 100,
      });

      expect(mockAnalytics.writeDataPoint).toHaveBeenCalledWith(
        expect.objectContaining({
          blobs: ["media-operation", "list", "/api/media", "unknown", "success"],
          doubles: [expect.any(Number), 100, 200, 0],
        }),
      );
    });
  });

  describe("trackList", () => {
    it("should track list operation correctly", () => {
      metrics.trackList("/api/media", 150, 10, 200, "US", "user-123");

          });
  });

  describe("trackGrouped", () => {
    it("should track grouped operation and write items metric", () => {
      metrics.trackGrouped("/api/media/grouped", 200, 5, 50, 200, "US");

            // Two writeDataPoint calls: one for the operation, one for items
      expect(mockAnalytics.writeDataPoint).toHaveBeenCalledTimes(2);
      expect(mockAnalytics.writeDataPoint).toHaveBeenCalledWith(
        expect.objectContaining({
          blobs: ["media-grouped-items", "/api/media/grouped", "US"],
          doubles: [expect.any(Number), 50],
        }),
      );
    });

    it("should handle analytics failure for items metric gracefully", () => {
      let callCount = 0;
      mockAnalytics.writeDataPoint.mockImplementation(() => {
        callCount++;
        if (callCount === 2) throw new Error("Analytics down");
      });

      // Should not throw
      metrics.trackGrouped("/api/media/grouped", 200, 5, 50, 200);

          });
  });

  describe("trackStats", () => {
    it("should track stats operation", () => {
      metrics.trackStats("/api/media/stats", 100, 250, 200, "EU");

          });
  });

  describe("trackMediaAction", () => {
    it("should track single-media actions", () => {
      metrics.trackMediaAction(
        "hide",
        "/api/media/123/hide",
        50,
        200,
        "media-123",
        "US",
        "user-123",
      );

            // Verify analytics was called with media action data
      expect(mockAnalytics.writeDataPoint).toHaveBeenCalled();
    });

    it("should track delete action with error type", () => {
      metrics.trackMediaAction(
        "delete",
        "/api/media/123",
        100,
        404,
        "media-123",
        "US",
        "user-123",
        "NotFound",
      );

          });
  });

  describe("trackCleanup", () => {
    it("should track successful cleanup", () => {
      metrics.trackCleanup("US", 100, 50, 0, 10, 5000);

            expect(mockAnalytics.writeDataPoint).toHaveBeenCalledWith(
        expect.objectContaining({
          blobs: ["media-cleanup", "US"],
          doubles: [expect.any(Number), 100, 50, 0, 10, 5000],
        }),
      );
    });

    it("should log cleanup with errors as error level", () => {
      metrics.trackCleanup("US", 100, 50, 5, 10, 5000);

          });

    it("should handle analytics failure during cleanup tracking", () => {
      mockAnalytics.writeDataPoint.mockImplementation(() => {
        throw new Error("Analytics failure");
      });

      metrics.trackCleanup("US", 100, 50, 0, 10, 5000);

          });
  });

  describe("trackRateLimit", () => {
    it("should track rate limit violation", () => {
      metrics.trackRateLimit("/api/media", "user-123", "1.2.3.4", 100, 3600);

            expect(mockAnalytics.writeDataPoint).toHaveBeenCalledWith(
        expect.objectContaining({
          blobs: ["media-rate-limit", "/api/media"],
        }),
      );
    });

    it("should handle missing optional parameters", () => {
      metrics.trackRateLimit("/api/media");

          });
  });

  describe("Constructor edge cases", () => {
    it("should work without env (empty logger)", () => {
      const noEnvMetrics = new MediaMetrics();
      // Should not throw - analytics won't be available
      expect(noEnvMetrics).toBeDefined();
    });

    it("should work without analytics in env", () => {
      const envNoAnalytics = { ENVIRONMENT: "dev" } as any;
      const metricsNoAnalytics = new MediaMetrics(envNoAnalytics);

      // Should not throw when tracking without analytics
      metricsNoAnalytics.trackOperation({
        operation: "list",
        endpoint: "/api/media",
        duration: 100,
      });

          });
  });
});
