/**
 * Graph factory — shared-instance memoization.
 *
 * createGraphServiceFromEnv() is called per-request from ~10 handlers + the
 * extension wrapper. It must return a single shared, connected service (one
 * PostgresGraphService and one underlying Prisma client per process), not a
 * fresh instance per call. closeSharedGraphService() must release it and let
 * the next call rebuild. These tests lock that.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { connectMock, closeMock, instances } = vi.hoisted(() => ({
  connectMock: vi.fn().mockResolvedValue(undefined),
  closeMock: vi.fn().mockResolvedValue(undefined),
  instances: [] as unknown[],
}));

// Mock the concrete service so no real Postgres connection is attempted; the
// real graph-factory memoization logic still runs.
vi.mock("../../src/lib/graph/postgres/postgres-graph-service.js", () => ({
  PostgresGraphService: class {
    connect = connectMock;
    close = closeMock;
    constructor() {
      instances.push(this);
    }
  },
}));

// The factory builds a Prisma client for the service (and the geo lookup) —
// stub it out so no database config is required.
vi.mock("../../src/db.js", () => ({
  createPrisma: vi.fn(() => ({})),
}));

import {
  createGraphServiceFromEnv,
  closeSharedGraphService,
} from "../../src/lib/graph/graph-factory.js";

const ENV = { DATABASE_URL: "postgresql://test:test@localhost:5432/test" };

describe("createGraphServiceFromEnv memoization", () => {
  beforeEach(() => {
    instances.length = 0;
    connectMock.mockClear();
    closeMock.mockClear();
  });

  afterEach(async () => {
    await closeSharedGraphService();
    delete process.env.GRAPH_BACKEND;
  });

  it("returns the same instance across calls (one service per process)", async () => {
    const a = await createGraphServiceFromEnv(ENV);
    const b = await createGraphServiceFromEnv(ENV);
    expect(a).toBe(b);
    expect(instances.length).toBe(1);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed connection (next call retries)", async () => {
    connectMock.mockRejectedValueOnce(new Error("unreachable"));
    await expect(createGraphServiceFromEnv(ENV)).rejects.toThrow("unreachable");
    // A subsequent call rebuilds rather than returning the failed promise.
    const ok = await createGraphServiceFromEnv(ENV);
    expect(ok).toBeDefined();
    expect(instances.length).toBe(2);
  });

  it("closeSharedGraphService closes the service and clears the cache", async () => {
    const first = await createGraphServiceFromEnv(ENV);
    await closeSharedGraphService();
    expect(closeMock).toHaveBeenCalledTimes(1);

    const second = await createGraphServiceFromEnv(ENV);
    expect(second).not.toBe(first); // rebuilt after close
    expect(instances.length).toBe(2);
  });

  it("closeSharedGraphService is a no-op when nothing was created", async () => {
    await expect(closeSharedGraphService()).resolves.toBeUndefined();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("requires a DATABASE_URL", async () => {
    await expect(createGraphServiceFromEnv({})).rejects.toThrow(/DATABASE_URL/);
    expect(instances.length).toBe(0);
  });

  it("rejects the removed neo4j backend with a clear error", async () => {
    process.env.GRAPH_BACKEND = "neo4j";
    await expect(createGraphServiceFromEnv(ENV)).rejects.toThrow(
      /no longer supported/,
    );
  });
});
