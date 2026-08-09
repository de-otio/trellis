/**
 * Unit Tests: DiscoveryHandler
 *
 * Covers graph-based discovery, nearby discovery, recommendations,
 * rate limiting (5 req/min/user), input validation, and error handling.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockGraphService } = vi.hoisted(() => ({
  mockGraphService: {
    discoverByGraph: vi.fn(),
    discoverNearby: vi.fn(),
    getRecommendations: vi.fn(),
  },
}));

vi.mock("../../src/lib/graph", () => ({
  createGraphServiceFromEnv: vi.fn().mockResolvedValue(mockGraphService),
}));

import { DiscoveryHandler } from "../../src/lib/discovery-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class GraphConnectionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "GraphConnectionError";
  }
}

const BASE_URL = "https://api.example.com";

function makeRequest(path: string, params: Record<string, string> = {}): Request {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new Request(url.toString(), { method: "GET" });
}

function makeSession(userId: string = "user-123") {
  return {
    userId,
    email: "u@example.com",
    role: "END_USER",
    expiresAt: Date.now() + 3600000,
    sessionType: "user" as const,
    lastActivityAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiscoveryHandler", () => {
  let handler: DiscoveryHandler;
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new DiscoveryHandler();
    mockEnv = { DATABASE_URL: "postgresql://test:test@localhost/test" } as unknown as Env;
  });

  // -------------------------------------------------------------------------
  // handleDiscoverByGraph
  // -------------------------------------------------------------------------

  describe("handleDiscoverByGraph", () => {
    it("returns 200 with results on success", async () => {
      const fakeResults = [{ id: "node-1", type: "user" }];
      mockGraphService.discoverByGraph.mockResolvedValue(fakeResults);

      const session = makeSession("graph-user-1");
      const request = makeRequest("/api/discover/graph", { hops: "1" });

      const response = await handler.handleDiscoverByGraph(request, session, mockEnv, {} as any);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.results).toEqual(fakeResults);
    });

    it("clamps hops to maximum of 2 when a higher value is supplied", async () => {
      mockGraphService.discoverByGraph.mockResolvedValue([]);

      const session = makeSession("graph-user-2");
      const request = makeRequest("/api/discover/graph", { hops: "5" });

      await handler.handleDiscoverByGraph(request, session, mockEnv, {} as any);

      expect(mockGraphService.discoverByGraph).toHaveBeenCalledWith(
        session.userId,
        2,
        expect.objectContaining({ hops: 2 }),
      );
    });

    it("clamps hops to minimum of 1 when zero is supplied", async () => {
      mockGraphService.discoverByGraph.mockResolvedValue([]);

      const session = makeSession("graph-user-3");
      const request = makeRequest("/api/discover/graph", { hops: "-3" });

      await handler.handleDiscoverByGraph(request, session, mockEnv, {} as any);

      expect(mockGraphService.discoverByGraph).toHaveBeenCalledWith(
        session.userId,
        1,
        expect.objectContaining({ hops: 1 }),
      );
    });

    it("passes optional filters through to graphService", async () => {
      mockGraphService.discoverByGraph.mockResolvedValue([]);

      const session = makeSession("graph-user-4");
      const request = makeRequest("/api/discover/graph", {
        entityType: "dog",
        breed: "labrador",
        lifeStage: "adult",
        limit: "10",
      });

      await handler.handleDiscoverByGraph(request, session, mockEnv, {} as any);

      expect(mockGraphService.discoverByGraph).toHaveBeenCalledWith(
        session.userId,
        2,
        expect.objectContaining({ entityType: "dog", breed: "labrador", lifeStage: "adult", limit: 10 }),
      );
    });

    it("returns 429 when rate limit is exceeded", async () => {
      mockGraphService.discoverByGraph.mockResolvedValue([]);

      // Use a unique userId per test group to avoid cross-test bleed
      const userId = `rl-graph-user-${Date.now()}`;
      const session = makeSession(userId);

      // 5 requests should succeed
      for (let i = 0; i < 5; i++) {
        const r = await handler.handleDiscoverByGraph(
          makeRequest("/api/discover/graph"),
          session,
          mockEnv,
          {} as any,
        );
        expect(r.status).toBe(200);
      }

      // 6th request must be rejected
      const r6 = await handler.handleDiscoverByGraph(
        makeRequest("/api/discover/graph"),
        session,
        mockEnv,
        {} as any,
      );
      expect(r6.status).toBe(429);
      const body = await r6.json();
      expect(body.error).toBe("RATE_LIMITED");
    });
  });

  // -------------------------------------------------------------------------
  // handleDiscoverNearby
  // -------------------------------------------------------------------------

  describe("handleDiscoverNearby", () => {
    it("returns 200 with results on success", async () => {
      const fakeResults = [{ id: "place-1" }];
      mockGraphService.discoverNearby.mockResolvedValue(fakeResults);

      const session = makeSession("nearby-user-1");
      const request = makeRequest("/api/discover/nearby", { lat: "51.505", lng: "-0.09" });

      const response = await handler.handleDiscoverNearby(request, session, mockEnv, {} as any);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.results).toEqual(fakeResults);
    });

    it("returns 400 when lat is missing", async () => {
      const session = makeSession("nearby-user-2");
      const request = makeRequest("/api/discover/nearby", { lng: "-0.09" });

      const response = await handler.handleDiscoverNearby(request, session, mockEnv, {} as any);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when lng is missing", async () => {
      const session = makeSession("nearby-user-3");
      const request = makeRequest("/api/discover/nearby", { lat: "51.505" });

      const response = await handler.handleDiscoverNearby(request, session, mockEnv, {} as any);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when lat is out of range (> 90)", async () => {
      const session = makeSession("nearby-user-4");
      const request = makeRequest("/api/discover/nearby", { lat: "91", lng: "0" });

      const response = await handler.handleDiscoverNearby(request, session, mockEnv, {} as any);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when lng is out of range (> 180)", async () => {
      const session = makeSession("nearby-user-5");
      const request = makeRequest("/api/discover/nearby", { lat: "0", lng: "181" });

      const response = await handler.handleDiscoverNearby(request, session, mockEnv, {} as any);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("coarsens lat/lng to 3 decimal places before calling graphService", async () => {
      mockGraphService.discoverNearby.mockResolvedValue([]);

      const session = makeSession("nearby-user-6");
      // Supply high-precision coordinates
      const request = makeRequest("/api/discover/nearby", {
        lat: "51.505678",
        lng: "-0.090123",
      });

      await handler.handleDiscoverNearby(request, session, mockEnv, {} as any);

      // Math.round(51.505678 * 1000) / 1000 = 51.506
      // Math.round(-0.090123 * 1000) / 1000 = -0.09
      expect(mockGraphService.discoverNearby).toHaveBeenCalledWith(
        session.userId,
        51.506,
        -0.09,
        expect.any(Number),
        expect.objectContaining({}),
      );
    });

    it("clamps radius to [100, 50000]", async () => {
      mockGraphService.discoverNearby.mockResolvedValue([]);

      const session = makeSession("nearby-user-7");

      // Below minimum
      const reqLow = makeRequest("/api/discover/nearby", { lat: "0", lng: "0", radius: "1" });
      await handler.handleDiscoverNearby(reqLow, session, mockEnv, {} as any);
      expect(mockGraphService.discoverNearby).toHaveBeenCalledWith(
        session.userId,
        expect.any(Number),
        expect.any(Number),
        100,
        expect.any(Object),
      );

      vi.clearAllMocks();

      // Above maximum
      const reqHigh = makeRequest("/api/discover/nearby", { lat: "0", lng: "0", radius: "99999" });
      await handler.handleDiscoverNearby(reqHigh, session, mockEnv, {} as any);
      expect(mockGraphService.discoverNearby).toHaveBeenCalledWith(
        session.userId,
        expect.any(Number),
        expect.any(Number),
        50000,
        expect.any(Object),
      );
    });

    it("returns 429 when rate limit is exceeded", async () => {
      mockGraphService.discoverNearby.mockResolvedValue([]);

      const userId = `rl-nearby-user-${Date.now()}`;
      const session = makeSession(userId);
      const params = { lat: "51.5", lng: "-0.09" };

      for (let i = 0; i < 5; i++) {
        const r = await handler.handleDiscoverNearby(
          makeRequest("/api/discover/nearby", params),
          session,
          mockEnv,
          {} as any,
        );
        expect(r.status).toBe(200);
      }

      const r6 = await handler.handleDiscoverNearby(
        makeRequest("/api/discover/nearby", params),
        session,
        mockEnv,
        {} as any,
      );
      expect(r6.status).toBe(429);
      const body = await r6.json();
      expect(body.error).toBe("RATE_LIMITED");
    });
  });

  // -------------------------------------------------------------------------
  // handleGetRecommendations
  // -------------------------------------------------------------------------

  describe("handleGetRecommendations", () => {
    it("returns 200 with recommendations using default limit", async () => {
      const fakeRecs = [{ id: "rec-1" }, { id: "rec-2" }];
      mockGraphService.getRecommendations.mockResolvedValue(fakeRecs);

      const session = makeSession("recs-user-1");
      const request = makeRequest("/api/discover/recommendations");

      const response = await handler.handleGetRecommendations(request, session, mockEnv, {} as any);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.recommendations).toEqual(fakeRecs);
      // Default limit is 10
      expect(mockGraphService.getRecommendations).toHaveBeenCalledWith(session.userId, 10);
    });

    it("passes a custom limit when provided", async () => {
      mockGraphService.getRecommendations.mockResolvedValue([]);

      const session = makeSession("recs-user-2");
      const request = makeRequest("/api/discover/recommendations", { limit: "15" });

      await handler.handleGetRecommendations(request, session, mockEnv, {} as any);

      expect(mockGraphService.getRecommendations).toHaveBeenCalledWith(session.userId, 15);
    });

    it("clamps limit to maximum of 30", async () => {
      mockGraphService.getRecommendations.mockResolvedValue([]);

      const session = makeSession("recs-user-3");
      const request = makeRequest("/api/discover/recommendations", { limit: "100" });

      await handler.handleGetRecommendations(request, session, mockEnv, {} as any);

      expect(mockGraphService.getRecommendations).toHaveBeenCalledWith(session.userId, 30);
    });

    it("clamps limit to minimum of 1", async () => {
      mockGraphService.getRecommendations.mockResolvedValue([]);

      const session = makeSession("recs-user-4");
      const request = makeRequest("/api/discover/recommendations", { limit: "-5" });

      await handler.handleGetRecommendations(request, session, mockEnv, {} as any);

      expect(mockGraphService.getRecommendations).toHaveBeenCalledWith(session.userId, 1);
    });

    it("returns 429 when rate limit is exceeded", async () => {
      mockGraphService.getRecommendations.mockResolvedValue([]);

      const userId = `rl-recs-user-${Date.now()}`;
      const session = makeSession(userId);

      for (let i = 0; i < 5; i++) {
        const r = await handler.handleGetRecommendations(
          makeRequest("/api/discover/recommendations"),
          session,
          mockEnv,
          {} as any,
        );
        expect(r.status).toBe(200);
      }

      const r6 = await handler.handleGetRecommendations(
        makeRequest("/api/discover/recommendations"),
        session,
        mockEnv,
        {} as any,
      );
      expect(r6.status).toBe(429);
      const body = await r6.json();
      expect(body.error).toBe("RATE_LIMITED");
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("returns 503 when graphService throws GraphConnectionError", async () => {
      mockGraphService.discoverByGraph.mockRejectedValue(
        new GraphConnectionError("Graph DB unreachable"),
      );

      const session = makeSession("err-user-1");
      const request = makeRequest("/api/discover/graph");

      const response = await handler.handleDiscoverByGraph(request, session, mockEnv, {} as any);

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toBe("service_unavailable");
    });

    it("returns 503 with Retry-After and no URI on GraphConnectionError (E2)", async () => {
      mockGraphService.discoverByGraph.mockRejectedValue(
        new GraphConnectionError("bolt+s://abc.databases.neo4j.io:7687 connection refused"),
      );

      const session = makeSession("err-user-e2");
      const request = makeRequest("/api/discover/graph");

      const response = await handler.handleDiscoverByGraph(request, session, mockEnv, {} as any);

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("1");
      const body = await response.json();
      expect(body.error).toBe("service_unavailable");
      expect(JSON.stringify(body)).not.toMatch(/bolt|neo4j\.io|username|password/i);
    });

    it("returns 503 with jitter delay on pool-acquire-timeout (E3)", async () => {
      // Asserts the delay that was SCHEDULED, not wall-clock elapsed time.
      //
      // The previous version timed the call and required >= 50ms. setTimeout is
      // allowed to fire a hair early (timer rounding/coalescing), so a 50ms
      // sleep can measure 49 — which is exactly how this failed in CI. Timing
      // the clock also made the suite genuinely wait out the 50-150ms jitter.
      //
      // Reading the requested delay tests the actual contract (a randomised
      // back-off in the documented band) with no dependence on the clock, and
      // the stub resolves immediately so the test no longer sleeps at all.
      mockGraphService.discoverByGraph.mockRejectedValue(
        new GraphConnectionError("connection acquisition timed out"),
      );

      const session = makeSession("err-user-e3");
      const request = makeRequest("/api/discover/graph");

      const scheduledDelays: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation(((callback: any, ms?: number) => {
          scheduledDelays.push(ms ?? 0);
          return realSetTimeout(callback, 0);
        }) as unknown as typeof globalThis.setTimeout);

      try {
        const response = await handler.handleDiscoverByGraph(
          request,
          session,
          mockEnv,
          {} as any,
        );

        expect(response.status).toBe(503);
        const body = await response.json();
        expect(body.error).toBe("service_unavailable");

        // 50 + random()*100 → [50, 150). Asserting the band rather than one
        // value keeps the production jitter free to stay random.
        expect(
          scheduledDelays.some((ms) => ms >= 50 && ms < 150),
          `expected a back-off in [50,150); scheduled: ${JSON.stringify(scheduledDelays)}`,
        ).toBe(true);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it("returns 500 on generic errors from discoverByGraph", async () => {
      mockGraphService.discoverByGraph.mockRejectedValue(new Error("Unexpected failure"));

      const session = makeSession("err-user-2");
      const request = makeRequest("/api/discover/graph");

      const response = await handler.handleDiscoverByGraph(request, session, mockEnv, {} as any);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("INTERNAL_ERROR");
    });

    it("returns 503 when graphService throws GraphConnectionError in discoverNearby", async () => {
      mockGraphService.discoverNearby.mockRejectedValue(
        new GraphConnectionError("Graph DB unreachable"),
      );

      const session = makeSession("err-user-3");
      const request = makeRequest("/api/discover/nearby", { lat: "51.5", lng: "-0.09" });

      const response = await handler.handleDiscoverNearby(request, session, mockEnv, {} as any);

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toBe("service_unavailable");
    });

    it("returns 500 on generic errors from getRecommendations", async () => {
      mockGraphService.getRecommendations.mockRejectedValue(new Error("Unexpected failure"));

      const session = makeSession("err-user-4");
      const request = makeRequest("/api/discover/recommendations");

      const response = await handler.handleGetRecommendations(request, session, mockEnv, {} as any);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("INTERNAL_ERROR");
    });
  });
});
