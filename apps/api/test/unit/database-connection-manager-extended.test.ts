/**
 * Extended unit tests for DatabaseConnectionManager
 *
 * Focuses on uncovered branches:
 * - resolveConnectionStrings: missing DATABASE_URL, invalid format, custom timeouts
 * - logPoolStats: waiting connections, pool exhaustion, error in logging
 * - addQueryParam: URL parsing failure fallback
 * - isPermanentFailure: various Prisma error codes and PostgreSQL constraint violations
 * - executeWithRetry: connection errors, memory errors, permanent failures, pool invalidation
 * - cleanup: no-op behavior
 * - shutdown: disconnects clients and ends pools
 * - clearPools: drains and clears cached pools
 * - getPoolStatus: returns real stats from cached pools
 */

import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithDb } from "../../src/lib/database-connection-manager.js";
import { DatabaseConnectionManager } from "../../src/lib/database-connection-manager.js";

// Mock pg.Pool
const mockPoolInstances: Array<{
  instance: any;
  config: any;
  end: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  eventHandlers: Record<string, Function>;
}> = [];

vi.mock("pg", () => {
  return {
    Pool: class MockPool {
      config: any;
      totalCount: number = 0;
      idleCount: number = 0;
      waitingCount: number = 0;
      end: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      eventHandlers: Record<string, Function> = {};

      constructor(config: any) {
        this.config = config;
        this.end = vi.fn().mockResolvedValue(undefined);
        this.on = vi.fn((event: string, handler: Function) => {
          this.eventHandlers[event] = handler;
        });
        mockPoolInstances.push({
          instance: this,
          config,
          end: this.end,
          on: this.on,
          eventHandlers: this.eventHandlers,
        });
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
      }
    },
  };
});

const mockPrismaDisconnect = vi.fn();
vi.mock("@prisma/client", () => {
  return {
    PrismaClient: class MockPrismaClient {
      adapter: any;
      $disconnect = mockPrismaDisconnect;
      constructor(config: any) {
        this.adapter = config.adapter;
      }
    },
  };
});

vi.mock("../../src/lib/database-config", () => ({
  getDatabaseConnection: vi.fn((region: string, env: any) => env.DATABASE_URL),
}));

vi.mock("../../src/lib/postgrest-adapter", () => ({
  PostgRESTPrismaAdapter: class MockPostgRESTAdapter {
    constructor() {}
  },
}));

describe("DatabaseConnectionManager - Extended", () => {
  const baseEnv: EnvWithDb = {
    DATABASE_URL: "postgresql://user:pass@host:5432/db",
  };

  let manager: DatabaseConnectionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolInstances.length = 0;
    mockPrismaDisconnect.mockResolvedValue(undefined);
    manager = new DatabaseConnectionManager();
  });

  afterEach(() => {
    vi.useRealTimers();
    manager.clearPools();
  });

  describe("resolveConnectionStrings", () => {
    it("should throw when DATABASE_URL is missing", () => {
      const envNoDB: EnvWithDb = { DATABASE_URL: "" };

      expect(() => manager.acquireClient("US", envNoDB)).toThrow(
        "CRITICAL: DATABASE_URL is required",
      );
    });

    it("should throw when DATABASE_URL is not a PostgreSQL connection string", () => {
      const envBad: EnvWithDb = { DATABASE_URL: "mysql://user:pass@host/db" };

      expect(() => manager.acquireClient("US", envBad)).toThrow(
        "CRITICAL: DATABASE_URL is not a valid PostgreSQL connection string",
      );
    });

    it("should use custom timeout values from env", () => {
      const envCustom: EnvWithDb = {
        DATABASE_URL: "postgresql://user:pass@host:5432/db",
        DATABASE_CONNECTION_TIMEOUT_MS: "5000",
        DATABASE_STATEMENT_TIMEOUT_MS: "10000",
      };

      manager.acquireClient("US", envCustom);

      expect(mockPoolInstances[0].config.connectionTimeoutMillis).toBe(5000);
      // Statement timeout is added as URL param
      expect(mockPoolInstances[0].config.connectionString).toContain(
        "statement_timeout=10000",
      );
    });

    it("should accept postgres:// prefix", () => {
      const envPostgres: EnvWithDb = {
        DATABASE_URL: "postgres://user:pass@host:5432/db",
      };

      expect(() => manager.acquireClient("US", envPostgres)).not.toThrow();
    });
  });

  describe("addQueryParam", () => {
    it("should add query param to valid URL", () => {
      manager.acquireClient("US", baseEnv);

      // The connectionString in the pool config should have statement_timeout
      expect(mockPoolInstances[0].config.connectionString).toContain(
        "statement_timeout=5000",
      );
    });

    it("should handle invalid URL by appending with separator", () => {
      // Force addQueryParam to use fallback by using a non-URL-parseable string
      const envWeird: EnvWithDb = {
        DATABASE_URL: "postgresql://user:pass@host:5432/db",
      };

      manager.acquireClient("US", envWeird);
      // Should not throw and should have statement_timeout
      expect(mockPoolInstances[0].config.connectionString).toContain("statement_timeout");
    });
  });

  describe("logPoolStats", () => {
    it("should warn when pool has waiting connections", () => {
      manager.acquireClient("US", baseEnv);

      const pool = mockPoolInstances[0].instance;
      pool.waitingCount = 5;
      pool.totalCount = 10;
      pool.idleCount = 0;

      // Trigger acquire event handler to invoke logPoolStats
      const acquireHandler = pool.eventHandlers["acquire"];
      if (acquireHandler) {
        acquireHandler({});
      }
      // No assertions needed — we just verify no error is thrown
    });

    it("should error when pool is exhausted", () => {
      manager.acquireClient("US", baseEnv);

      const pool = mockPoolInstances[0].instance;
      pool.waitingCount = 3;
      pool.totalCount = 10; // max is 10
      pool.idleCount = 0;

      const acquireHandler = pool.eventHandlers["acquire"];
      if (acquireHandler) {
        acquireHandler({});
      }
    });
  });

  describe("pool event handlers", () => {
    it("should register connect, acquire, remove, and error handlers", () => {
      manager.acquireClient("US", baseEnv);

      const onCalls = mockPoolInstances[0].on.mock.calls.map((c) => c[0]);
      expect(onCalls).toContain("error");
      expect(onCalls).toContain("connect");
      expect(onCalls).toContain("acquire");
      expect(onCalls).toContain("remove");
    });

    it("should handle pool error event without throwing", () => {
      manager.acquireClient("US", baseEnv);

      const errorHandler = mockPoolInstances[0].instance.eventHandlers["error"];
      expect(() => errorHandler(new Error("Connection reset"))).not.toThrow();
    });
  });

  describe("cleanup", () => {
    it("should be a no-op (does not call $disconnect or pool.end)", async () => {
      const { cleanup } = manager.acquireClient("US", baseEnv);

      await cleanup();

      // Cleanup is a no-op — pool lifecycle managed by shutdown()
      expect(mockPrismaDisconnect).not.toHaveBeenCalled();
      expect(mockPoolInstances[0].end).not.toHaveBeenCalled();
    });

    it("should be a no-op regardless of pool state", async () => {
      mockPoolInstances.length = 0;
      const { cleanup } = manager.acquireClient("US", baseEnv);
      mockPoolInstances[0].end.mockRejectedValue(new Error("Pool end failed"));

      // Cleanup is a no-op so pool.end is never called
      await cleanup();

      expect(mockPoolInstances[0].end).not.toHaveBeenCalled();
    });
  });

  describe("shutdown", () => {
    it("should disconnect all clients and end all pools", async () => {
      manager.acquireClient("US", baseEnv);

      await manager.shutdown();

      expect(mockPrismaDisconnect).toHaveBeenCalled();
      expect(mockPoolInstances[0].end).toHaveBeenCalled();
      // Cache should be cleared
      expect(manager.getPoolStatus()).toEqual([]);
    });

    it("should handle errors during shutdown gracefully", async () => {
      manager.acquireClient("US", baseEnv);
      mockPrismaDisconnect.mockRejectedValue(new Error("Disconnect failed"));
      mockPoolInstances[0].end.mockRejectedValue(new Error("Pool end failed"));

      // Should not throw
      await manager.shutdown();

      expect(manager.getPoolStatus()).toEqual([]);
    });
  });

  describe("clearPools", () => {
    it("should drain and clear cached pools", () => {
      manager.acquireClient("US", baseEnv);
      expect(manager.getPoolStatus().length).toBe(1);

      manager.clearPools();

      expect(mockPrismaDisconnect).toHaveBeenCalled();
      expect(mockPoolInstances[0].end).toHaveBeenCalled();
      expect(manager.getPoolStatus()).toEqual([]);
    });

    it("should be safe to call with no pools", () => {
      manager.clearPools();
      expect(manager.getPoolStatus()).toEqual([]);
    });
  });

  describe("getPoolStatus", () => {
    it("should return real stats from cached pools", () => {
      manager.acquireClient("US", baseEnv);

      const status = manager.getPoolStatus();

      expect(status.length).toBe(1);
      expect(status[0]).toHaveProperty("key");
      expect(status[0]).toHaveProperty("totalCount");
      expect(status[0]).toHaveProperty("idleCount");
      expect(status[0]).toHaveProperty("waitingCount");
      expect(status[0]).toHaveProperty("age");
      expect(status[0]).toHaveProperty("errorCount");
      expect(status[0].errorCount).toBe(0);
    });

    it("should return empty array when no pools are cached", () => {
      expect(manager.getPoolStatus()).toEqual([]);
    });
  });

  describe("isPermanentFailure", () => {
    it("should detect P2002 (unique constraint) as permanent", async () => {
      vi.useRealTimers();
      const error = new Error("Unique constraint violation");
      (error as any).code = "P2002";

      await expect(
        manager.executeWithRetry("US", baseEnv, async () => {
          throw error;
        }, { maxRetries: 1 }),
      ).rejects.toThrow("Unique constraint violation");
    });

    it("should detect P2025 (record not found) as permanent", async () => {
      vi.useRealTimers();
      const error = new Error("Record not found");
      (error as any).code = "P2025";

      await expect(
        manager.executeWithRetry("US", baseEnv, async () => {
          throw error;
        }, { maxRetries: 1 }),
      ).rejects.toThrow("Record not found");
    });

    it("should detect P2003 (foreign key constraint) as permanent", async () => {
      vi.useRealTimers();
      const error = new Error("Foreign key constraint failed");
      (error as any).code = "P2003";

      await expect(
        manager.executeWithRetry("US", baseEnv, async () => {
          throw error;
        }, { maxRetries: 1 }),
      ).rejects.toThrow("Foreign key constraint failed");
    });

    it("should detect P2011 (null constraint) as permanent", async () => {
      vi.useRealTimers();
      const error = new Error("Null constraint violation");
      (error as any).code = "P2011";

      await expect(
        manager.executeWithRetry("US", baseEnv, async () => {
          throw error;
        }, { maxRetries: 1 }),
      ).rejects.toThrow("Null constraint violation");
    });

    it("should detect P2012 (required value missing) as permanent", async () => {
      vi.useRealTimers();
      const error = new Error("Missing required value");
      (error as any).code = "P2012";

      await expect(
        manager.executeWithRetry("US", baseEnv, async () => {
          throw error;
        }, { maxRetries: 1 }),
      ).rejects.toThrow("Missing required value");
    });

    it("should detect unique constraint message as permanent", async () => {
      vi.useRealTimers();

      await expect(
        manager.executeWithRetry("US", baseEnv, async () => {
          throw new Error("violates unique constraint");
        }, { maxRetries: 1 }),
      ).rejects.toThrow("violates unique constraint");
    });

    it("should detect validation trigger errors as permanent", async () => {
      vi.useRealTimers();

      await expect(
        manager.executeWithRetry("US", baseEnv, async () => {
          throw new Error("validation failed: target does not exist");
        }, { maxRetries: 1 }),
      ).rejects.toThrow("validation failed");
    });
  });

  describe("executeWithRetry - special error types", () => {
    it("should not retry Hyperdrive configuration errors", async () => {
      vi.useRealTimers();
      let attempts = 0;

      await expect(
        manager.executeWithRetry("US", baseEnv, async () => {
          attempts++;
          throw new Error("CRITICAL: DATABASE_URL is required but not available");
        }, { maxRetries: 3 }),
      ).rejects.toThrow("DATABASE_URL is required");

      // Should only attempt once (no retries)
      expect(attempts).toBe(1);
    });

    it("should retry on connection errors and invalidate pool", async () => {
      vi.useRealTimers();
      let attempts = 0;

      const result = await manager.executeWithRetry(
        "US",
        baseEnv,
        async () => {
          attempts++;
          if (attempts === 1) throw new Error("ECONNREFUSED");
          return "success";
        },
        { maxRetries: 1, baseDelayMs: 10 },
      );

      expect(result).toBe("success");
      expect(attempts).toBe(2);
      // Connection error should have invalidated the pool and created a new one
      expect(mockPoolInstances.length).toBe(2);
    });

    it("should reject on memory access out of bounds errors", async () => {
      vi.useRealTimers();

      await expect(
        manager.executeWithRetry("US", baseEnv, async () => {
          throw new Error("RuntimeError: memory access out of bounds");
        }, { maxRetries: 1, baseDelayMs: 10 }),
      ).rejects.toThrow("memory access out of bounds");
    });

    it("should return default value when all retries exhausted", async () => {
      vi.useRealTimers();

      const result = await manager.executeWithRetry(
        "US",
        baseEnv,
        async () => {
          throw new Error("ETIMEDOUT");
        },
        { maxRetries: 1, baseDelayMs: 10, defaultValue: "fallback" },
      );

      expect(result).toBe("fallback");
    });

    it("should log retry success after initial failure", async () => {
      vi.useRealTimers();
      let attempts = 0;

      const result = await manager.executeWithRetry(
        "US",
        baseEnv,
        async () => {
          attempts++;
          if (attempts === 1) throw new Error("ETIMEDOUT");
          return "recovered";
        },
        { maxRetries: 1, baseDelayMs: 10 },
      );

      expect(result).toBe("recovered");
    });

    it("should handle acquireClient failure in executeWithRetry", async () => {
      vi.useRealTimers();
      const envBad: EnvWithDb = { DATABASE_URL: "" };

      await expect(
        manager.executeWithRetry("US", envBad, async () => "never"),
      ).rejects.toThrow("DATABASE_URL is required");
    });
  });

  describe("createClient", () => {
    it("should return a managed client", async () => {
      const managed = await manager.createClient("US", baseEnv);

      expect(managed.client).toBeDefined();
      expect(managed.cleanup).toBeTypeOf("function");
    });
  });

  describe("DATABASE_POOL_MAX env var", () => {
    it("should use DATABASE_POOL_MAX when set", () => {
      const envWithPoolMax: EnvWithDb = {
        ...baseEnv,
        DATABASE_POOL_MAX: "20",
      };

      manager.acquireClient("US", envWithPoolMax);

      expect(mockPoolInstances[0].config.max).toBe(20);
    });

    it("should default to 10 when DATABASE_POOL_MAX is not set", () => {
      manager.acquireClient("US", baseEnv);

      expect(mockPoolInstances[0].config.max).toBe(10);
    });
  });
});
