/**
 * Unit Tests: Parental Control Routes
 *
 * Tests for route definitions, authentication, and middleware configuration.
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

describe("Parental Control Routes", () => {
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      SESSION_SECRET: "test-secret-32-characters-long!!",
    } as Env;
  });

  it("should define the correct number of routes", () => {
    expect(parentalControlRoutes).toHaveLength(7);
  });

  it("should return 401 for unauthenticated GET /api/parental/children", async () => {
    mockGetSession.mockResolvedValue(null);

    const route = parentalControlRoutes.find(
      (r) => r.method === "GET" && r.path.toString().includes("children$"),
    );
    expect(route).toBeDefined();

    const request = new Request("https://api.example.com/api/parental/children");
    const response = await route!.handler(request, mockEnv as any, {
      url: new URL("https://api.example.com/api/parental/children"),
      pathname: "/api/parental/children",
      params: {},
    });

    expect(response.status).toBe(401);
  });

  it("should handle GET /api/parental/children for authenticated user", async () => {
    mockGetSession.mockResolvedValue({
      userId: "guardian1",
      email: "guardian@example.com",
      expiresAt: Date.now() + 3600000,
    });
    mockPrisma.parentalLink.findMany.mockResolvedValue([
      {
        child: {
          id: "child1",
          email: "child@example.com",
          ageTier: "CHILD",
          profileVisibility: "PRIVATE",
        },
      },
    ]);

    const route = parentalControlRoutes.find(
      (r) => r.method === "GET" && r.path.toString().includes("children$"),
    );

    const request = new Request("https://api.example.com/api/parental/children");
    const response = await route!.handler(request, mockEnv as any, {
      url: new URL("https://api.example.com/api/parental/children"),
      pathname: "/api/parental/children",
      params: {},
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.children).toHaveLength(1);
  });

  it("should handle PUT settings with valid body", async () => {
    mockGetSession.mockResolvedValue({
      userId: "guardian1",
      email: "guardian@example.com",
      expiresAt: Date.now() + 3600000,
    });
    mockPrisma.parentalLink.findFirst.mockResolvedValue({ id: "link1" });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "child1",
      ageTier: "CHILD",
      stealthMode: true,
      showOnlineStatus: false,
      showTypingIndicator: false,
      showLastSeen: false,
      locationTrackingEnabled: false,
      locationAnonymizationLevel: 3,
      analyticsOptOut: true,
      profileVisibility: "PRIVATE",
      dmAccess: "NOBODY",
    });
    mockPrisma.user.update.mockResolvedValue({});

    const route = parentalControlRoutes.find(
      (r) => r.method === "PUT" && r.path.toString().includes("settings"),
    );
    expect(route).toBeDefined();

    const request = new Request("https://api.example.com/api/parental/children/child1/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ showOnlineStatus: true }),
    });

    const response = await route!.handler(request, mockEnv as any, {
      url: new URL("https://api.example.com/api/parental/children/child1/settings"),
      pathname: "/api/parental/children/child1/settings",
      params: {},
    });

    expect(response.status).toBe(200);
  });

  it("should return 401 for unauthenticated DELETE /api/parental/children/:id/link", async () => {
    mockGetSession.mockResolvedValue(null);

    const route = parentalControlRoutes.find(
      (r) => r.method === "DELETE" && r.path.toString().includes("link"),
    );
    expect(route).toBeDefined();

    const request = new Request("https://api.example.com/api/parental/children/child1/link", {
      method: "DELETE",
    });

    const response = await route!.handler(request, mockEnv as any, {
      url: new URL("https://api.example.com/api/parental/children/child1/link"),
      pathname: "/api/parental/children/child1/link",
      params: {},
    });

    expect(response.status).toBe(401);
  });

  it("should have correct methods and middleware on each route", () => {
    const getChildren = parentalControlRoutes[0];
    expect(getChildren.method).toBe("GET");
    expect(getChildren.middleware).toBeDefined();
    expect(getChildren.middleware!.length).toBeGreaterThanOrEqual(1);

    const putSettings = parentalControlRoutes[2];
    expect(putSettings.method).toBe("PUT");
    expect(putSettings.middleware).toBeDefined();
    // PUT routes should have CSRF middleware
    expect(putSettings.middleware!.length).toBeGreaterThanOrEqual(2);

    const deleteLink = parentalControlRoutes[6];
    expect(deleteLink.method).toBe("DELETE");
    expect(deleteLink.middleware).toBeDefined();
    expect(deleteLink.middleware!.length).toBeGreaterThanOrEqual(2);
  });

  it("should return 400 for invalid childId in GET settings", async () => {
    mockGetSession.mockResolvedValue({
      userId: "guardian1",
      email: "guardian@example.com",
      expiresAt: Date.now() + 3600000,
    });

    const route = parentalControlRoutes.find(
      (r) => r.method === "GET" && r.path.toString().includes("settings"),
    );
    expect(route).toBeDefined();

    const request = new Request("https://api.example.com/api/parental/children//settings");
    const response = await route!.handler(request, mockEnv as any, {
      url: new URL("https://api.example.com/api/parental/children//settings"),
      pathname: "/api/parental/children//settings",
      params: {},
    });

    // The regex won't match an empty childId, so this returns 400
    expect(response.status).toBe(400);
  });
});
