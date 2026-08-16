/**
 * Tests for the public `shutdownTrellis()` hook.
 *
 * The property under test is the one the hook exists for: a teardown that
 * throws halfway leaves sockets open, which is the failure it is meant to
 * prevent. So a failing subsystem must NOT stop the others, and nothing may
 * escape as a rejection.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbShutdown = vi.fn();
const graphClose = vi.fn();

vi.mock("../../src/lib/database-connection-manager.js", () => ({
  sharedDatabaseConnectionManager: {
    shutdown: () => dbShutdown(),
  },
}));

vi.mock("../../src/lib/graph/index.js", () => ({
  closeSharedGraphService: () => graphClose(),
}));

describe("shutdownTrellis", () => {
  beforeEach(() => {
    vi.resetModules();
    dbShutdown.mockReset().mockResolvedValue(undefined);
    graphClose.mockReset().mockResolvedValue(undefined);
  });

  it("closes both subsystems and reports them", async () => {
    const { shutdownTrellis } = await import("../../src/shutdown.js");

    const result = await shutdownTrellis();

    expect(dbShutdown).toHaveBeenCalledTimes(1);
    expect(graphClose).toHaveBeenCalledTimes(1);
    expect(result.closed).toEqual(["database", "graph"]);
    expect(result.failed).toEqual([]);
  });

  it("still closes the graph when the database shutdown throws", async () => {
    const boom = new Error("pool already destroyed");
    dbShutdown.mockRejectedValue(boom);
    const { shutdownTrellis } = await import("../../src/shutdown.js");

    const result = await shutdownTrellis();

    // The point of the hook: one broken pool must not strand the other.
    expect(graphClose).toHaveBeenCalledTimes(1);
    expect(result.closed).toEqual(["graph"]);
    expect(result.failed).toEqual([{ subsystem: "database", error: boom }]);
  });

  it("reports a graph failure without disturbing the database close", async () => {
    const boom = new Error("driver closed");
    graphClose.mockRejectedValue(boom);
    const { shutdownTrellis } = await import("../../src/shutdown.js");

    const result = await shutdownTrellis();

    expect(result.closed).toEqual(["database"]);
    expect(result.failed).toEqual([{ subsystem: "graph", error: boom }]);
  });

  it("never rejects, even when everything fails", async () => {
    dbShutdown.mockRejectedValue(new Error("a"));
    graphClose.mockRejectedValue(new Error("b"));
    const { shutdownTrellis } = await import("../../src/shutdown.js");

    // A rejecting teardown in a `finally` masks the real failure it was
    // cleaning up after, so this must resolve.
    const result = await shutdownTrellis();

    expect(result.closed).toEqual([]);
    expect(result.failed.map((f) => f.subsystem)).toEqual(["database", "graph"]);
  });

  it("is idempotent", async () => {
    const { shutdownTrellis } = await import("../../src/shutdown.js");

    await shutdownTrellis();
    const second = await shutdownTrellis();

    expect(second.failed).toEqual([]);
    expect(dbShutdown).toHaveBeenCalledTimes(2);
  });
});
