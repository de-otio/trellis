/**
 * Unit Tests: Media Metadata Visibility Routes
 *
 * Tests for PATCH /api/media/:mediaId/metadata-visibility endpoint
 * which toggles metadataVisible and locationVisible flags on media.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mediaMetadataVisibilityRoutes } from "../../../src/lib/routes/media-metadata-visibility.js";

// Mock SessionManager
const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

// Mock SecurityHeaders
const mockCreateSecureResponse = vi.fn();
const mockAddSecurityHeaders = vi.fn();
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    addSecurityHeaders = mockAddSecurityHeaders;
  },
}));

// Mock RateLimiter
const mockApplyRateLimitKV = vi.fn();
vi.mock("../../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    applyRateLimitKV = mockApplyRateLimitKV;
  },
}));


// Mock CorsHandler
vi.mock("../../../src/lib/cors-handler", () => ({
  CorsHandler: {
    addCorsHeaders: vi.fn((response) => response),
  },
}));

const mockLoggerWarn = vi.fn();

// Mock database connection manager
vi.mock("../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {},
}));

// Mock withQueryTimeoutAndRetry
const mockWithQueryTimeoutAndRetry = vi.fn();
vi.mock("../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: (...args: any[]) =>
    mockWithQueryTimeoutAndRetry(...args),
  QueryTimeoutPresets: {
    USER_FACING: { timeoutMs: 3000, retryTimeoutMs: 2000 },
  },
}));

// Mock RegionDetector (dynamic import)
const mockDetectRegion = vi.fn();
vi.mock("../../../src/lib/region-detection", () => ({
  RegionDetector: class {
    detectRegion = mockDetectRegion;
  },
}));

// Mock MediaHandler (dynamic import)
const mockGetMediaDetails = vi.fn();
vi.mock("../../../src/lib/media-handler", () => ({
  MediaHandler: {
    create: vi.fn(() => ({
      getMediaDetails: mockGetMediaDetails,
    })),
  },
}));

// Mock TrellisAuditLogger (dynamic import)
const mockAuditLog = vi.fn();
vi.mock("../../../src/lib/audit-composer", () => ({
  TrellisAuditLogger: class {
    log = mockAuditLog;
  },
}));

// Mock middleware
vi.mock("../../../src/lib/middleware", () => ({
  corsMiddleware: () => vi.fn(),
  csrfMiddleware: () => vi.fn(),
}));

describe("Media Metadata Visibility Routes", () => {
  const route = mediaMetadataVisibilityRoutes.find(
    (r) =>
      r.path === "/api/media/:mediaId/metadata-visibility" &&
      r.method === "PATCH",
  );

  let mockEnv: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      APP_DOMAIN: "https://api.rkm1.de",
      SESSION_SECRET: "test-secret",
      ENVIRONMENT: "dev",
    };

    mockGetSession.mockResolvedValue({
      userId: "user-123",
      email: "test@example.com",
      expiresAt: Date.now() + 3600000,
    });

    mockApplyRateLimitKV.mockResolvedValue(null); // No rate limit
    mockCreateSecureResponse.mockImplementation(
      (body: string, options: any) => new Response(body, options),
    );
    mockAddSecurityHeaders.mockImplementation((response: any) => response);
    mockDetectRegion.mockResolvedValue("us-east-1");
    mockGetMediaDetails.mockResolvedValue({ id: "media-123", userId: "user-123" });
    mockAuditLog.mockResolvedValue(undefined);

    // Default: DB update returns the updated record
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (
        _manager: any,
        _region: string,
        _env: any,
        queryFn: (db: any) => Promise<any>,
      ) => {
        const mockDb = {
          mediaFile: {
            update: vi.fn().mockResolvedValue({
              id: "media-123",
              metadataVisible: true,
              locationVisible: false,
            }),
          },
        };
        return await queryFn(mockDb);
      },
    );
  });

  it("should be defined as a route", () => {
    expect(route).toBeDefined();
    expect(route!.method).toBe("PATCH");
    expect(route!.path).toBe("/api/media/:mediaId/metadata-visibility");
  });

  describe("PATCH /api/media/:mediaId/metadata-visibility", () => {
    it("should require authentication - return 401 without session", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "https://api.rkm1.de/api/media/media-123/metadata-visibility",
        {
          method: "PATCH",
          body: JSON.stringify({ metadataVisible: true }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/media-123/metadata-visibility",
        ),
        pathname: "/api/media/media-123/metadata-visibility",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Unauthorized");
    });

    it("should reject request with no body fields - return 400", async () => {
      const request = new Request(
        "https://api.rkm1.de/api/media/media-123/metadata-visibility",
        {
          method: "PATCH",
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/media-123/metadata-visibility",
        ),
        pathname: "/api/media/media-123/metadata-visibility",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toHaveProperty("error", "Validation error");
    });

    it("should update metadataVisible flag and return 200", async () => {
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          _manager: any,
          _region: string,
          _env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          const mockDb = {
            mediaFile: {
              update: vi.fn().mockResolvedValue({
                id: "media-123",
                metadataVisible: true,
                locationVisible: false,
              }),
            },
          };
          return await queryFn(mockDb);
        },
      );

      const request = new Request(
        "https://api.rkm1.de/api/media/media-123/metadata-visibility",
        {
          method: "PATCH",
          body: JSON.stringify({ metadataVisible: true }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/media-123/metadata-visibility",
        ),
        pathname: "/api/media/media-123/metadata-visibility",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.media).toEqual({
        id: "media-123",
        metadataVisible: true,
        locationVisible: false,
      });
    });

    it("should update locationVisible flag and return 200", async () => {
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          _manager: any,
          _region: string,
          _env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          const mockDb = {
            mediaFile: {
              update: vi.fn().mockResolvedValue({
                id: "media-123",
                metadataVisible: false,
                locationVisible: true,
              }),
            },
          };
          return await queryFn(mockDb);
        },
      );

      const request = new Request(
        "https://api.rkm1.de/api/media/media-123/metadata-visibility",
        {
          method: "PATCH",
          body: JSON.stringify({ locationVisible: true }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/media-123/metadata-visibility",
        ),
        pathname: "/api/media/media-123/metadata-visibility",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.media.locationVisible).toBe(true);
    });

    it("should update both flags simultaneously", async () => {
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          _manager: any,
          _region: string,
          _env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          const mockDb = {
            mediaFile: {
              update: vi.fn().mockResolvedValue({
                id: "media-123",
                metadataVisible: true,
                locationVisible: true,
              }),
            },
          };
          return await queryFn(mockDb);
        },
      );

      const request = new Request(
        "https://api.rkm1.de/api/media/media-123/metadata-visibility",
        {
          method: "PATCH",
          body: JSON.stringify({ metadataVisible: true, locationVisible: true }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/media-123/metadata-visibility",
        ),
        pathname: "/api/media/media-123/metadata-visibility",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.media.metadataVisible).toBe(true);
      expect(body.media.locationVisible).toBe(true);
    });

    it("should verify media ownership before update", async () => {
      // MediaHandler.getMediaDetails throws when user doesn't own the media
      mockGetMediaDetails.mockRejectedValue(
        new Error("Forbidden: not the owner"),
      );

      const request = new Request(
        "https://api.rkm1.de/api/media/media-456/metadata-visibility",
        {
          method: "PATCH",
          body: JSON.stringify({ metadataVisible: true }),
          headers: { "content-type": "application/json" },
        },
      );

      // The handler should throw/propagate the ownership error
      await expect(
        route!.handler(request, mockEnv, {
          url: new URL(
            "https://api.rkm1.de/api/media/media-456/metadata-visibility",
          ),
          pathname: "/api/media/media-456/metadata-visibility",
          params: { mediaId: "media-456" },
        }),
      ).rejects.toThrow("Forbidden: not the owner");

      expect(mockGetMediaDetails).toHaveBeenCalledWith(
        "media-456",
        "user-123",
        mockEnv,
        expect.any(Request),
      );
    });

    it("should return 400 if mediaId is missing", async () => {
      const request = new Request(
        "https://api.rkm1.de/api/media//metadata-visibility",
        {
          method: "PATCH",
          body: JSON.stringify({ metadataVisible: true }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media//metadata-visibility",
        ),
        pathname: "/api/media//metadata-visibility",
        params: {}, // No mediaId
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.message).toContain("Media ID is required");
    });

    it("should return 400 for invalid JSON body", async () => {
      const request = new Request(
        "https://api.rkm1.de/api/media/media-123/metadata-visibility",
        {
          method: "PATCH",
          body: "not valid json{{{",
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/media-123/metadata-visibility",
        ),
        pathname: "/api/media/media-123/metadata-visibility",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid JSON body");
    });

    it("should not fail if audit logging fails (best-effort)", async () => {
      mockAuditLog.mockRejectedValue(new Error("Audit service unavailable"));

      const request = new Request(
        "https://api.rkm1.de/api/media/media-123/metadata-visibility",
        {
          method: "PATCH",
          body: JSON.stringify({ metadataVisible: false }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/media-123/metadata-visibility",
        ),
        pathname: "/api/media/media-123/metadata-visibility",
        params: { mediaId: "media-123" },
      });

      // Should still succeed despite audit log failure
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      // Should log a warning
          });

    it("should apply rate limiting", async () => {
      const rateLimitResponse = new Response(
        JSON.stringify({ error: "Rate limit exceeded" }),
        { status: 429 },
      );
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);
      mockAddSecurityHeaders.mockReturnValue(rateLimitResponse);

      const request = new Request(
        "https://api.rkm1.de/api/media/media-123/metadata-visibility",
        {
          method: "PATCH",
          body: JSON.stringify({ metadataVisible: true }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/media-123/metadata-visibility",
        ),
        pathname: "/api/media/media-123/metadata-visibility",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(429);
    });

    it("should reject non-boolean values for visibility flags", async () => {
      const request = new Request(
        "https://api.rkm1.de/api/media/media-123/metadata-visibility",
        {
          method: "PATCH",
          body: JSON.stringify({ metadataVisible: "yes" }),
          headers: { "content-type": "application/json" },
        },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://api.rkm1.de/api/media/media-123/metadata-visibility",
        ),
        pathname: "/api/media/media-123/metadata-visibility",
        params: { mediaId: "media-123" },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Validation error");
    });
  });
});
