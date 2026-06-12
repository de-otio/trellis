/**
 * Unit Tests: ActivityPub Standalone Mode
 *
 * Tests for standalone mode feature toggle checking and remote URI detection.
 */

import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import {
  isRemoteUri,
  isStandaloneModeEnabled,
} from "../../../src/lib/activitypub/standalone-mode.js";

// Mock dependencies
vi.mock("../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {
    getConnection: vi.fn(),
  },
}));

vi.mock("../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: vi.fn(),
  QueryTimeoutPresets: {
    FAST: {},
  },
}));

vi.mock("../../../src/lib/region-detection", () => ({
  detectRegionSync: vi.fn(() => "EU"),
}));

// Store current mock instance - set in each test
// Use globalThis to store the mock instance so it can be accessed at runtime
const getCurrentMockInstance = () => {
  return (globalThis as any).__currentMockFeatureToggleInstance;
};

const setCurrentMockInstance = (instance: any) => {
  (globalThis as any).__currentMockFeatureToggleInstance = instance;
};

vi.mock("../../../src/lib/feature-toggle-service", () => {
  // Create a mock constructor that accesses the global at runtime
  const MockFeatureToggleService = function (this: any, db: any) {
    // Access the mock instance at runtime when constructor is called
    const instance = (globalThis as any).__currentMockFeatureToggleInstance;
    if (instance) {
      // Copy properties to this
      Object.assign(this, instance);
      return this;
    }
    // Default mock
    this.isEnabled = vi.fn().mockResolvedValue(false);
    return this;
  } as any;

  return {
    FeatureToggleService: MockFeatureToggleService,
  };
});

// Mock the fedify/context module that is required dynamically
// The require() call uses relative path './fedify/context' from standalone-mode.ts
// So we need to mock it at the module level
vi.mock("../../../src/lib/activitypub/fedify/context", () => ({
  getActivityPubBaseUrl: (env: any) => {
    return env.ACTIVITYPUB_BASE_URL || "https://example.com";
  },
}));

describe("Standalone Mode", () => {
  const mockEnv: Partial<Env> = {
    LOG_LEVEL: "INFO",
    ACTIVITYPUB_BASE_URL: "https://example.com",
    DATABASE_URL: "postgresql://test",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock instance
    setCurrentMockInstance(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("isRemoteUri", () => {
    it("should return true for remote URIs", () => {
      const remoteUri = "https://remote.example.com/users/alice";
      const result = isRemoteUri(remoteUri, mockEnv as Env);
      expect(result).toBe(true);
    });

    it("should return false for local URIs", () => {
      const localUri = "https://example.com/users/alice";
      const result = isRemoteUri(localUri, mockEnv as Env);
      expect(result).toBe(false);
    });

    it("should return false for URIs with same base domain", () => {
      const localUri = "https://example.com/posts/123";
      const result = isRemoteUri(localUri, mockEnv as Env);
      expect(result).toBe(false);
    });

    it("should return true for URIs with different protocol but same domain", () => {
      const remoteUri = "http://example.com/users/alice";
      const result = isRemoteUri(remoteUri, mockEnv as Env);
      expect(result).toBe(true); // Different protocol = different origin
    });

    it("should treat a host that merely prefixes the base domain as remote", () => {
      // "example.com.attacker.com" must not masquerade as local via a
      // string prefix/substring check.
      const spoofed = "https://example.com.attacker.com/users/alice";
      const result = isRemoteUri(spoofed, mockEnv as Env);
      expect(result).toBe(true);
    });

    it("should treat an unparseable URI as remote", () => {
      const result = isRemoteUri("not a url", mockEnv as Env);
      expect(result).toBe(true);
    });
  });

  describe("isStandaloneModeEnabled", () => {
    it("should return true when toggle is enabled", async () => {
      const mockDb = {
        featureToggle: {
          findUnique: vi.fn().mockResolvedValue({
            key: "activitypub_standalone_mode_enabled",
            enabled: true,
          }),
        },
      } as any;

      // Set up mock instance before calling the function
      const mockInstance = {
        isEnabled: vi.fn().mockResolvedValue(true),
      };
      setCurrentMockInstance(mockInstance);

      const result = await isStandaloneModeEnabled(
        mockEnv as Env,
        mockDb as PrismaClient,
      );

      expect(result).toBe(true);
      expect(mockInstance.isEnabled).toHaveBeenCalledWith(
        "activitypub_standalone_mode_enabled",
      );
    });

    it("should return false when toggle is disabled", async () => {
      const mockDb = {
        featureToggle: {
          findUnique: vi.fn().mockResolvedValue({
            key: "activitypub_standalone_mode_enabled",
            enabled: false,
          }),
        },
      } as any;

      // Set up mock instance before calling the function
      const mockInstance = {
        isEnabled: vi.fn().mockResolvedValue(false),
      };
      setCurrentMockInstance(mockInstance);

      const result = await isStandaloneModeEnabled(
        mockEnv as Env,
        mockDb as PrismaClient,
      );

      expect(result).toBe(false);
      expect(mockInstance.isEnabled).toHaveBeenCalledWith(
        "activitypub_standalone_mode_enabled",
      );
    });

    it("should return false when toggle does not exist (default behavior)", async () => {
      const mockDb = {
        featureToggle: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      } as any;

      // Set up mock instance before calling the function
      const mockInstance = {
        isEnabled: vi.fn().mockResolvedValue(false), // Defaults to false
      };
      setCurrentMockInstance(mockInstance);

      const result = await isStandaloneModeEnabled(
        mockEnv as Env,
        mockDb as PrismaClient,
      );

      expect(result).toBe(false);
    });

    it("should use shared connection manager when db is not provided", async () => {
      const mockDb = {
        featureToggle: {
          findUnique: vi.fn().mockResolvedValue({
            key: "activitypub_standalone_mode_enabled",
            enabled: true,
          }),
        },
      } as any;

      const { withQueryTimeoutAndRetry } = await import(
        "../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb);
        },
      );

      // Set up mock instance before calling the function
      const mockInstance = {
        isEnabled: vi.fn().mockResolvedValue(true),
      };
      setCurrentMockInstance(mockInstance);

      const request = new Request("https://example.com/test");
      const result = await isStandaloneModeEnabled(
        mockEnv as Env,
        undefined,
        request,
      );

      expect(result).toBe(true);
      expect(withQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should return false on database error (fail-safe)", async () => {
      const mockDb = {
        featureToggle: {
          findUnique: vi.fn().mockRejectedValue(new Error("Database error")),
        },
      } as any;

      // Set up mock instance before calling the function
      const mockInstance = {
        isEnabled: vi.fn().mockRejectedValue(new Error("Database error")),
      };
      setCurrentMockInstance(mockInstance);

      const result = await isStandaloneModeEnabled(
        mockEnv as Env,
        mockDb as PrismaClient,
      );

      expect(result).toBe(false); // Fail-safe: defaults to false
    });

    it("should use FAST timeout preset for efficiency", async () => {
      const mockDb = {
        featureToggle: {
          findUnique: vi.fn().mockResolvedValue({
            key: "activitypub_standalone_mode_enabled",
            enabled: true,
          }),
        },
      } as any;

      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback, options) => {
          // Verify FAST preset is used
          expect(options).toMatchObject({
            ...QueryTimeoutPresets.FAST,
            defaultValue: false,
          });
          return callback(mockDb);
        },
      );

      const mockInstance = {
        isEnabled: vi.fn().mockResolvedValue(true),
      };
      setCurrentMockInstance(mockInstance);

      const request = new Request("https://example.com/test");
      await isStandaloneModeEnabled(mockEnv as Env, undefined, request);

      expect(withQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should return defaultValue on timeout", async () => {
      const { withQueryTimeoutAndRetry } = await import(
        "../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockResolvedValue(false); // Returns defaultValue

      const request = new Request("https://example.com/test");
      const result = await isStandaloneModeEnabled(
        mockEnv as Env,
        undefined,
        request,
      );

      expect(result).toBe(false); // Should return defaultValue
    });

    it("should handle invalid ACTIVITYPUB_BASE_URL gracefully", () => {
      const invalidEnv = {
        ...mockEnv,
        ACTIVITYPUB_BASE_URL: "not-a-valid-url",
      } as Env;

      const remoteUri = "https://remote.example.com/users/alice";
      const result = isRemoteUri(remoteUri, invalidEnv);

      expect(result).toBe(true); // Should still work with default
    });

    it("should handle invalid APP_DOMAIN gracefully", () => {
      const invalidEnv = {
        ...mockEnv,
        ACTIVITYPUB_BASE_URL: undefined,
        APP_DOMAIN: "not-a-valid-url",
      } as Env;

      const remoteUri = "https://remote.example.com/users/alice";
      const result = isRemoteUri(remoteUri, invalidEnv);

      expect(result).toBe(true); // Should still work with default
    });

    it("should use APP_DOMAIN when ACTIVITYPUB_BASE_URL not set", () => {
      const env = {
        ...mockEnv,
        ACTIVITYPUB_BASE_URL: undefined,
        APP_DOMAIN: "https://custom.com",
      } as Env;

      const localUri = "https://custom.com/users/alice";
      const remoteUri = "https://example.com/users/alice";

      expect(isRemoteUri(localUri, env)).toBe(false);
      expect(isRemoteUri(remoteUri, env)).toBe(true);
    });

    it("should handle error during toggle check gracefully", async () => {
      const { withQueryTimeoutAndRetry } = await import(
        "../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockRejectedValue(
        new Error("Network error"),
      );

      const request = new Request("https://example.com/test");
      const result = await isStandaloneModeEnabled(
        mockEnv as Env,
        undefined,
        request,
      );

      expect(result).toBe(false); // Fail-safe: defaults to false
    });
  });
});
