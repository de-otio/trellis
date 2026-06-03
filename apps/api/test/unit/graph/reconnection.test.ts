/**
 * Unit Tests: Neo4j GraphService — failover reconnection wrapper (C4)
 *
 * On a Neptune writer failover the cluster Bolt endpoint repoints and pooled
 * connections raise ServiceUnavailable / SessionExpired. executeQuery rebuilds
 * the driver and retries once. These tests drive that path with a fully mocked
 * driver — no database required.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Neo4jGraphService } from "../../../src/lib/graph/neo4j-graph-service.js";
import { GraphQueryError } from "../../../src/lib/graph/errors.js";

const { mockSessionRun, mockSessionClose, mockDriverClose, mockDriverFactory, mockVerifyConnectivity } =
  vi.hoisted(() => ({
    mockSessionRun: vi.fn(),
    mockSessionClose: vi.fn().mockResolvedValue(undefined),
    mockDriverClose: vi.fn().mockResolvedValue(undefined),
    mockDriverFactory: vi.fn(),
    mockVerifyConnectivity: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("neo4j-driver", () => {
  const mockSession = {
    run: (...args: unknown[]) => mockSessionRun(...args),
    close: () => mockSessionClose(),
  };
  const mockDriver = {
    session: () => mockSession,
    verifyConnectivity: () => mockVerifyConnectivity(),
    close: () => mockDriverClose(),
  };
  // Count driver creations: one per connect()/reconnect().
  mockDriverFactory.mockImplementation(() => mockDriver);
  return {
    default: {
      driver: mockDriverFactory,
      auth: { basic: vi.fn(() => ({ scheme: "basic" })) },
      int: (n: number) => n,
      integer: { toNumber: (v: unknown) => Number(v) },
      error: { SERVICE_UNAVAILABLE: "ServiceUnavailable", SESSION_EXPIRED: "SessionExpired" },
    },
  };
});

vi.mock("../../../src/lib/graph/graph-schema-init", () => ({
  initGraphSchema: vi.fn().mockResolvedValue(undefined),
}));

const transient = (code: string) => Object.assign(new Error(`transient: ${code}`), { code });

let service: Neo4jGraphService;

beforeEach(async () => {
  vi.clearAllMocks();
  mockDriverFactory.mockImplementation(() => ({
    session: () => ({ run: (...a: unknown[]) => mockSessionRun(...a), close: () => mockSessionClose() }),
    verifyConnectivity: () => mockVerifyConnectivity(),
    close: () => mockDriverClose(),
  }));
  mockSessionClose.mockResolvedValue(undefined);
  mockDriverClose.mockResolvedValue(undefined);

  service = new Neo4jGraphService();
  mockSessionRun.mockResolvedValue({ records: [] }); // schema-init probe
  await service.connect({ endpoint: "bolt://localhost:7687", auth: { type: "none" } });

  // Reset call counts; keep the connected driver. Factory was called once.
  mockSessionRun.mockReset();
  mockSessionClose.mockClear();
  mockDriverClose.mockClear();
  mockDriverFactory.mockClear();
});

describe("executeQuery failover reconnection", () => {
  it("reconnects and retries once on ServiceUnavailable, then succeeds", async () => {
    mockSessionRun
      .mockRejectedValueOnce(transient("ServiceUnavailable"))
      .mockResolvedValueOnce({ records: ["ok"] });

    const result = await service.executeQuery("RETURN 1");

    expect(result).toEqual({ records: ["ok"] });
    expect(mockSessionRun).toHaveBeenCalledTimes(2); // failed once, retried once
    expect(mockDriverClose).toHaveBeenCalledTimes(1); // old driver torn down
    expect(mockDriverFactory).toHaveBeenCalledTimes(1); // one rebuild
  });

  it("reconnects on SessionExpired too", async () => {
    mockSessionRun
      .mockRejectedValueOnce(transient("SessionExpired"))
      .mockResolvedValueOnce({ records: ["ok"] });

    await expect(service.executeQuery("RETURN 1")).resolves.toEqual({ records: ["ok"] });
    expect(mockDriverFactory).toHaveBeenCalledTimes(1);
  });

  it("does NOT reconnect on a non-transient (query) error — fails fast", async () => {
    mockSessionRun.mockRejectedValueOnce(transient("Neo.ClientError.Statement.SyntaxError"));

    await expect(service.executeQuery("RETURN 1")).rejects.toBeInstanceOf(GraphQueryError);
    expect(mockSessionRun).toHaveBeenCalledTimes(1); // no retry
    expect(mockDriverFactory).toHaveBeenCalledTimes(0); // no rebuild
  });

  it("retries at most once — a persistent failover surfaces as GraphQueryError", async () => {
    mockSessionRun.mockRejectedValue(transient("ServiceUnavailable"));

    await expect(service.executeQuery("RETURN 1")).rejects.toBeInstanceOf(GraphQueryError);
    expect(mockSessionRun).toHaveBeenCalledTimes(2); // initial + one retry, then give up
    expect(mockDriverFactory).toHaveBeenCalledTimes(1); // single reconnect
  });

  it("single-flights the reconnect across concurrent queries", async () => {
    // Both queries fail on their first run, then succeed on retry. The two
    // failures should trigger exactly ONE driver rebuild, not two.
    mockSessionRun.mockImplementation(() => {
      // 1st & 2nd calls (the two initial attempts) reject; later calls succeed.
      const callsSoFar = mockSessionRun.mock.calls.length;
      return callsSoFar <= 2
        ? Promise.reject(transient("ServiceUnavailable"))
        : Promise.resolve({ records: ["ok"] });
    });

    const [a, b] = await Promise.all([
      service.executeQuery("RETURN 1"),
      service.executeQuery("RETURN 2"),
    ]);

    expect(a).toEqual({ records: ["ok"] });
    expect(b).toEqual({ records: ["ok"] });
    expect(mockDriverFactory).toHaveBeenCalledTimes(1); // one shared reconnect
  });
});
