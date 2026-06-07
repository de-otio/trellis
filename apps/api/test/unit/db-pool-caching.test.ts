/**
 * Unit tests for database pool caching to prevent connection leaks
 *
 * These tests verify that:
 * 1. Pool instances are reused (same connection string = same pool)
 * 2. Different regions get different pools
 * 3. Different connection strings get different pools
 * 4. Pool configuration is correct (max: 10, idleTimeout: 30000)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithDb } from "../../src/db.js";
import { DatabaseClient } from "../../src/db.js";
import { sharedDatabaseConnectionManager } from "../../src/lib/database-connection-manager.js";

// Mock pg.Pool to track instances
const mockPoolInstances: any[] = [];

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
        mockPoolInstances.push(this);
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
vi.mock("@prisma/client", () => {
  return {
    PrismaClient: class MockPrismaClient {
      adapter: any;
      constructor(config: any) {
        this.adapter = config.adapter;
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

describe("Database Pool Caching", () => {
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
    mockPoolInstances.length = 0;
    // Clear pool cache before each test
    sharedDatabaseConnectionManager.clearPools();
    mockPoolInstances.length = 0; // clearPools may trigger Pool constructor via end(); reset again
  });

  afterEach(() => {
    // Clean up pools
    mockPoolInstances.forEach((pool) => {
      try {
        pool.end?.();
      } catch (e) {
        // Ignore cleanup errors
      }
    });
  });

  describe("Pool instance reuse", () => {
    it("should reuse the same Pool instance for the same connection string (singleton caching)", () => {
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
      const client1 = DatabaseClient.createForRegion("US", baseEnv);
      const client2 = DatabaseClient.createForRegion("US", baseEnv);
      const client3 = DatabaseClient.createForRegion("US", baseEnv);

      // All clients should be created
      expect(client1).toBeDefined();
      expect(client2).toBeDefined();
      expect(client3).toBeDefined();

      // Same connection string = same cached pool (only 1 pool created)
      expect(mockPoolInstances.length).toBe(1);
      expect(mockPoolInstances[0]).toBeDefined();

      // All clients should be the same cached instance
      expect(client1).toBe(client2);
      expect(client2).toBe(client3);
    });

    it("should create separate Pool instances for different connection strings (different regions)", () => {
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
      const envWithChina: EnvWithDb = {
        DATABASE_URL:
          "postgresql://cn-rds.cn-north-1.rds.amazonaws.com.cn:5432/postgres",
      };

      const usClient = DatabaseClient.createForRegion("US", baseEnv);
      const cnClient = DatabaseClient.createForRegion("CN", envWithChina);

      expect(usClient).toBeDefined();
      expect(cnClient).toBeDefined();

      // CN region now uses a regular Pool (same as other regions in AWS architecture)
      expect(mockPoolInstances.length).toBe(2);
    });

    it("should create separate Pool instances for different connection strings", () => {
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
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

      const client1 = DatabaseClient.createForRegion("US", env1);
      const client2 = DatabaseClient.createForRegion("US", env2);

      expect(client1).toBeDefined();
      expect(client2).toBeDefined();

      // Two different connection strings should create two different pools
      expect(mockPoolInstances.length).toBe(2);
      expect(mockPoolInstances[0]).not.toBe(mockPoolInstances[1]);
    });

    it("should reuse the same Pool for same Hyperdrive binding (singleton caching)", () => {
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
      const envWithHyperdrive: EnvWithDb = {
        DATABASE_URL:
          "postgresql://fallback.hyperdrive.workers.dev:5432/postgres",
        HYPERDRIVE: {
          connectionString:
            "postgresql://hyperdrive-binding.hyperdrive.workers.dev:5432/postgres",
        } as any,
      };

      const client1 = DatabaseClient.createForRegion("US", envWithHyperdrive);
      const client2 = DatabaseClient.createForRegion("US", envWithHyperdrive);

      expect(client1).toBeDefined();
      expect(client2).toBeDefined();

      // Same connection string = same cached pool (only 1 pool created)
      expect(mockPoolInstances.length).toBe(1);
    });
  });

  describe("Pool configuration", () => {
    it("should use default pool configuration when env vars not set", () => {
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
      const client = DatabaseClient.createForRegion("US", baseEnv);

      expect(client).toBeDefined();
      expect(mockPoolInstances.length).toBe(1);

      const poolConfig = mockPoolInstances[0].config;
      expect(poolConfig.max).toBe(10); // DEFAULT_POOL_MAX for persistent pools
      expect(poolConfig.min).toBe(2); // DEFAULT_POOL_MIN — warm floor
      expect(poolConfig.connectionTimeoutMillis).toBe(3000); // DEFAULT_CONNECTION_TIMEOUT_MS
      expect(poolConfig.idleTimeoutMillis).toBe(600000); // DEFAULT_IDLE_TIMEOUT_MS (10min — keep warm between bursts)
      expect(poolConfig.connectionString).toContain("statement_timeout=5000");
    });

    it("should use custom connection timeout from environment variables and respect DATABASE_POOL_MAX", () => {
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
      const envWithConfig: EnvWithDb = {
        ...baseEnv,
        DATABASE_CONNECTION_TIMEOUT_MS: "8000",
        DATABASE_STATEMENT_TIMEOUT_MS: "12000",
      };

      const client = DatabaseClient.createForRegion("US", envWithConfig);

      expect(client).toBeDefined();
      expect(mockPoolInstances.length).toBe(1);

      const poolConfig = mockPoolInstances[0].config;
      // Pool max defaults to 10
      expect(poolConfig.max).toBe(10);
      // Connection timeout should use custom value
      expect(poolConfig.connectionTimeoutMillis).toBe(8000);
      // Statement timeout should be in connection string
      expect(poolConfig.connectionString).toContain("statement_timeout=12000");
    });

    it("should add statement_timeout to connection string", () => {
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
      const client = DatabaseClient.createForRegion("US", baseEnv);

      expect(client).toBeDefined();
      expect(mockPoolInstances.length).toBe(1);
      const poolConfig = mockPoolInstances[0].config;
      expect(poolConfig.connectionString).toContain("statement_timeout=5000");
    });

    it("should append statement_timeout to existing query parameters", () => {
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
      expect(poolConfig.connectionString).toContain("sslmode=require");
      expect(poolConfig.connectionString).toContain("statement_timeout=5000");
    });
  });

  describe("Connection leak prevention", () => {
    it("should reuse the same pool for repeated calls with the same connection string", () => {
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
      // Simulate multiple requests creating PrismaClient instances
      for (let i = 0; i < 10; i++) {
        DatabaseClient.createForRegion("US", baseEnv);
      }

      // Same connection string = same cached pool (only 1 pool created)
      expect(mockPoolInstances.length).toBe(1);
    });

    it("should reuse the same pool for concurrent requests with same connection string", async () => {
      sharedDatabaseConnectionManager.clearPools();
      mockPoolInstances.length = 0;
      // Simulate concurrent requests
      const promises = Array.from({ length: 5 }, () =>
        Promise.resolve(DatabaseClient.createForRegion("US", baseEnv)),
      );

      await Promise.all(promises);

      // Same connection string = same cached pool (only 1 pool created)
      expect(mockPoolInstances.length).toBe(1);
    });
  });
});
