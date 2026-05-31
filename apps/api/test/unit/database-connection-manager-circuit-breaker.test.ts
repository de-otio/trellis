/**
 * Unit tests for the circuit-breaker wiring in
 * DatabaseConnectionManager.executeWithRetry.
 *
 * Verifies:
 * - A sustained outage (repeated failed query sequences) opens the per-region
 *   breaker, after which calls fail fast WITHOUT invoking the query function.
 * - An open circuit honors `defaultValue` when present.
 * - The breaker is per-region: one region opening does not block another.
 * - Non-retryable (permanent) failures do NOT count toward opening the breaker.
 *
 * Uses the same pg/Prisma mocks as the main manager test so no real
 * connections are made.
 */

import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithDb } from "../../src/lib/database-connection-manager.js";
import { DatabaseConnectionManager } from "../../src/lib/database-connection-manager.js";

vi.mock("pg", () => ({
  Pool: class MockPool {
    config: any;
    totalCount = 0;
    idleCount = 0;
    waitingCount = 0;
    query = vi.fn();
    end = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    constructor(config: any) {
      this.config = config;
    }
  },
}));

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class MockPrismaPg {
    pool: any;
    constructor(pool: any) {
      this.pool = pool;
    }
  },
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: class MockPrismaClient {
    adapter: any;
    $disconnect = vi.fn().mockResolvedValue(undefined);
    constructor(config: any) {
      this.adapter = config.adapter;
    }
  },
}));

const baseEnv: EnvWithDb = {
  DATABASE_URL: "postgresql://cb-test.example.com:5432/postgres",
};

// failureThreshold for the manager's per-region breaker (see getCircuitBreaker).
const FAILURE_THRESHOLD = 5;

describe("DatabaseConnectionManager circuit breaker wiring", () => {
  let manager: DatabaseConnectionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new DatabaseConnectionManager();
  });

  // A retryable (outage-like) failure. maxRetries: 0 keeps each call to a
  // single attempt so each executeWithRetry call is exactly one breaker
  // failure.
  const outageQuery = () =>
    vi.fn(async (_client: PrismaClient) => {
      throw new Error("ECONNREFUSED connection refused");
    });

  const driveSequencesToOpen = async () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await expect(
        manager.executeWithRetry("US", baseEnv, outageQuery(), {
          maxRetries: 0,
        }),
      ).rejects.toThrow();
    }
  };

  it("opens the circuit after sustained failures and fails fast without running the query", async () => {
    await driveSequencesToOpen();

    // Circuit is now OPEN: the next call must reject with the breaker message
    // and must NOT invoke the query function.
    const probe = vi.fn(async (_client: PrismaClient) => ({ ok: true }));
    await expect(
      manager.executeWithRetry("US", baseEnv, probe, { maxRetries: 0 }),
    ).rejects.toThrow("Circuit breaker is OPEN");
    expect(probe).not.toHaveBeenCalled();
  });

  it("honors defaultValue when the circuit is open", async () => {
    await driveSequencesToOpen();

    const probe = vi.fn(async (_client: PrismaClient) => ["real"]);
    const result = await manager.executeWithRetry("US", baseEnv, probe, {
      maxRetries: 0,
      defaultValue: ["fallback"],
    });
    expect(result).toEqual(["fallback"]);
    expect(probe).not.toHaveBeenCalled();
  });

  it("keeps breakers per-region (one region opening does not block another)", async () => {
    const usEnv: EnvWithDb = {
      DATABASE_URL: "postgresql://us.example.com:5432/postgres",
    };
    const euEnv: EnvWithDb = {
      DATABASE_URL: "postgresql://eu.example.com:5432/postgres",
    };

    // Open US.
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await expect(
        manager.executeWithRetry("US", usEnv, outageQuery(), { maxRetries: 0 }),
      ).rejects.toThrow();
    }
    await expect(
      manager.executeWithRetry(
        "US",
        usEnv,
        vi.fn(async () => "nope"),
        { maxRetries: 0 },
      ),
    ).rejects.toThrow("Circuit breaker is OPEN");

    // EU is still healthy and serves normally.
    const euResult = await manager.executeWithRetry(
      "EU",
      euEnv,
      async () => "eu-ok",
      { maxRetries: 0 },
    );
    expect(euResult).toBe("eu-ok");
  });

  it("does not open the circuit on non-retryable (permanent) failures", async () => {
    // Unique-constraint violations are permanent failures: they should
    // surface to the caller but must not count toward opening the breaker.
    const permanentQuery = () =>
      vi.fn(async (_client: PrismaClient) => {
        const err: any = new Error("Unique constraint failed");
        err.code = "P2002";
        throw err;
      });

    for (let i = 0; i < FAILURE_THRESHOLD + 2; i++) {
      await expect(
        manager.executeWithRetry("US", baseEnv, permanentQuery(), {
          maxRetries: 0,
        }),
      ).rejects.toThrow("Unique constraint failed");
    }

    // Despite many failures, the circuit stayed CLOSED — a healthy query runs.
    const probe = vi.fn(async (_client: PrismaClient) => "ok");
    const result = await manager.executeWithRetry("US", baseEnv, probe, {
      maxRetries: 0,
    });
    expect(result).toBe("ok");
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
