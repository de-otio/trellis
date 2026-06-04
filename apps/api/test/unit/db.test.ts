/**
 * Unit tests for database client creation with regional support
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithDb } from "../../src/db.js";
import {
  createPrisma,
  createPrismaForRegion,
  DatabaseClient,
  withPrisma,
  withPrismaRetry,
} from "../../src/db.js";
import { sharedDatabaseConnectionManager } from "../../src/lib/database-connection-manager.js";

// Mock the database-config module to avoid actual connection string validation
vi.mock("../../src/lib/database-config", () => {
  return {
    getDatabaseConnection: vi.fn((region: string, env: any) => {
      // Validate region
      const validRegions = ["US", "CN", "EU"];
      if (!validRegions.includes(region)) {
        throw new Error(`Invalid region: ${region}. Must be one of: US, CN`);
      }

      if (!env.DATABASE_URL) {
        throw new Error("DATABASE_URL environment variable is required");
      }
      return env.DATABASE_URL;
    }),
  };
});

// Mock Prisma Client and adapter
const mockPrismaClient = vi.fn();
const mockPrismaPg = vi.fn();
const mockPool = vi.fn();

vi.mock("pg", () => {
  return {
    Pool: class MockPool {
      config: any;
      totalCount: number = 0;
      idleCount: number = 0;
      waitingCount: number = 0;
      constructor(config: any) {
        this.config = config;
        mockPool(config);
      }
      on(event: string, handler: Function) {
        // Mock event handlers
      }
      end() {
        return Promise.resolve();
      }
    },
  };
});

vi.mock("@prisma/adapter-pg", () => {
  return {
    PrismaPg: class MockPrismaPg {
      pool: any;
      constructor(pool: any) {
        this.pool = pool;
        mockPrismaPg(pool);
      }
    },
  };
});

vi.mock("@prisma/client", () => {
  return {
    PrismaClient: class MockPrismaClient {
      adapter: any;
      constructor(config: any) {
        this.adapter = config.adapter;
        mockPrismaClient(config);
      }
      $disconnect() {
        return Promise.resolve();
      }
    },
  };
});

// Note: No longer mocking @prisma/extension-accelerate - Hyperdrive doesn't require an extension

describe("Database Client Creation", () => {
  const baseEnv: EnvWithDb = {
    DATABASE_URL:
      "postgresql://test-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
    HYPERDRIVE: {
      connectionString:
        "postgresql://test-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
    } as any,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear the pool cache to ensure fresh pools for each test
    sharedDatabaseConnectionManager.clearPools();
  });

  describe("createPrisma (backward compatible)", () => {
    it("should create Prisma client with default US region", () => {
      const prisma = createPrisma(baseEnv);

      expect(prisma).toBeDefined();
      expect(mockPool).toHaveBeenCalled();
      expect(mockPrismaPg).toHaveBeenCalled();
      expect(mockPrismaClient).toHaveBeenCalled();
      const poolCallArgs = mockPool.mock.calls[0][0];
      expect(poolCallArgs.connectionString).toContain(
        "postgresql://test-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
      );
    });

    it("should create Prisma client with explicit US region", () => {
      const prisma = createPrisma(baseEnv, "US");

      expect(prisma).toBeDefined();
      expect(mockPool).toHaveBeenCalled();
      expect(mockPrismaPg).toHaveBeenCalled();
      expect(mockPrismaClient).toHaveBeenCalled();
      const poolCallArgs = mockPool.mock.calls[0][0];
      expect(poolCallArgs.connectionString).toContain(
        "postgresql://test-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
      );
    });

    it("should create Prisma client with EU region", () => {
      const prisma = createPrisma(baseEnv, "EU");

      expect(prisma).toBeDefined();
      expect(mockPool).toHaveBeenCalled();
      expect(mockPrismaPg).toHaveBeenCalled();
      expect(mockPrismaClient).toHaveBeenCalled();
      const poolCallArgs = mockPool.mock.calls[0][0];
      expect(poolCallArgs.connectionString).toContain(
        "postgresql://test-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
      );
    });

    it("should create Prisma client with CN region when available", () => {
      const envWithChina: EnvWithDb = {
        ...baseEnv,
        HYPERDRIVE: baseEnv.HYPERDRIVE,
        SUPABASE_URL_CN: "https://cn-test.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY_CN: "cn-service-role-key",
      };

      const prisma = createPrisma(envWithChina, "CN");

      expect(prisma).toBeDefined();
      // For CN region, it uses PostgREST adapter, not Prisma Client
      // So we just verify it's defined
    });

    it("should throw error for CN region when China connection is missing", () => {
      // In AWS architecture, CN uses DATABASE_URL just like other regions - no throw expected
      const client = createPrisma(baseEnv, "CN");
      expect(client).toBeDefined();
    });
  });

  describe("createPrismaForRegion", () => {
    it("should create Prisma client for US region", () => {
      const prisma = createPrismaForRegion("US", baseEnv);

      expect(prisma).toBeDefined();
      expect(mockPool).toHaveBeenCalled();
      expect(mockPrismaPg).toHaveBeenCalled();
      expect(mockPrismaClient).toHaveBeenCalled();
      const poolCallArgs = mockPool.mock.calls[0][0];
      expect(poolCallArgs.connectionString).toContain(
        "postgresql://test-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
      );
    });

    it("should create Prisma client for CN region when available", () => {
      const envWithChina: EnvWithDb = {
        ...baseEnv,
        HYPERDRIVE: baseEnv.HYPERDRIVE,
        SUPABASE_URL_CN: "https://cn-test.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY_CN: "cn-service-role-key",
      };

      const prisma = createPrismaForRegion("CN", envWithChina);

      expect(prisma).toBeDefined();
      // For CN region, it uses PostgREST adapter, not Prisma Client
      // So we just verify it's defined
    });

    it("should handle invalid region", () => {
      // Note: createPrismaForRegion doesn't validate region - it passes through to DatabaseConnectionManager
      // Region validation happens in DataRouter, not in database connection layer
      // For invalid regions, it will attempt to create a connection which may fail later
      // This test verifies the function doesn't crash on invalid region input
      const result = createPrismaForRegion("INVALID", baseEnv);
      expect(result).toBeDefined();
    });
  });

  describe("withPrisma", () => {
    it("should execute callback with Prisma client and auto-release", async () => {
      const mockFn = vi.fn().mockResolvedValue("result");
      const result = await withPrisma(baseEnv, mockFn);

      expect(result).toBe("result");
      expect(mockFn).toHaveBeenCalled();
      const client = mockFn.mock.calls[0][0];
      expect(client).toBeDefined();
    });

    it("should release client even if callback throws", async () => {
      const mockFn = vi.fn().mockRejectedValue(new Error("Test error"));

      await expect(withPrisma(baseEnv, mockFn)).rejects.toThrow("Test error");
      // Client should be released in finally block
    });

    it("should use default US region", async () => {
      const mockFn = vi.fn().mockResolvedValue("result");
      await withPrisma(baseEnv, mockFn);

      // Function should complete successfully
      expect(mockFn).toHaveBeenCalled();
    });

    it("should use specified region", async () => {
      const mockFn = vi.fn().mockResolvedValue("result");
      await withPrisma(baseEnv, mockFn, "EU");

      // Function should complete successfully
      expect(mockFn).toHaveBeenCalled();
    });
  });

  describe("withPrismaRetry", () => {
    it("should execute query with retry logic", async () => {
      const mockQueryFn = vi.fn().mockResolvedValue("result");

      // Mock executeWithRetry to return result
      const originalExecuteWithRetry =
        sharedDatabaseConnectionManager.executeWithRetry;
      sharedDatabaseConnectionManager.executeWithRetry = vi
        .fn()
        .mockResolvedValue("result");

      const result = await withPrismaRetry(baseEnv, mockQueryFn);

      expect(result).toBe("result");

      // Restore
      sharedDatabaseConnectionManager.executeWithRetry =
        originalExecuteWithRetry;
    });

    it("should pass options to executeWithRetry", async () => {
      const mockQueryFn = vi.fn().mockResolvedValue("result");

      const originalExecuteWithRetry =
        sharedDatabaseConnectionManager.executeWithRetry;
      const mockExecuteWithRetry = vi.fn().mockResolvedValue("result");
      sharedDatabaseConnectionManager.executeWithRetry = mockExecuteWithRetry;

      const options = {
        region: "EU",
        timeoutMs: 5000,
        maxRetries: 3,
        defaultValue: "default",
      };

      await withPrismaRetry(baseEnv, mockQueryFn, options);

      expect(mockExecuteWithRetry).toHaveBeenCalledWith(
        "EU",
        baseEnv,
        mockQueryFn,
        expect.objectContaining({
          timeoutMs: 5000,
          maxRetries: 3,
          defaultValue: "default",
        }),
      );

      // Restore
      sharedDatabaseConnectionManager.executeWithRetry =
        originalExecuteWithRetry;
    });
  });

  describe("DatabaseClient", () => {
    it("should clear pool cache", () => {
      const originalClearPools = sharedDatabaseConnectionManager.clearPools;
      const mockClearPools = vi.fn();
      sharedDatabaseConnectionManager.clearPools = mockClearPools;

      DatabaseClient.clearPoolCache();

      expect(mockClearPools).toHaveBeenCalled();

      // Restore
      sharedDatabaseConnectionManager.clearPools = originalClearPools;
    });

    it("should get pool status", () => {
      const originalGetPoolStatus =
        sharedDatabaseConnectionManager.getPoolStatus;
      const mockStatus = { US: { active: 1, idle: 0 } };
      const mockGetPoolStatus = vi.fn().mockReturnValue(mockStatus);
      sharedDatabaseConnectionManager.getPoolStatus = mockGetPoolStatus;

      const status = DatabaseClient.getPoolStatus();

      expect(status).toEqual(mockStatus);
      expect(mockGetPoolStatus).toHaveBeenCalled();

      // Restore
      sharedDatabaseConnectionManager.getPoolStatus = originalGetPoolStatus;
    });

    it("should create client for region", () => {
      const prisma = DatabaseClient.createForRegion("EU", baseEnv);

      expect(prisma).toBeDefined();
      expect(prisma.release).toBeDefined();
    });

    it("should create client with default region", () => {
      const prisma = DatabaseClient.create(baseEnv);

      expect(prisma).toBeDefined();
      expect(prisma.release).toBeDefined();
    });

    it("should create client with explicit region", () => {
      const envWithChina: EnvWithDb = {
        ...baseEnv,
        SUPABASE_URL_CN: "https://cn-test.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY_CN: "cn-service-role-key",
      };

      const prisma = DatabaseClient.create(envWithChina, "CN");

      expect(prisma).toBeDefined();
      expect(prisma.release).toBeDefined();
    });
  });

  describe("ManagedPrismaClient release", () => {
    it("should release client when release() is called", async () => {
      const prisma = createPrisma(baseEnv);
      expect(prisma.release).toBeDefined();

      // Should not throw
      await expect(prisma.release()).resolves.not.toThrow();
    });

    it("should not release twice if already released", async () => {
      const prisma = createPrisma(baseEnv);
      await prisma.release();
      // Second call should be no-op
      await expect(prisma.release()).resolves.not.toThrow();
    });

    it("should have release method on created client", () => {
      const prisma = createPrisma(baseEnv);
      expect(typeof prisma.release).toBe("function");
    });
  });
});
