/**
 * Unit Tests: Parental Control Routes — quarantine
 *
 * Minor accounts are not a supported account type (18+ minimum age, enforced
 * server-side; see `src/lib/age-gate.ts`). The guardian endpoints therefore
 * answer 410 Gone and never reach `ParentalControlHandler`.
 *
 * These tests replace a suite that drove the handlers with hand-built CHILD
 * sessions and asserted 200s. Those assertions were true of the code and
 * false of the product: no CHILD account could exist, so nothing they proved
 * was reachable. What matters now is the refusal — that it is uniform, that
 * it is 410 rather than a 404 a caller would retry, and that no route quietly
 * escapes the gate.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";

// Mock Prisma client
const mockPrisma = {
  parentalLink: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

// Mock SessionManager
const mockGetSession = vi.fn();
vi.mock("../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));


// Mock SecurityHeaders
vi.mock("../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse(body: string, init: ResponseInit) {
      return new Response(body, init);
    }
    addSecurityHeaders(response: Response) {
      return response;
    }
  },
}));

// Mock validate-request
vi.mock("../../src/lib/validate-request", () => ({
  validateRequest: vi.fn(async (request: Request, _schema: any) => {
    try {
      const data = await request.json();
      return { success: true, data };
    } catch {
      return {
        success: false,
        error: new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      };
    }
  }),
}));

// Mock middleware
vi.mock("../../src/lib/middleware", () => ({
  corsMiddleware: vi.fn(() => ({ name: "cors" })),
  csrfMiddleware: vi.fn(() => ({ name: "csrf" })),
  rateLimitMiddleware: vi.fn(() => ({ name: "rateLimit" })),
}));

import { parentalControlRoutes } from "../../src/lib/routes/parental-controls.js";

describe("parental control routes (minor accounts unsupported)", () => {
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      SESSION_SECRET: "test-secret-32-characters-long!!",
    } as Env;
  });

  function callRoute(route: (typeof parentalControlRoutes)[number], method: string) {
    const url = "https://api.example.com/api/parental/children/child1/settings";
    return route.handler(new Request(url, { method }), mockEnv as any, {
      url: new URL(url),
      pathname: "/api/parental/children/child1/settings",
      params: {},
    });
  }

  it("still registers all seven routes, with their paths and methods intact", () => {
    // Unregistering them would make the paths 404 — "no such endpoint" — which
    // is not what happened. They exist and are withdrawn.
    expect(parentalControlRoutes).toHaveLength(7);
    expect(parentalControlRoutes.map((r) => r.method)).toEqual([
      "GET",
      "GET",
      "PUT",
      "PUT",
      "PUT",
      "PUT",
      "DELETE",
    ]);
    expect(parentalControlRoutes.map((r) => r.path.toString())).toEqual([
      String(/^\/api\/parental\/children$/),
      String(/^\/api\/parental\/children\/([^/]+)\/settings$/),
      String(/^\/api\/parental\/children\/([^/]+)\/settings$/),
      String(/^\/api\/parental\/children\/([^/]+)\/quiet-hours$/),
      String(/^\/api\/parental\/children\/([^/]+)\/dm-access$/),
      String(/^\/api\/parental\/children\/([^/]+)\/profile-visibility$/),
      String(/^\/api\/parental\/children\/([^/]+)\/link$/),
    ]);
  });

  it("answers 410 with the structured envelope on every route", async () => {
    for (const route of parentalControlRoutes) {
      const method = Array.isArray(route.method) ? route.method[0] : route.method ?? "GET";
      const response = await callRoute(route, method);

      expect(response.status).toBe(410);
      const body = (await response.json()) as Record<string, string>;
      expect(body.error).toBe("MINOR_ACCOUNTS_NOT_SUPPORTED");
      expect(body.message.length).toBeGreaterThan(0);
      expect(body.remediation.length).toBeGreaterThan(0);
    }
  });

  it("refuses without consulting the session or the database", async () => {
    // The refusal is a statement about the endpoint, not about the caller, so
    // it must not depend on who is asking. A gate that first loads a session
    // is a gate that can be got past by presenting one.
    mockGetSession.mockResolvedValue({
      userId: "guardian1",
      email: "guardian@example.com",
      expiresAt: Date.now() + 3600000,
    });

    for (const route of parentalControlRoutes) {
      const method = Array.isArray(route.method) ? route.method[0] : route.method ?? "GET";
      expect((await callRoute(route, method)).status).toBe(410);
    }

    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockPrisma.parentalLink.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.parentalLink.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it("refuses an authenticated guardian with a real linked child just the same", async () => {
    mockGetSession.mockResolvedValue({
      userId: "guardian1",
      email: "guardian@example.com",
      expiresAt: Date.now() + 3600000,
    });
    mockPrisma.parentalLink.findMany.mockResolvedValue([
      { child: { id: "child1", email: "child@example.com", ageTier: "CHILD" } },
    ]);

    const listChildren = parentalControlRoutes[0];
    const response = await callRoute(listChildren, "GET");

    expect(response.status).toBe(410);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.children).toBeUndefined();
  });

  it("keeps CORS and rate limiting but drops CSRF from the gated routes", () => {
    // A 410 changes no state, so a CSRF rejection would answer with a 403 that
    // misdescribes why the call failed.
    for (const route of parentalControlRoutes) {
      expect(route.middleware).toBeDefined();
      expect(route.middleware).not.toContainEqual({ name: "csrf" });
      expect(route.middleware).toContainEqual({ name: "cors" });
      expect(route.middleware).toContainEqual({ name: "rateLimit" });
    }
  });

  it("keeps the endpoints off the public OpenAPI spec", () => {
    for (const route of parentalControlRoutes) {
      expect(route.publicSpec).toBe(false);
    }
  });
});
