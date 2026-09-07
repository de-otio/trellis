/**
 * Unit tests: GET /api/admin/costs (routes/admin-costs.ts).
 *
 * NOTE: `test/unit/admin-costs.test.ts` (top-level) re-implements the status
 * math WITHOUT importing this module at all — it pins the formula, not the
 * route. This file exercises the actual route wiring: the auth/role gate,
 * the module-level 30s cache (`vi.resetModules()` per test to isolate the
 * mutable `cachedStatus` singleton, since it is shared across every request
 * this Node process serves), and the error path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

const mockUserFindUnique = vi.fn();
vi.mock("../../../src/db", () => ({
  createPrisma: vi.fn(() => ({ user: { findUnique: mockUserFindUnique } })),
}));

const mockGetStatus = vi.fn();
vi.mock("../../../src/lib/openai-budget", () => ({
  OpenAiBudget: class {
    getStatus = mockGetStatus;
  },
}));

const mockGetDailySummary = vi.fn();
vi.mock("../../../src/lib/cost-accumulator", () => ({
  CostAccumulator: { getInstance: () => ({ getDailySummary: mockGetDailySummary }) },
}));

vi.mock("../../../src/worker", () => ({
  addCorsHeaders: (res: Response) => res,
}));

vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse(body: BodyInit | null, init: ResponseInit) {
      return new Response(body, init);
    }
  },
}));

vi.mock("../../../src/lib/middleware", () => ({
  corsMiddleware: vi.fn(() => ({ name: "cors" })),
}));

const env = { SESSION_SECRET: "test-secret-32-characters-long!!" } as any;

function req(): Request {
  return new Request("https://api.example.com/api/admin/costs");
}

const OK_OPENAI = {
  hourlyUsed: 1,
  hourlyLimit: 500,
  dailyUsed: 100,
  dailyLimit: 5000,
  exceeded: false,
};
const OK_DAILY = { date: "2026-09-06", estimatedTotal: 2, limit: 10, services: {} };

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mockGetStatus.mockResolvedValue(OK_OPENAI);
  mockGetDailySummary.mockResolvedValue(OK_DAILY);
});

afterEach(() => {
  vi.useRealTimers();
});

async function loadRoute() {
  const { adminCostRoutes } = await import("../../../src/lib/routes/admin-costs.js");
  return adminCostRoutes[0];
}

describe("GET /api/admin/costs — auth gate", () => {
  it("401 when unauthenticated — no DB lookup, no budget calls", async () => {
    mockGetSession.mockResolvedValue(null);
    const route = await loadRoute();
    const res = await route.handler(req(), env, {} as any);
    expect(res.status).toBe(401);
    expect(mockUserFindUnique).not.toHaveBeenCalled();
    expect(mockGetStatus).not.toHaveBeenCalled();
  });

  it("403 when authenticated but NOT SUPER_ADMIN", async () => {
    mockGetSession.mockResolvedValue({ userId: "u1" });
    mockUserFindUnique.mockResolvedValue({ role: "MODERATOR" });
    const route = await loadRoute();
    const res = await route.handler(req(), env, {} as any);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Super-admin access required/);
    expect(mockGetStatus).not.toHaveBeenCalled();
  });

  it("403 when the user row does not exist", async () => {
    mockGetSession.mockResolvedValue({ userId: "ghost" });
    mockUserFindUnique.mockResolvedValue(null);
    const route = await loadRoute();
    const res = await route.handler(req(), env, {} as any);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/admin/costs — status computation", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue({ userId: "admin1" });
    mockUserFindUnique.mockResolvedValue({ role: "SUPER_ADMIN" });
  });

  it("200 'ok' well under both limits", async () => {
    const route = await loadRoute();
    const res = await route.handler(req(), env, {} as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.openai).toEqual(OK_OPENAI);
    expect(body.daily).toEqual(OK_DAILY);
  });

  it("'exceeded' when the OpenAI budget itself reports exceeded", async () => {
    mockGetStatus.mockResolvedValue({ ...OK_OPENAI, exceeded: true });
    const route = await loadRoute();
    const res = await route.handler(req(), env, {} as any);
    expect((await res.json()).status).toBe("exceeded");
  });

  it("'exceeded' when the daily estimated total is AT the limit (>=)", async () => {
    mockGetDailySummary.mockResolvedValue({ ...OK_DAILY, estimatedTotal: 10, limit: 10 });
    const route = await loadRoute();
    const res = await route.handler(req(), env, {} as any);
    expect((await res.json()).status).toBe("exceeded");
  });

  it("'warning' at just over 80% OpenAI hourly-vs-daily usage ratio", async () => {
    mockGetStatus.mockResolvedValue({ ...OK_OPENAI, dailyUsed: 801, dailyLimit: 1000 });
    const route = await loadRoute();
    const res = await route.handler(req(), env, {} as any);
    expect((await res.json()).status).toBe("warning");
  });

  it("'ok' at EXACTLY 80% (boundary is exclusive)", async () => {
    mockGetStatus.mockResolvedValue({ ...OK_OPENAI, dailyUsed: 800, dailyLimit: 1000 });
    const route = await loadRoute();
    const res = await route.handler(req(), env, {} as any);
    expect((await res.json()).status).toBe("ok");
  });

  it("500 when a budget lookup throws", async () => {
    mockGetStatus.mockRejectedValue(new Error("dynamo down"));
    const route = await loadRoute();
    const res = await route.handler(req(), env, {} as any);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Failed to fetch cost status/);
  });
});

describe("GET /api/admin/costs — 30s in-memory cache", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue({ userId: "admin1" });
    mockUserFindUnique.mockResolvedValue({ role: "SUPER_ADMIN" });
  });

  it("a second request within the TTL reuses the cached data — no second budget fetch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const route = await loadRoute();

    await route.handler(req(), env, {} as any);
    expect(mockGetStatus).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-01-01T00:00:10Z")); // +10s, inside 30s TTL
    const res2 = await route.handler(req(), env, {} as any);
    expect(res2.status).toBe(200);
    expect(mockGetStatus).toHaveBeenCalledTimes(1); // still one — served from cache
  });

  it("a request after the TTL expires re-fetches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const route = await loadRoute();

    await route.handler(req(), env, {} as any);
    expect(mockGetStatus).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-01-01T00:00:31Z")); // +31s, past the 30s TTL
    await route.handler(req(), env, {} as any);
    expect(mockGetStatus).toHaveBeenCalledTimes(2);
  });

  it("cached data is served WITHOUT re-checking auth's DB lookup cost — but the auth gate itself still runs every request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const route = await loadRoute();
    await route.handler(req(), env, {} as any);

    vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
    mockUserFindUnique.mockResolvedValue({ role: "MODERATOR" }); // demoted mid-window
    const res = await route.handler(req(), env, {} as any);
    // The auth/role gate runs before the cache check, so a demoted user is
    // still refused even though cached cost data exists.
    expect(res.status).toBe(403);
  });
});
