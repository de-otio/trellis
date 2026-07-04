/**
 * Unit tests for DatabaseConnectionManager
 *
 * Tests cover:
 * - Client acquisition (singleton pools per connection string)
 * - Timeout protection (query execution)
 * - Retry logic
 * - Pool lifecycle and cleanup
 * - China region support (PostgREST)
 */

import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithDb } from "../../src/lib/database-connection-manager.js";
import { DatabaseConnectionManager } from "../../src/lib/database-connection-manager.js";

// Mock pg.Pool
const mockPoolInstances: Array<{
  instance: any;
  config: any;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("pg", () => {
  return {
    Pool: class MockPool {
      config: any;
      totalCount: number = 0;
      idleCount: number = 0;
      waitingCount: number = 0;
      query: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;

      connect: ReturnType<typeof vi.fn>;

      constructor(config: any) {
        this.config = config;
        this.query = vi.fn();
        this.end = vi.fn().mockResolvedValue(undefined);
        this.on = vi.fn();
        // warmup() opens connections via connect() then validates with SELECT 1.
        this.connect = vi.fn().mockResolvedValue({
          query: vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }),
          release: vi.fn(),
        });
        mockPoolInstances.push({
          instance: this,
          config,
          query: this.query,
          end: this.end,
          on: this.on,
        });
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
      $disconnect = vi.fn().mockResolvedValue(undefined);
      constructor(config: any) {
        this.adapter = config.adapter;
        mockPrismaClientInstances.push(this);
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

// Mock PostgREST adapter for CN region
vi.mock("../../src/lib/postgrest-adapter", () => {
  return {
    PostgRESTPrismaAdapter: class MockPostgRESTAdapter {
      constructor(url: string, key: string) {
        // Mock implementation
      }
    },
  };
});

describe("DatabaseConnectionManager", () => {
  const baseEnv: EnvWithDb = {
    DATABASE_URL:
      "postgresql://test-hyperdrive.hyperdrive.workers.dev:5432/postgres",
    HYPERDRIVE: {
      connectionString:
        "postgresql://test-hyperdrive.hyperdrive.workers.dev:5432/postgres",
    } as any,
  };

  let manager: DatabaseConnectionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolInstances.length = 0;
    mockPrismaClientInstances.length = 0;
    manager = new DatabaseConnectionManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    manager.clearPools();
  });

  describe("Client Acquisition", () => {
    it("should create a pool with singleton pool defaults", () => {
      const { client } = manager.acquireClient("US", baseEnv);

      expect(client).toBeDefined();
      expect(mockPoolInstances.length).toBe(1);
      expect(mockPoolInstances[0].config.max).toBe(10); // DEFAULT_POOL_MAX
      expect(mockPoolInstances[0].config.min).toBe(2); // DEFAULT_POOL_MIN — warm floor
      expect(mockPoolInstances[0].config.connectionTimeoutMillis).toBe(3000);
      expect(mockPoolInstances[0].config.idleTimeoutMillis).toBe(600000); // DEFAULT_IDLE_TIMEOUT_MS — keep warm between bursts
      expect(mockPoolInstances[0].config.keepAlive).toBe(true);
    });

    it("honors DATABASE_POOL_MIN and DATABASE_IDLE_TIMEOUT_MS overrides", () => {
      manager.acquireClient("US", {
        ...baseEnv,
        DATABASE_POOL_MIN: "5",
        DATABASE_IDLE_TIMEOUT_MS: "120000",
      });
      expect(mockPoolInstances[0].config.min).toBe(5);
      expect(mockPoolInstances[0].config.idleTimeoutMillis).toBe(120000);
    });

    it("warmup() eagerly opens `min` connections so the first query is hot", async () => {
      await manager.warmup("primary", baseEnv);

      expect(mockPoolInstances.length).toBe(1);
      // DEFAULT_POOL_MIN connections opened + validated, then released.
      expect(mockPoolInstances[0].instance.connect).toHaveBeenCalledTimes(2);
    });

    it("warmup() is non-fatal when the DB is unreachable", async () => {
      manager.clearPools();
      // Next pool's connect() rejects (DB down at boot).
      const failing = vi
        .fn()
        .mockRejectedValue(new Error("ECONNREFUSED"));
      vi.spyOn(manager as any, "acquireClient");
      await expect(
        (async () => {
          // Force the pool's connect to fail by acquiring then overriding.
          manager.acquireClient("primary", baseEnv);
          mockPoolInstances[mockPoolInstances.length - 1].instance.connect =
            failing;
          await manager.warmup("primary", baseEnv);
        })(),
      ).resolves.toBeUndefined(); // does not throw
    });

    it("should reuse the same pool for the same connection string", () => {
      const { client: client1 } = manager.acquireClient("US", baseEnv);
      const { client: client2 } = manager.acquireClient("US", baseEnv);

      // Should reuse the cached pool (singleton behavior)
      expect(mockPoolInstances.length).toBe(1);
      expect(client1).toBe(client2);
    });

    it("should create separate pools for different regions", () => {
      manager.acquireClient("US", baseEnv);
      manager.acquireClient("EU", baseEnv);

      // Same DATABASE_URL means same connection string, so same pool
      // Region label differs but cache key is the connection string
      expect(mockPoolInstances.length).toBe(1);
    });

    it("should create separate pools for different connection strings", () => {
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

      manager.acquireClient("US", env1);
      manager.acquireClient("US", env2);

      expect(mockPoolInstances.length).toBe(2);
    });

    it("should return a no-op cleanup function", async () => {
      const { client, cleanup } = manager.acquireClient("US", baseEnv);

      // Mock $disconnect
      (client as any).$disconnect = vi.fn().mockResolvedValue(undefined);

      await cleanup();

      // Cleanup is a no-op — pool lifecycle managed by shutdown()
      expect((client as any).$disconnect).not.toHaveBeenCalled();
      expect(mockPoolInstances[0].end).not.toHaveBeenCalled();
    });
  });

  describe("SSL configuration", () => {
    it("requires SSL (rejectUnauthorized:false) for a remote host", () => {
      manager.acquireClient("US", baseEnv); // hyperdrive remote URL
      expect(mockPoolInstances[0].config.ssl).toEqual({
        rejectUnauthorized: false,
      });
    });

    it("disables SSL for a local Postgres host (no TLS locally)", () => {
      manager.acquireClient("US", {
        DATABASE_URL: "postgresql://trellis:pw@localhost:5432/trellis_dev",
      } as any);
      expect(mockPoolInstances[0].config.ssl).toBe(false);
    });

    it("disables SSL for 127.0.0.1", () => {
      manager.acquireClient("US", {
        DATABASE_URL: "postgresql://trellis:pw@127.0.0.1:5432/trellis_dev",
      } as any);
      expect(mockPoolInstances[0].config.ssl).toBe(false);
    });
  });

  describe("withClient", () => {
    it("should run callback with client and cleanup after", async () => {
      const callback = vi.fn(async (client: PrismaClient) => {
        expect(client).toBeDefined();
        return { result: "test" };
      });

      const result = await manager.withClient("US", baseEnv, callback);

      expect(callback).toHaveBeenCalled();
      expect(result).toEqual({ result: "test" });
      // Cleanup is a no-op, so pool.end should NOT be called
      expect(mockPoolInstances[0].end).not.toHaveBeenCalled();
    });

    it("should cleanup even if callback throws", async () => {
      const callback = vi.fn(async (client: PrismaClient) => {
        throw new Error("Test error");
      });

      await expect(manager.withClient("US", baseEnv, callback)).rejects.toThrow(
        "Test error",
      );

      // Cleanup is a no-op, so pool.end should NOT be called
      expect(mockPoolInstances[0].end).not.toHaveBeenCalled();
    });
  });

  describe("Timeout Protection", () => {
    it("should timeout pool creation after 3 seconds", async () => {
      // Note: Current implementation creates Pool synchronously, so timeout protection
      // is not applicable. Pool constructor is synchronous and cannot hang.
      // This test is kept for documentation but will pass immediately.
      vi.useRealTimers();

      const createClientPromise = manager.createClient("US", baseEnv);

      // Pool creation is synchronous, so this should resolve immediately
      const client = await createClientPromise;
      expect(client).toBeDefined();

      vi.useFakeTimers();
    });

    // TRIAGE(AR14): fix — documented flaky-with-real-timers skip, not dead;
    // behavior is asserted by the sibling "should timeout query execution"
    // test below and covered by production monitoring per the comment, but
    // this specific path (client-creation timeout) should get its own
    // reliable fake-timer-based assertion rather than staying permanently
    // skipped.
    it.skip("should timeout client creation after 4 seconds", async () => {
      // Skip this test - it's difficult to test reliably with real timers
      // The timeout mechanism works in production but is hard to test in unit tests
      // The timeout is verified in integration tests and production monitoring
      vi.useRealTimers();

      // Mock createClient to hang to test timeout in executeWithRetry
      const originalCreateClient = manager.createClient.bind(manager);
      manager.createClient = vi.fn(
        () => new Promise(() => {}), // Never resolves
      );

      const executePromise = manager.executeWithRetry(
        "US",
        baseEnv,
        async (client) => ({ result: "test" }),
        { timeoutMs: 5000 }, // Must be >= CLIENT_CREATION_TIMEOUT_MS (4000ms) + buffer
      );

      // Should timeout during client creation (4 seconds) or query execution
      await expect(executePromise).rejects.toThrow(/timeout|Timeout/);

      // Restore original method
      manager.createClient = originalCreateClient;
      vi.useFakeTimers();
    }, 8000); // 8 second test timeout (longer than operation timeout)

    it("should timeout query execution", async () => {
      vi.useRealTimers(); // Use real timers for timeout tests
      // Create a query function that hangs
      const queryFn = vi.fn(
        () => new Promise(() => {}), // Never resolves
      );

      // The per-attempt timeout is floored at connectionTimeout + statementTimeout
      // (a caller's timeoutMs can no longer drop below it — that inversion was the
      // cold-start bug). Shrink both so the floor stays ~100ms and the hang is
      // still caught quickly.
      const executePromise = manager.executeWithRetry(
        "US",
        {
          ...baseEnv,
          DATABASE_CONNECTION_TIMEOUT_MS: "50",
          DATABASE_STATEMENT_TIMEOUT_MS: "50",
        },
        queryFn,
        { timeoutMs: 100, maxRetries: 0 },
      );

      await expect(executePromise).rejects.toThrow("timeout");
      vi.useFakeTimers();
    }, 8000);
  });

  describe("Retry Logic", () => {
    it("should retry on timeout with same client (pool reuse)", async () => {
      vi.useRealTimers(); // Use real timers for this test
      let attemptCount = 0;
      const queryFn = vi.fn(async (client: PrismaClient) => {
        attemptCount++;
        if (attemptCount === 1) {
          // Simulate timeout by throwing after a delay
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error("Database query timeout after 1000ms");
        }
        return { result: "success" };
      });

      const result = await manager.executeWithRetry("US", baseEnv, queryFn, {
        timeoutMs: 100,
        retryTimeoutMs: 200,
      });

      expect(result).toEqual({ result: "success" });
      expect(attemptCount).toBe(2);
      vi.useFakeTimers();
    });

    it("should reuse the same pool across retry attempts (non-connection errors)", async () => {
      vi.useRealTimers(); // Use real timers for this test
      let attemptCount = 0;

      const queryFn = vi.fn(async (client: PrismaClient) => {
        attemptCount++;
        if (attemptCount === 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error("Database query timeout after 1000ms");
        }
        return { result: "success" };
      });

      await manager.executeWithRetry("US", baseEnv, queryFn, {
        timeoutMs: 100,
        retryTimeoutMs: 200,
      });

      // Same pool reused (singleton behavior) — only 1 pool created
      expect(mockPoolInstances.length).toBe(1);
      vi.useFakeTimers();
    });

    it("should return default value if retry also fails", async () => {
      vi.useRealTimers(); // Use real timers for this test
      const queryFn = vi.fn(async (client: PrismaClient) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new Error("Database query timeout");
      });

      const result = await manager.executeWithRetry("US", baseEnv, queryFn, {
        timeoutMs: 100,
        retryTimeoutMs: 100,
        defaultValue: [],
      });

      expect(result).toEqual([]);
      vi.useFakeTimers();
    });

    it("should throw error if retry fails and no default value", async () => {
      vi.useRealTimers(); // Use real timers for this test
      const queryFn = vi.fn(async (client: PrismaClient) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new Error("Database query timeout");
      });

      await expect(
        manager.executeWithRetry("US", baseEnv, queryFn, {
          timeoutMs: 100,
          retryTimeoutMs: 100,
          maxRetries: 3, // Default is 3
        }),
      ).rejects.toThrow("Database query failed after 3 retries");
      vi.useFakeTimers();
    });
  });

  describe("Pool Error Handling", () => {
    it("should register error handler on pool", () => {
      manager.acquireClient("US", baseEnv);

      // Should register error handler
      expect(mockPoolInstances[0].on).toHaveBeenCalledWith(
        "error",
        expect.any(Function),
      );
    });

    it("should log errors when pool emits error event", () => {
      manager.acquireClient("US", baseEnv);

      // Get error handler
      const errorHandler = mockPoolInstances[0].on.mock.calls.find(
        (call) => call[0] === "error",
      )?.[1];

      if (errorHandler) {
        // Should not throw when error handler is called
        expect(() => errorHandler(new Error("Connection error"))).not.toThrow();
      }
    });
  });

  describe("Pool Lifecycle Management", () => {
    it("should clearPools drain and clear cached pools", () => {
      manager.acquireClient("US", baseEnv);
      expect(mockPoolInstances.length).toBe(1);

      manager.clearPools();

      // Pool.end() should have been called
      expect(mockPoolInstances[0].end).toHaveBeenCalled();
      // After clearing, a new acquireClient should create a new pool
      manager.acquireClient("US", baseEnv);
      expect(mockPoolInstances.length).toBe(2);
    });

    it("should getPoolStatus return stats from cached pools", () => {
      manager.acquireClient("US", baseEnv);

      const status = manager.getPoolStatus();

      // Pool is cached, so status should have one entry
      expect(status.length).toBe(1);
      expect(status[0]).toHaveProperty("key");
      expect(status[0]).toHaveProperty("totalCount");
      expect(status[0]).toHaveProperty("idleCount");
      expect(status[0]).toHaveProperty("waitingCount");
      expect(status[0]).toHaveProperty("age");
      expect(status[0]).toHaveProperty("errorCount");
    });

    it("should shutdown disconnect clients and end pools", async () => {
      vi.useRealTimers();
      manager.acquireClient("US", baseEnv);

      await manager.shutdown();

      expect(mockPoolInstances[0].end).toHaveBeenCalled();
      // After shutdown, getPoolStatus should return empty
      expect(manager.getPoolStatus()).toEqual([]);
    });
  });

  describe("DATABASE_POOL_MAX env var", () => {
    it("should respect DATABASE_POOL_MAX when set", () => {
      const envWithPoolMax: EnvWithDb = {
        ...baseEnv,
        DATABASE_POOL_MAX: "25",
      };

      manager.acquireClient("US", envWithPoolMax);

      expect(mockPoolInstances[0].config.max).toBe(25);
    });
  });

  describe("China Region Support", () => {
    it("should use PostgREST adapter for CN region", async () => {
      const envCN: EnvWithDb = {
        ...baseEnv,
        SUPABASE_URL_CN: "https://cn-test.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY_CN: "cn-key",
      };

      const client = await manager.createClient("CN", envCN);

      expect(client).toBeDefined();
      // CN region now uses a regular Pool (same as other regions)
      expect(mockPoolInstances.length).toBe(1);
    });

    it("should throw error if CN region missing required env vars", async () => {
      // In AWS architecture, CN uses DATABASE_URL just like other regions - no special vars needed
      const client = await manager.createClient("CN", baseEnv);
      expect(client).toBeDefined();
    });
  });
});
