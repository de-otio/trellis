/**
 * Unit Tests: report routes auth gate (compliance plan 08 §5 — "unauth => 401").
 *
 * All three reporter routes — POST /api/reports, GET /api/reports/mine and the
 * GET /api/reports/:id status poll — require a session. The status poll also has
 * to keep `mine` out of the id space, since it shares a path shape with it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";

const mockGetSession = vi.fn();
vi.mock("../../src/lib/session-cookie.js", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

const mockDb = {
  report: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
  statementOfReasons: { findFirst: vi.fn(async () => null) },
};
vi.mock("../../src/lib/data-router.js", () => ({
  DataRouter: { getDatabaseForRegion: vi.fn(() => mockDb) },
}));

import { reportRoutes } from "../../src/lib/routes/reports.js";

const mockEnv = {
  SESSION_SECRET: "test-secret-32-characters-long!!!",
  DEFAULT_REGION: "EU",
} as unknown as Env;

function routeFor(path: string, method: string) {
  const route = reportRoutes.find(
    (r) => r.path === path && r.method === method,
  );
  if (!route) throw new Error(`route ${method} ${path} not found`);
  return route;
}

/** The single-report status poll is the only RegExp-pathed route here. */
function statusRoute() {
  const route = reportRoutes.find(
    (r) => r.path instanceof RegExp && r.method === "GET",
  );
  if (!route) throw new Error("status-poll route not found");
  return route;
}

const ctx = { requestContext: { region: "EU" } as any, pathname: "/api/reports" } as any;

describe("report routes — unauthenticated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(null);
  });

  it("POST /api/reports => 401 when no session", async () => {
    const route = routeFor("/api/reports", "POST");
    const req = new Request("https://api.example.com/api/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const res = await route.handler(req as any, mockEnv, ctx);
    expect(res.status).toBe(401);
  });

  it("GET /api/reports/mine => 401 when no session", async () => {
    const route = routeFor("/api/reports/mine", "GET");
    const req = new Request("https://api.example.com/api/reports/mine", {
      method: "GET",
    });
    const res = await route.handler(
      req as any,
      mockEnv,
      { ...ctx, pathname: "/api/reports/mine" },
    );
    expect(res.status).toBe(401);
  });

  it("GET /api/reports/:id => 401 when no session", async () => {
    const route = statusRoute();
    const req = new Request("https://api.example.com/api/reports/rep1", {
      method: "GET",
    });
    const res = await route.handler(req as any, mockEnv, {
      ...ctx,
      pathname: "/api/reports/rep1",
    });
    expect(res.status).toBe(401);
  });
});

describe("report status-poll route — path shape", () => {
  it("its pattern is translatable to a Hono path (no lookaheads)", () => {
    const pattern = statusRoute().path as RegExp;
    // app.ts's regexToHonoPath refuses anything with leftover metacharacters;
    // a lookahead here would make the route fail to mount at boot.
    expect(pattern.source).not.toContain("?!");
    expect(pattern.test("/api/reports/rep1")).toBe(true);
    // One segment only — it must not swallow a nested path.
    expect(pattern.test("/api/reports/rep1/extra")).toBe(false);
  });

  it("resolves `mine` to the listing rather than treating it as a report id", async () => {
    mockGetSession.mockResolvedValue({ userId: "user123" });
    const route = statusRoute();
    const req = new Request("https://api.example.com/api/reports/mine", {
      method: "GET",
    });

    const res = await route.handler(req as any, mockEnv, {
      ...ctx,
      pathname: "/api/reports/mine",
    });

    // The listing path is taken: a `reports` array, not a single-report
    // document with a `receipt`, and no lookup by the literal id "mine".
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty("reports");
    expect(body).not.toHaveProperty("receipt");
    expect(mockDb.report.findFirst).not.toHaveBeenCalled();
  });
});
