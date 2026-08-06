/**
 * Unit Tests: Feature Flags Routes
 *
 * Tests for feature flags endpoint including database error handling and edge cases.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { featureFlagsRoutes } from "../../../src/lib/routes/feature-flags.js";

// Mock dependencies
const mockGetRegionConfig = vi.fn();
const mockGetFeatureFlagsAsync = vi.fn();
const mockDetectRegionSync = vi.fn();
const mockIsValidRegion = vi.fn();
const mockCreateSecureResponse = vi.fn();
const mockAddCorsHeaders = vi.fn();

vi.mock("../../../src/lib/region-config", () => ({
  getRegionConfig: (...args: any[]) => mockGetRegionConfig(...args),
  getFeatureFlagsAsync: (...args: any[]) => mockGetFeatureFlagsAsync(...args),
}));

vi.mock("../../../src/lib/region-detection", () => ({
  detectRegionSync: (...args: any[]) => mockDetectRegionSync(...args),
  isValidRegion: (...args: any[]) => mockIsValidRegion(...args),
}));

vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    constructor(env: any) {}
  },
}));

vi.mock("../../../src/worker", () => ({
  addCorsHeaders: (...args: any[]) => mockAddCorsHeaders(...args),
}));

const mockCreatePrisma = vi.fn();
vi.mock("../../../src/db", () => ({
  createPrisma: (...args: any[]) => mockCreatePrisma(...args),
}));

vi.mock("../../../src/lib/validation", () => ({
  Validator: class {
    sanitizeError = vi.fn((error: any) => {
      if (error instanceof Error) return error.message;
      return "An error occurred. Please try again later.";
    });
  },
}));

describe("Feature Flags Routes", () => {
  let mockEnv: Env;
  let mockRequest: Request;
  let route: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      DEFAULT_REGION: "US",
    } as Env;

    route = featureFlagsRoutes.find(
      (r) => r.path === "/api/feature-flags" && r.method === "GET",
    );

    mockRequest = new Request("https://api.example.com/api/feature-flags", {
      method: "GET",
    });

    mockIsValidRegion.mockReturnValue(true);
    mockDetectRegionSync.mockReturnValue("US");
    mockGetRegionConfig.mockReturnValue({
      region: "US",
      features: {
        authentication: { emailPassword: true },
        features: { offlineMode: false },
        performance: { extendedTimeouts: false },
        security: {
          encryption: true,
          rateLimiting: true,
          auditLogging: true,
          regionValidation: true,
        },
      },
      endpoints: {
        api: "https://api.example.com",
        frontend: "https://www.example.com",
        cdn: "https://cdn.example.com",
      },
      timeouts: { api: 10000, database: 5000, storage: 5000 },
    });

    mockGetFeatureFlagsAsync.mockResolvedValue({
      authentication: { emailPassword: true },
      features: { offlineMode: false },
      performance: { extendedTimeouts: false },
      security: {
        encryption: true,
        rateLimiting: true,
        auditLogging: true,
        regionValidation: true,
      },
    });

    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });

    mockAddCorsHeaders.mockImplementation((response) => response);
  });

  describe("GET /api/feature-flags", () => {
    it("should return feature flags with region from query parameter", async () => {
      const request = new Request(
        "https://api.example.com/api/feature-flags?region=EU",
        { method: "GET" },
      );
      mockIsValidRegion.mockReturnValue(true);
      mockGetRegionConfig.mockReturnValue({
        region: "EU",
        features: {
          authentication: { emailPassword: true },
          features: { offlineMode: false },
          performance: { extendedTimeouts: false },
          security: {},
        },
        endpoints: {},
        timeouts: {},
      });

      const response = await route.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.region).toBe("EU");
      expect(mockIsValidRegion).toHaveBeenCalledWith("EU");
    });

    it("should detect region from request when not in query parameter", async () => {
      mockDetectRegionSync.mockReturnValue("CN");
      mockGetRegionConfig.mockReturnValue({
        region: "CN",
        features: {
          authentication: { emailPassword: true },
          features: { offlineMode: false },
          performance: { extendedTimeouts: false },
          security: {},
        },
        endpoints: {},
        timeouts: {},
      });

      const response = await route.handler(mockRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.region).toBe("CN");
      expect(mockDetectRegionSync).toHaveBeenCalledWith(mockRequest, mockEnv);
    });

    it("should use default config when database query fails", async () => {
      const dbError = new Error("Database connection failed");
      mockCreatePrisma.mockImplementation(() => {
        throw dbError;
      });

      const response = await route.handler(mockRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.features).toBeDefined();
      // Error should be logged
            // Should use default features from config
      expect(body.features.authentication).toBeDefined();
    });

    it("should handle database errors gracefully and fall back to default config", async () => {
      const dbError = new Error("Connection timeout");
      // createPrisma throws when called
      mockCreatePrisma.mockImplementation(() => {
        throw dbError;
      });

      const response = await route.handler(mockRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.features).toBeDefined();
      // Error should be logged
          });

    it("should return feature flags from database when available", async () => {
      const mockDb = { user: { findMany: vi.fn() } };
      mockCreatePrisma.mockReturnValue(mockDb);
      mockGetFeatureFlagsAsync.mockResolvedValue({
        authentication: { emailPassword: true, microsoftSSO: true },
        features: { offlineMode: true },
        performance: { extendedTimeouts: true },
        security: { encryption: true },
      });

      const response = await route.handler(mockRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.features.authentication.emailPassword).toBe(true);
      expect(body.features.authentication.microsoftSSO).toBe(true);
      expect(body.features.application.offlineMode).toBe(true);
    });

    it("should format response with all required fields", async () => {
      const response = await route.handler(mockRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("region");
      expect(body).toHaveProperty("features");
      expect(body).toHaveProperty("endpoints");
      expect(body).toHaveProperty("timeouts");
      expect(body.features).toHaveProperty("authentication");
      expect(body.features).toHaveProperty("application");
      expect(body.features).toHaveProperty("performance");
      expect(body.features).toHaveProperty("security");
    });

    it("should reject invalid region parameter", async () => {
      const request = new Request(
        "https://api.example.com/api/feature-flags?region=INVALID",
        { method: "GET" },
      );
      mockIsValidRegion.mockReturnValue(false);
      mockDetectRegionSync.mockReturnValue("US");

      const response = await route.handler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      // Should fall back to detected region
      expect(body.region).toBe("US");
      expect(mockDetectRegionSync).toHaveBeenCalled();
    });

    it("should handle general errors and return sanitized error message", async () => {
      const error = new Error("Unexpected error");
      mockGetRegionConfig.mockImplementation(() => {
        throw error;
      });

      const response = await route.handler(mockRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe("Unexpected error");
          });

    it("should add CORS headers to response", async () => {
      await route.handler(mockRequest, mockEnv);

      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        expect.any(Response),
        mockRequest,
        mockEnv,
      );
    });

    it("should handle database query errors and fall back to default config", async () => {
      const mockDb = { user: { findMany: vi.fn() } };
      mockCreatePrisma.mockReturnValue(mockDb);
      // getFeatureFlagsAsync throws error - should fall back to default
      mockGetFeatureFlagsAsync.mockRejectedValue(new Error("Query failed"));

      const response = await route.handler(mockRequest, mockEnv);
      const body = await response.json();

      // Should fall back to default config features
      expect(response.status).toBe(200);
      expect(body.features).toBeDefined();
          });

    it("should handle empty feature flags from database", async () => {
      const mockDb = { user: { findMany: vi.fn() } };
      mockCreatePrisma.mockReturnValue(mockDb);
      mockGetFeatureFlagsAsync.mockResolvedValue({});

      const response = await route.handler(mockRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.features).toBeDefined();
    });
  });

  describe("platform block (T9, plan §2.2)", () => {
    it("includes a platform block with all eleven keys, defaulting false when db is absent", async () => {
      // mockCreatePrisma has no return value configured in this suite's
      // beforeEach, so createPrisma(env) returns undefined here — exercising
      // getPlatformFlags's no-db path.
      const response = await route.handler(mockRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.platform).toEqual({
        posts: false,
        comments: false,
        friends: false,
        sentiments: false,
        feeds: false,
        map: false,
        events: false,
        collections: false,
        email_subscriptions: false,
        year_in_review: false,
        entity_profiles: false,
      });
    });

    it("does not change any existing response field (additive-only)", async () => {
      const mockDb = { user: { findMany: vi.fn() } };
      mockCreatePrisma.mockReturnValue(mockDb);
      mockGetFeatureFlagsAsync.mockResolvedValue({
        authentication: { emailPassword: true, microsoftSSO: true },
        features: { offlineMode: true },
        performance: { extendedTimeouts: true },
        security: { encryption: true },
      });

      const response = await route.handler(mockRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.region).toBe("US");
      expect(body.features.authentication).toEqual({
        emailPassword: true,
        microsoftSSO: true,
      });
      expect(body.features.application).toEqual({ offlineMode: true });
      expect(body.features.performance).toEqual({ extendedTimeouts: true });
      expect(body.features.security).toEqual({ encryption: true });
      expect(body.endpoints).toEqual({
        api: "https://api.example.com",
        frontend: "https://www.example.com",
        cdn: "https://cdn.example.com",
      });
      expect(body.timeouts).toEqual({ api: 10000, database: 5000, storage: 5000 });
      // ...and the new field is present alongside them.
      expect(body).toHaveProperty("platform");
    });

    it("still returns a platform block (all-false) when createPrisma throws", async () => {
      mockCreatePrisma.mockImplementation(() => {
        throw new Error("Database connection failed");
      });

      const response = await route.handler(mockRequest, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.platform).toBeDefined();
      expect(Object.values(body.platform).every((v: any) => v === false)).toBe(
        true,
      );
    });
  });

  describe("Route configuration", () => {
    it("should have correct route path and method", () => {
      expect(route).toBeDefined();
      expect(route.path).toBe("/api/feature-flags");
      expect(route.method).toBe("GET");
    });

    it("should have middleware configured", () => {
      expect(route.middleware).toBeDefined();
      expect(Array.isArray(route.middleware)).toBe(true);
    });

    it("should have description", () => {
      expect(route.description).toBeDefined();
      expect(typeof route.description).toBe("string");
    });
  });
});
