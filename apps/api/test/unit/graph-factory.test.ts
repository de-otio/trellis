/**
 * Graph factory — shared-instance memoization.
 *
 * createGraphServiceFromEnv() is called per-request from ~10 handlers + the
 * extension wrapper. It must return a single shared, connected service (one
 * neo4j Driver per process), not a fresh driver per call — otherwise every
 * request leaks a Bolt connection + liveness timer. closeSharedGraphService()
 * must release it and let the next call rebuild. These tests lock that.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { connectMock, closeMock, instances } = vi.hoisted(() => ({
  connectMock: vi.fn().mockResolvedValue(undefined),
  closeMock: vi.fn().mockResolvedValue(undefined),
  instances: [] as unknown[],
}));

// Mock the concrete service so no real Neo4j connection is attempted; the
// real graph-factory memoization logic still runs.
vi.mock("../../src/lib/graph/neo4j-graph-service.js", () => ({
  Neo4jGraphService: class {
    connect = connectMock;
    close = closeMock;
    constructor() {
      instances.push(this);
    }
  },
}));

import {
  createGraphServiceFromEnv,
  closeSharedGraphService,
} from "../../src/lib/graph/graph-factory.js";

describe("createGraphServiceFromEnv memoization", () => {
  beforeEach(() => {
    instances.length = 0;
    connectMock.mockClear();
    closeMock.mockClear();
    process.env.GRAPH_DB_URI = "bolt://localhost:7687";
    process.env.GRAPH_DB_USER = "neo4j";
    process.env.GRAPH_DB_PASSWORD = "pw";
  });

  afterEach(async () => {
    await closeSharedGraphService();
    delete process.env.GRAPH_DB_URI;
  });

  it("returns the same instance across calls (one driver per process)", async () => {
    const a = await createGraphServiceFromEnv();
    const b = await createGraphServiceFromEnv();
    expect(a).toBe(b);
    expect(instances.length).toBe(1);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed connection (next call retries)", async () => {
    connectMock.mockRejectedValueOnce(new Error("unreachable"));
    await expect(createGraphServiceFromEnv()).rejects.toThrow("unreachable");
    // A subsequent call rebuilds rather than returning the failed promise.
    const ok = await createGraphServiceFromEnv();
    expect(ok).toBeDefined();
    expect(instances.length).toBe(2);
  });

  it("closeSharedGraphService closes the driver and clears the cache", async () => {
    const first = await createGraphServiceFromEnv();
    await closeSharedGraphService();
    expect(closeMock).toHaveBeenCalledTimes(1);

    const second = await createGraphServiceFromEnv();
    expect(second).not.toBe(first); // rebuilt after close
    expect(instances.length).toBe(2);
  });

  it("closeSharedGraphService is a no-op when nothing was created", async () => {
    await expect(closeSharedGraphService()).resolves.toBeUndefined();
    expect(closeMock).not.toHaveBeenCalled();
  });
});
