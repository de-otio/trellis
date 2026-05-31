/**
 * Unit Tests: Orphaned Media Routes
 *
 * Tests for the POST /api/media/:id/mark-orphaned endpoint.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { orphanedMediaRoutes } from "../../../src/lib/routes/orphaned-media.js";

// Mock SessionManager
const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

// Mock SecurityHeaders
const mockCreateSecureResponse = vi.fn();
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
  },
}));


// Mock CorsHandler
vi.mock("../../../src/lib/cors-handler", () => ({
  CorsHandler: {
    addCorsHeaders: vi.fn((response) => response),
  },
}));

// Mock OrphanedMediaHandler
const mockMarkMediaAsOrphaned = vi.fn();
vi.mock("../../../src/lib/orphaned-media-handler", () => ({
  OrphanedMediaHandler: class {
    markMediaAsOrphaned = mockMarkMediaAsOrphaned;
  },
}));

// Mock RegionDetector (dynamic import in route)
const mockDetectRegion = vi.fn();
vi.mock("../../../src/lib/region-detection", () => ({
  RegionDetector: class {
    detectRegion = mockDetectRegion;
  },
}));

// Mock middleware
vi.mock("../../../src/lib/middleware", () => ({
  corsMiddleware: () => vi.fn(),
  csrfMiddleware: () => vi.fn(),
}));

describe("Orphaned Media Routes", () => {
  let mockEnv: any;
  let mockRequest: Request;

  const markOrphanedRoute = orphanedMediaRoutes.find(
    (r) => r.path === "/api/media/:id/mark-orphaned" && r.method === "POST",
  );

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      APP_DOMAIN: "https://api.rkm1.de",
      SESSION_SECRET: "test-secret",
      ENVIRONMENT: "dev",
    };

    mockCreateSecureResponse.mockImplementation(
      (body, options) => new Response(body, options),
    );

    mockGetSession.mockResolvedValue({
      userId: "user-123",
      email: "test@example.com",
      expiresAt: Date.now() + 3600000,
    });

    mockDetectRegion.mockResolvedValue("US");

    mockMarkMediaAsOrphaned.mockResolvedValue({ success: true });
  });

  it("should export the mark-orphaned route", () => {
    expect(markOrphanedRoute).toBeDefined();
    expect(markOrphanedRoute!.method).toBe("POST");
    expect(markOrphanedRoute!.path).toBe("/api/media/:id/mark-orphaned");
  });

  describe("POST /api/media/:id/mark-orphaned", () => {
    it("should require authentication - return 401", async () => {
      mockGetSession.mockResolvedValue(null);

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/media-123/mark-orphaned",
        { method: "POST" },
      );

      const response = await markOrphanedRoute!.handler(mockRequest, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/media-123/mark-orphaned",
        ),
        pathname: "/api/media/media-123/mark-orphaned",
        params: { id: "media-123" },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Unauthorized");
    });

    it("should return 401 when session has no userId", async () => {
      mockGetSession.mockResolvedValue({ userId: null });

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/media-123/mark-orphaned",
        { method: "POST" },
      );

      const response = await markOrphanedRoute!.handler(mockRequest, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/media-123/mark-orphaned",
        ),
        pathname: "/api/media/media-123/mark-orphaned",
        params: { id: "media-123" },
      });

      expect(response.status).toBe(401);
    });

    it("should return 400 if mediaId is missing", async () => {
      mockRequest = new Request(
        "https://api.rkm1.de/api/media//mark-orphaned",
        { method: "POST" },
      );

      const response = await markOrphanedRoute!.handler(mockRequest, mockEnv, {
        url: new URL("https://api.rkm1.de/api/media//mark-orphaned"),
        pathname: "/api/media//mark-orphaned",
        params: {},
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Media ID is required");
    });

    it("should call OrphanedMediaHandler.markMediaAsOrphaned", async () => {
      mockRequest = new Request(
        "https://api.rkm1.de/api/media/media-456/mark-orphaned",
        { method: "POST" },
      );

      await markOrphanedRoute!.handler(mockRequest, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/media-456/mark-orphaned",
        ),
        pathname: "/api/media/media-456/mark-orphaned",
        params: { id: "media-456" },
      });

      expect(mockMarkMediaAsOrphaned).toHaveBeenCalledWith(
        "media-456",
        "user-123",
        "US",
        mockEnv,
      );
    });

    it("should return 200 with result on success", async () => {
      mockMarkMediaAsOrphaned.mockResolvedValue({
        success: true,
        mediaId: "media-456",
      });

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/media-456/mark-orphaned",
        { method: "POST" },
      );

      const response = await markOrphanedRoute!.handler(mockRequest, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/media-456/mark-orphaned",
        ),
        pathname: "/api/media/media-456/mark-orphaned",
        params: { id: "media-456" },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ success: true, mediaId: "media-456" });
    });

    it("should return 400 when handler returns success: false", async () => {
      mockMarkMediaAsOrphaned.mockResolvedValue({
        success: false,
        error: "Media not found",
      });

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/media-456/mark-orphaned",
        { method: "POST" },
      );

      const response = await markOrphanedRoute!.handler(mockRequest, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/media-456/mark-orphaned",
        ),
        pathname: "/api/media/media-456/mark-orphaned",
        params: { id: "media-456" },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Media not found");
    });

    it("should return 504 on timeout (5-second limit)", async () => {
      vi.useFakeTimers();

      // Handler never resolves on its own
      mockMarkMediaAsOrphaned.mockImplementation(
        () => new Promise(() => {}),
      );

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/media-456/mark-orphaned",
        { method: "POST" },
      );

      const responsePromise = markOrphanedRoute!.handler(
        mockRequest,
        mockEnv,
        {
          url: new URL(
            "https://api.rkm1.de/api/media/media-456/mark-orphaned",
          ),
          pathname: "/api/media/media-456/mark-orphaned",
          params: { id: "media-456" },
        },
      );

      // Advance past the 5-second timeout
      await vi.advanceTimersByTimeAsync(5001);

      const response = await responsePromise;

      expect(response.status).toBe(504);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Request timeout");

      vi.useRealTimers();
    });

    it("should detect region from request", async () => {
      mockRequest = new Request(
        "https://api.rkm1.de/api/media/media-456/mark-orphaned",
        { method: "POST" },
      );

      await markOrphanedRoute!.handler(mockRequest, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/media-456/mark-orphaned",
        ),
        pathname: "/api/media/media-456/mark-orphaned",
        params: { id: "media-456" },
      });

      expect(mockDetectRegion).toHaveBeenCalledWith(
        mockRequest,
        undefined,
        undefined,
      );
    });

    it("should handle handler errors with 500", async () => {
      mockMarkMediaAsOrphaned.mockRejectedValue(
        new Error("Database connection failed"),
      );

      mockRequest = new Request(
        "https://api.rkm1.de/api/media/media-456/mark-orphaned",
        { method: "POST" },
      );

      const response = await markOrphanedRoute!.handler(mockRequest, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/media-456/mark-orphaned",
        ),
        pathname: "/api/media/media-456/mark-orphaned",
        params: { id: "media-456" },
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Internal server error");
    });
  });
});
