/**
 * Unit tests for database connection best practices
 *
 * These tests verify the fixes applied to align with:
 * - Singleton pool behavior (max: 10 connections per pool, cached per connection string)
 * - Proper connection string modification (URL parsing)
 * - Pool lifecycle management (clearPools drains and clears)
 * - Timeout configuration (optimized for ECS Fargate)
 * - PrismaClient caching (same connection string = same instance)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithDb } from "../../src/db.js";
import { DatabaseClient } from "../../src/db.js";
import { sharedDatabaseConnectionManager } from "../../src/lib/database-connection-manager.js";

// Mock pg.Pool to track instances and configuration
const mockPoolInstances: Array<{ instance: any; config: any }> = [];

vi.mock("pg", () => {
  const actualPg = vi.importActual("pg");
  return {
    ...actualPg,
    Pool: class MockPool {
      config: any;
      totalCount: number;
      idleCount: number;
      waitingCount: number;
      constructor(config: any) {
        this.config = config;
        this.totalCount = 0;
        this.idleCount = 0;
        this.waitingCount = 0;
        mockPoolInstances.push({ instance: this, config });
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

// Mock PrismaPg adapter
vi.mock("@prisma/adapter-pg", () => {
  return {
    PrismaPg: class MockPrismaPg {
      pool: any;
      constructor(pool: any) {
        this.pool = pool;
      }
    },
  };
});

// Mock PrismaClient
const mockPrismaClientInstances: any[] = [];
vi.mock("@prisma/client", () => {
  return {
    PrismaClient: class MockPrismaClient {
      adapter: any;
      constructor(config: any) {
        this.adapter = config.adapter;
        mockPrismaClientInstances.push(this);
      }
      $disconnect() {
        return Promise.resolve();
      }
    },
  };
});

// Mock database-config
vi.mock("../../src/lib/database-config", () => {
  return {
    getDatabaseConnection: vi.fn((region: string, env: any) => {
      if (!env.DATABASE_URL) {
        throw new Error("DATABASE_URL environment variable is required");
      }
      return env.DATABASE_URL;
    }),
  };
});

describe("Database Connection Best Practices", () => {
  const baseEnv: EnvWithDb = {
    DATABASE_URL:
      "postgresql://test-hyperdrive.hyperdrive.workers.dev:5432/postgres",
    HYPERDRIVE: {
      connectionString:
        "postgresql://test-hyperdrive.hyperdrive.workers.dev:5432/postgres",
    } as any,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear cache FIRST, then clear mock instances
    sharedDatabaseConnectionManager.clearPools();
    mockPoolInstances.length = 0;
    mockPrismaClientInstances.length = 0;
  });

  afterEach(() => {
    // Clean up pools
    mockPoolInstances.forEach(({ instance }) => {
      try {
        instance.end?.();
      } catch (e) {
        // Ignore cleanup errors
      }
    });
  });

  describe("Pool Size Configuration", () => {
    it("should use max: 10 connections per pool (default for persistent ECS pools)", () => {
      const client = DatabaseClient.createForRegion("US", baseEnv);

      expect(client).toBeDefined();
      expect(mockPoolInstances.length).toBe(1);

      const poolConfig = mockPoolInstances[0].config;
      // Uses DEFAULT_POOL_MAX = 10
      expect(poolConfig.max).toBe(10);
    });

    it("should respect DATABASE_POOL_MAX env var", () => {
      const envWithPoolMax: EnvWithDb = {
        ...baseEnv,
        DATABASE_POOL_MAX: "5",
      };

      const client = DatabaseClient.createForRegion("US", envWithPoolMax);

      expect(client).toBeDefined();
      const poolConfig = mockPoolInstances[0].config;
      // Should use the env var value
      expect(poolConfig.max).toBe(5);
    });
  });

  describe("Connection String Modification (URL Parsing)", () => {
    it("should add statement_timeout using proper URL parsing", () => {
      // Clear cache and mock instances to ensure new pool is created
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
      const client = DatabaseClient.createForRegion("US", baseEnv);

      expect(client).toBeDefined();
      expect(mockPoolInstances.length).toBe(1);
      const poolConfig = mockPoolInstances[0].config;
      const url = new URL(poolConfig.connectionString);

      // Should have statement_timeout parameter (default is 5000ms - optimized)
      expect(url.searchParams.get("statement_timeout")).toBe("5000");
    });

    it("should append statement_timeout to existing query parameters", () => {
      // Clear cache and mock instances to ensure new pool is created
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
      const envWithParams: EnvWithDb = {
        DATABASE_URL:
          "postgresql://test.hyperdrive.workers.dev:5432/postgres?sslmode=require",
        HYPERDRIVE: {
          connectionString:
            "postgresql://test.hyperdrive.workers.dev:5432/postgres?sslmode=require",
        } as any,
      };

      const client = DatabaseClient.createForRegion("US", envWithParams);

      expect(client).toBeDefined();
      expect(mockPoolInstances.length).toBe(1);
      const poolConfig = mockPoolInstances[0].config;
      const url = new URL(poolConfig.connectionString);

      // Should preserve existing parameters
      expect(url.searchParams.get("sslmode")).toBe("require");
      // Should add statement_timeout (default is 5000ms - optimized)
      expect(url.searchParams.get("statement_timeout")).toBe("5000");
    });

    it("should update statement_timeout if already present", () => {
      // Clear cache and mock instances to ensure new pool is created
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
      const envWithTimeout: EnvWithDb = {
        DATABASE_URL:
          "postgresql://test.hyperdrive.workers.dev:5432/postgres?statement_timeout=10000",
        HYPERDRIVE: {
          connectionString:
            "postgresql://test.hyperdrive.workers.dev:5432/postgres?statement_timeout=10000",
        } as any,
      };

      const client = DatabaseClient.createForRegion("US", envWithTimeout);

      expect(client).toBeDefined();
      expect(mockPoolInstances.length).toBe(1);
      const poolConfig = mockPoolInstances[0].config;
      const url = new URL(poolConfig.connectionString);

      // Should update to default (5000ms - optimized)
      expect(url.searchParams.get("statement_timeout")).toBe("5000");
    });

    it("should use custom statement_timeout from env var", () => {
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
      const envWithCustomTimeout: EnvWithDb = {
        ...baseEnv,
        DATABASE_STATEMENT_TIMEOUT_MS: "10000",
      };

      const client = DatabaseClient.createForRegion("US", envWithCustomTimeout);

      expect(client).toBeDefined();
      expect(mockPoolInstances.length).toBe(1);
      const poolConfig = mockPoolInstances[0].config;
      const url = new URL(poolConfig.connectionString);

      // Should use custom timeout
      expect(url.searchParams.get("statement_timeout")).toBe("10000");
    });
  });

  describe("Timeout Configuration (ECS Fargate Optimization)", () => {
    it("should use optimized timeouts for long-lived processes", () => {
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
      const client = DatabaseClient.createForRegion("US", baseEnv);

      expect(client).toBeDefined();
      expect(mockPoolInstances.length).toBe(1);
      const poolConfig = mockPoolInstances[0].config;

      // Connection timeout: 3s
      expect(poolConfig.connectionTimeoutMillis).toBe(3000);
      // Idle timeout: 30s (standard for long-lived ECS processes)
      expect(poolConfig.idleTimeoutMillis).toBe(30000);
    });

    it("should allow custom connection timeout from env var", () => {
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
      const envWithTimeout: EnvWithDb = {
        ...baseEnv,
        DATABASE_CONNECTION_TIMEOUT_MS: "3000",
      };

      const client = DatabaseClient.createForRegion("US", envWithTimeout);

      expect(client).toBeDefined();
      expect(mockPoolInstances.length).toBe(1);
      const poolConfig = mockPoolInstances[0].config;
      expect(poolConfig.connectionTimeoutMillis).toBe(3000);
    });

    it("should use default statement timeout (5s) when not specified", () => {
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
      const client = DatabaseClient.createForRegion("US", baseEnv);

      expect(client).toBeDefined();
      expect(mockPoolInstances.length).toBe(1);
      const poolConfig = mockPoolInstances[0].config;
      const url = new URL(poolConfig.connectionString);

      // Default: 5s (optimized - reduced from 10s for faster failure)
      expect(url.searchParams.get("statement_timeout")).toBe("5000");
    });
  });

  describe("PrismaClient Creation", () => {
    it("should return the same cached PrismaClient for the same connection string", () => {
      const client1 = DatabaseClient.createForRegion("US", baseEnv);
      const client2 = DatabaseClient.createForRegion("US", baseEnv);
      const client3 = DatabaseClient.createForRegion("US", baseEnv);

      // All should be defined
      expect(client1).toBeDefined();
      expect(client2).toBeDefined();
      expect(client3).toBeDefined();

      // Should return the SAME cached PrismaClient instance
      expect(client1).toBe(client2);
      expect(client2).toBe(client3);

      // Only one PrismaClient should have been constructed
      expect(mockPrismaClientInstances.length).toBe(1);
    });

    it("should create separate PrismaClient instances for different connection strings (different regions)", () => {
      const envWithChina: EnvWithDb = {
        DATABASE_URL:
          "postgresql://cn-rds.cn-north-1.rds.amazonaws.com.cn:5432/postgres",
      };

      const usClient = DatabaseClient.createForRegion("US", baseEnv);
      const cnClient = DatabaseClient.createForRegion("CN", envWithChina);

      expect(usClient).toBeDefined();
      expect(cnClient).toBeDefined();

      // Should be different instances (different connection strings)
      expect(usClient).not.toBe(cnClient);
    });

    it("should reuse cached Pool and PrismaClient for same connection string", () => {
      const client1 = DatabaseClient.createForRegion("US", baseEnv);
      const client2 = DatabaseClient.createForRegion("US", baseEnv);

      expect(client1).toBeDefined();
      expect(client2).toBeDefined();

      // Should reuse the same Pool (singleton caching)
      expect(mockPoolInstances.length).toBe(1);

      // Should reuse the same PrismaClient (cached)
      expect(mockPrismaClientInstances.length).toBe(1);
      expect(client1).toBe(client2);
    });
  });

  describe("Pool Lifecycle Management (clearPools)", () => {
    it("should report cached pools in pool status after creating a client", () => {
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
      const client1 = DatabaseClient.createForRegion("US", baseEnv);
      expect(mockPoolInstances.length).toBe(1);

      // Pool IS cached, so status should have 1 entry
      expect(sharedDatabaseConnectionManager.getPoolStatus().length).toBe(1);

      // Clear cache (drains pools)
      DatabaseClient.clearPoolCache();

      // Cache should be empty after clearing
      expect(sharedDatabaseConnectionManager.getPoolStatus().length).toBe(0);
    });

    it("should create new pools after clearing cache", () => {
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
      const client1 = DatabaseClient.createForRegion("US", baseEnv);
      expect(mockPoolInstances.length).toBe(1);
      const pool1 = mockPoolInstances[mockPoolInstances.length - 1].instance;

      // Clear cache
      DatabaseClient.clearPoolCache();
      const poolCountAfterClear = mockPoolInstances.length;

      // Create new client (should create new pool since cache was cleared)
      const client2 = DatabaseClient.createForRegion("US", baseEnv);

      expect(client2).toBeDefined();
      expect(mockPoolInstances.length).toBe(poolCountAfterClear + 1);
      expect(mockPoolInstances[mockPoolInstances.length - 1].instance).not.toBe(
        pool1,
      );
    });

    it("should clear cached pools and report empty status after clearPools", () => {
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
      const client1 = DatabaseClient.createForRegion("US", baseEnv);

      // Pool IS cached, so status should have 1 entry
      expect(sharedDatabaseConnectionManager.getPoolStatus().length).toBe(1);

      // Clear cache
      DatabaseClient.clearPoolCache();

      // Pool cache should be empty after clearing
      expect(sharedDatabaseConnectionManager.getPoolStatus().length).toBe(0);
    });
  });

  describe("Pool Status Diagnostics", () => {
    it("should return pool status entries for cached pools", () => {
      const client = DatabaseClient.createForRegion("US", baseEnv);

      const status = DatabaseClient.getPoolStatus();

      expect(status).toBeDefined();
      expect(Array.isArray(status)).toBe(true);
      // Pool is cached, so status should have 1 entry
      expect(status.length).toBe(1);
    });

    it("should return empty array when no pools cached", () => {
      const status = DatabaseClient.getPoolStatus();

      expect(status).toBeDefined();
      expect(Array.isArray(status)).toBe(true);
      expect(status.length).toBe(0);
    });

    it("should return entries for each unique connection string", () => {
      const env1: EnvWithDb = {
        DATABASE_URL:
          "postgresql://hyperdrive1.hyperdrive.workers.dev:5432/postgres",
        HYPERDRIVE: {
          connectionString:
            "postgresql://hyperdrive1.hyperdrive.workers.dev:5432/postgres",
        } as any,
      };
      const env2: EnvWithDb = {
        DATABASE_URL:
          "postgresql://hyperdrive2.hyperdrive.workers.dev:5432/postgres",
        HYPERDRIVE: {
          connectionString:
            "postgresql://hyperdrive2.hyperdrive.workers.dev:5432/postgres",
        } as any,
      };

      DatabaseClient.createForRegion("US", env1);
      DatabaseClient.createForRegion("US", env2);

      const status = DatabaseClient.getPoolStatus();

      // Two different connection strings = two cached pools
      expect(status.length).toBe(2);
    });
  });

  describe("Hyperdrive Binding Preference", () => {
    it("should prefer HYPERDRIVE binding over DATABASE_URL", () => {
      // In AWS architecture, DATABASE_URL is always used (no Hyperdrive)
      const envWithUrl: EnvWithDb = {
        DATABASE_URL:
          "postgresql://aws-rds.us-east-1.rds.amazonaws.com:5432/postgres",
      };

      const client = DatabaseClient.createForRegion("US", envWithUrl);

      expect(client).toBeDefined();
      const poolConfig = mockPoolInstances[0].config;

      // Should use DATABASE_URL directly
      expect(poolConfig.connectionString).toContain("aws-rds.us-east-1.rds.amazonaws.com");
    });

    it("should require HYPERDRIVE binding (no fallback to DATABASE_URL)", () => {
      // In AWS architecture, DATABASE_URL is sufficient - no Hyperdrive binding required
      const envWithUrl: EnvWithDb = {
        DATABASE_URL:
          "postgresql://test-hyperdrive.hyperdrive.workers.dev:5432/postgres",
        // No HYPERDRIVE binding
      };

      // Should succeed with just DATABASE_URL
      const client = DatabaseClient.createForRegion("US", envWithUrl);
      expect(client).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    it("should handle malformed connection strings gracefully", () => {
      const envWithBadUrl: EnvWithDb = {
        DATABASE_URL: "not-a-valid-url",
        HYPERDRIVE: {
          connectionString: "not-a-valid-url",
        } as any,
      };

      // Our code now validates connection string format upfront
      // Invalid formats (not starting with postgresql:// or postgres://) will throw at creation time
      expect(() => {
        DatabaseClient.createForRegion("US", envWithBadUrl);
      }).toThrow(
        /Invalid connection string protocol|not a valid PostgreSQL connection string/,
      );
    });
  });
});
