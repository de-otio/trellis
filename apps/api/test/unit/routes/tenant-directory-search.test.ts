/**
 * Unit Tests: Directory Search Route (T4)
 *
 * Covers the route-level contract: authentication required, per-user rate
 * limiting, input-validation 400s (short query / empty filter), and a happy
 * path that threads validated params into the executor.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type { Session } from "../../../src/lib/session-cookie.js";

// ── Mock SessionManager ──
const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

// ── Mock SecurityHeaders (pass-through) ──
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    constructor(_env: any) {}
    addSecurityHeaders = (r: Response) => r;
    createSecureResponse = (body: BodyInit | null, init?: ResponseInit) => new Response(body, init);
  },
}));

// ── Mock RateLimiter ──
const mockApplyRateLimitKV = vi.fn();
vi.mock("../../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    applyRateLimitKV = mockApplyRateLimitKV;
  },
}));

// ── Mock db.createPrisma ──
const mockPrisma = {} as any;
vi.mock("../../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

// ── Partially mock directory-search: keep real validateAndNormalize, stub the executor ──
// `vi.hoisted` so the factory (which references it at eval time) sees an
// initialized value despite vi.mock being hoisted above the const declarations.
const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }));
vi.mock("../../../src/lib/tenant/directory-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/tenant/directory-search.js")>();
  return { ...actual, executeDirectorySearch: mockExecute };
});

import { tenantDirectorySearchRoutes } from "../../../src/lib/routes/tenant-directory-search.js";

const route = tenantDirectorySearchRoutes[0];

function makeRequest(query: string): Request {
  return new Request(`https://api.example.com/api/directory/search${query}`, { method: "GET" });
}

const ctx = { url: new URL("https://api.example.com"), pathname: "/api/directory/search", params: {} };

describe("GET /api/directory/search", () => {
  let mockEnv: Env;
  const session: Session = {
    userId: "user-123",
    email: "u@example.com",
    expiresAt: Date.now() + 3_600_000,
    dataRegion: "EU",
  } as Session;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = { SESSION_SECRET: "test-secret-32-characters-long!!" } as Env;
    mockGetSession.mockResolvedValue(session);
    mockApplyRateLimitKV.mockResolvedValue(null); // not rate limited by default
    mockExecute.mockResolvedValue([]);
  });

  it("returns 401 when unauthenticated (auth is required for MVP)", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await route.handler(makeRequest("?name=berlin"), mockEnv, ctx as any);
    expect(res.status).toBe(401);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("returns 429 when the per-user rate limit is exceeded", async () => {
    mockApplyRateLimitKV.mockResolvedValue(new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429 }));
    const res = await route.handler(makeRequest("?name=berlin"), mockEnv, ctx as any);
    expect(res.status).toBe(429);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("rate-limits per authenticated user (keys the bucket on userId)", async () => {
    await route.handler(makeRequest("?name=berlin"), mockEnv, ctx as any);
    // signature: (env, request, endpoint, limit, window, sessionId, email, userId)
    const call = mockApplyRateLimitKV.mock.calls[0];
    expect(call[2]).toBe("/api/directory/search");
    expect(call[7]).toBe("user-123");
  });

  it("returns 400 for a name query below the minimum length (S10)", async () => {
    const res = await route.handler(makeRequest("?name=ab"), mockEnv, ctx as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("QUERY_TOO_SHORT");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty-filter request (S18 — no list-everything)", async () => {
    const res = await route.handler(makeRequest(""), mockEnv, ctx as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("EMPTY_FILTER");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("returns 200 with results + pagination echo on a valid search", async () => {
    mockExecute.mockResolvedValue([
      { tenantId: "t1", slug: "acme", displayName: "Acme", locationPrecision: "CITY", locationLabel: "Berlin, Germany" },
    ]);
    const res = await route.handler(makeRequest("?name=acme&pageSize=10"), mockEnv, ctx as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.pageSize).toBe(10);
    expect(body.page).toBe(0);
    expect(mockExecute).toHaveBeenCalledOnce();
  });

  it("returns 500 (without leaking internals) when the executor throws", async () => {
    mockExecute.mockRejectedValue(new Error("boom"));
    const res = await route.handler(makeRequest("?name=acme"), mockEnv, ctx as any);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("INTERNAL_ERROR");
  });
});
