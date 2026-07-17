/**
 * Unit Tests: report routes auth gate (compliance plan 08 §5 — "unauth => 401").
 *
 * Both /api/reports (POST) and /api/reports/mine (GET) require a session.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";

const mockGetSession = vi.fn();
vi.mock("../../src/lib/session-cookie.js", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
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
});
