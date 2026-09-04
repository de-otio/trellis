/**
 * Unit Tests: Circles Routes
 *
 * Tests for circle view endpoints: members, feeds, glance, depth, status, entity status, and mark read.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type { TrellisRequestContext } from "../../../src/lib/request-context.js";
import { circleRoutes } from "../../../src/lib/routes/circles.js";
import type { Session } from "../../../src/lib/session-cookie.js";

// Mock SessionManager
const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

// Mock SecurityHeaders
const mockCreateSecureResponse = vi.fn();
const mockAddSecurityHeaders = vi.fn();
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    addSecurityHeaders = mockAddSecurityHeaders;
    constructor(_env: any) {}
  },
}));

// Mock authMiddleware — H1: every circle READ route now resolves the caller's
// verified `activeTenantId` from the JWT and refuses without it. The cookie
// session is deliberately NOT a source for it (session-cookie.ts strips it from
// sealed material), so this is a second, independent auth step, not a duplicate
// of getSession.
const mockAuthMiddleware = vi.fn();
vi.mock("../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: unknown[]) => mockAuthMiddleware(...args),
}));

// Mock CircleHandler
const mockHandleGetMembers = vi.fn();
const mockHandleGetFeed = vi.fn();
const mockHandleGetGlance = vi.fn();
const mockHandleGetDepth = vi.fn();
const mockHandleGetStatus = vi.fn();
const mockHandleGetEntityStatus = vi.fn();
const mockHandleMarkRead = vi.fn();
vi.mock("../../../src/lib/circle-handler", () => ({
  CircleHandler: class {
    handleGetMembers = mockHandleGetMembers;
    handleGetFeed = mockHandleGetFeed;
    handleGetGlance = mockHandleGetGlance;
    handleGetDepth = mockHandleGetDepth;
    handleGetStatus = mockHandleGetStatus;
    handleGetEntityStatus = mockHandleGetEntityStatus;
    handleMarkRead = mockHandleMarkRead;
  },
}));


describe("Circle Routes", () => {
  let mockEnv: Env;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;
  let mockRequest: Request;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockSession = {
      userId: "user-123",
      tenantId: "tenant-123",
      expiresAt: new Date(Date.now() + 3600000),
    } as Session;

    mockRequestContext = {
      tenantId: "tenant-123",
      userId: "user-123",
      region: "us-east-1",
    } as TrellisRequestContext;

    mockRequest = new Request("https://example.com/api/circles/members", {
      method: "GET",
    });

    mockGetSession.mockResolvedValue(mockSession);
    mockAuthMiddleware.mockResolvedValue({
      userId: "user-123",
      activeTenantId: "tenant-123",
    });
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);

    mockHandleGetMembers.mockResolvedValue(new Response("{}", { status: 200 }));
    mockHandleGetFeed.mockResolvedValue(new Response("{}", { status: 200 }));
    mockHandleGetGlance.mockResolvedValue(new Response("{}", { status: 200 }));
    mockHandleGetDepth.mockResolvedValue(new Response("{}", { status: 200 }));
    mockHandleGetStatus.mockResolvedValue(new Response("{}", { status: 200 }));
    mockHandleGetEntityStatus.mockResolvedValue(new Response("{}", { status: 200 }));
    mockHandleMarkRead.mockResolvedValue(new Response("{}", { status: 200 }));
  });

  describe("GET /api/circles/members", () => {
    const getRoute = () => circleRoutes.find((r) => r.method === "GET" && r.path === "/api/circles/members");

    it("should call handleGetMembers when session exists", async () => {
      const route = getRoute();
      await route!.handler(mockRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockHandleGetMembers).toHaveBeenCalledOnce();
      expect(mockAddSecurityHeaders).toHaveBeenCalledOnce();
    });

    it("should return 401 when session is null", async () => {
      mockGetSession.mockResolvedValue(null);
      const route = getRoute();
      await route!.handler(mockRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleGetMembers).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/circles/feed", () => {
    const getRoute = () => circleRoutes.find((r) => r.method === "GET" && r.path === "/api/circles/feed");

    it("should call handleGetFeed when session exists", async () => {
      const route = getRoute();
      await route!.handler(mockRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockHandleGetFeed).toHaveBeenCalledOnce();
      expect(mockAddSecurityHeaders).toHaveBeenCalledOnce();
    });

    it("should return 401 when session is null", async () => {
      mockGetSession.mockResolvedValue(null);
      const route = getRoute();
      await route!.handler(mockRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleGetFeed).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/circles/glance", () => {
    const getRoute = () => circleRoutes.find((r) => r.method === "GET" && r.path === "/api/circles/glance");

    it("should call handleGetGlance when session exists", async () => {
      const route = getRoute();
      await route!.handler(mockRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockHandleGetGlance).toHaveBeenCalledOnce();
      expect(mockAddSecurityHeaders).toHaveBeenCalledOnce();
    });

    it("should return 401 when session is null", async () => {
      mockGetSession.mockResolvedValue(null);
      const route = getRoute();
      await route!.handler(mockRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleGetGlance).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/circles/depth", () => {
    const getRoute = () => circleRoutes.find((r) => r.method === "GET" && r.path === "/api/circles/depth");

    it("should call handleGetDepth when session exists", async () => {
      const route = getRoute();
      await route!.handler(mockRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockHandleGetDepth).toHaveBeenCalledOnce();
      expect(mockAddSecurityHeaders).toHaveBeenCalledOnce();
    });

    it("should return 401 when session is null", async () => {
      mockGetSession.mockResolvedValue(null);
      const route = getRoute();
      await route!.handler(mockRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleGetDepth).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/circles/status", () => {
    const getRoute = () => circleRoutes.find((r) => r.method === "GET" && r.path === "/api/circles/status");

    it("should call handleGetStatus when session exists", async () => {
      const route = getRoute();
      await route!.handler(mockRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockHandleGetStatus).toHaveBeenCalledOnce();
      expect(mockAddSecurityHeaders).toHaveBeenCalledOnce();
    });

    it("should return 401 when session is null", async () => {
      mockGetSession.mockResolvedValue(null);
      const route = getRoute();
      await route!.handler(mockRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleGetStatus).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/circles/entities", () => {
    const getRoute = () => circleRoutes.find((r) => r.method === "GET" && r.path === "/api/circles/entities");

    it("should call handleGetEntityStatus when session exists", async () => {
      const route = getRoute();
      await route!.handler(mockRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockHandleGetEntityStatus).toHaveBeenCalledOnce();
      expect(mockAddSecurityHeaders).toHaveBeenCalledOnce();
    });

    it("should return 401 when session is null", async () => {
      mockGetSession.mockResolvedValue(null);
      const route = getRoute();
      await route!.handler(mockRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleGetEntityStatus).not.toHaveBeenCalled();
    });
  });

  describe("tenant requirement on the read routes (H1)", () => {
    const readRoutes: Array<[string, ReturnType<typeof vi.fn>]> = [
      ["/api/circles/members", mockHandleGetMembers],
      ["/api/circles/feed", mockHandleGetFeed],
      ["/api/circles/glance", mockHandleGetGlance],
      ["/api/circles/depth", mockHandleGetDepth],
      ["/api/circles/status", mockHandleGetStatus],
      ["/api/circles/entities", mockHandleGetEntityStatus],
    ];

    it.each(readRoutes)(
      "%s refuses a caller whose JWT carries no active tenant",
      async (path, handlerMock) => {
        mockAuthMiddleware.mockResolvedValue({ userId: "user-123" });
        const route = circleRoutes.find(
          (r) => r.method === "GET" && r.path === path,
        );

        await route!.handler(mockRequest, mockEnv, {
          requestContext: mockRequestContext,
        });

        expect(mockCreateSecureResponse).toHaveBeenCalledWith(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        // The handler is never reached, so no query is built with an empty
        // tenant — which is what the ambient filter used to do silently.
        expect(handlerMock).not.toHaveBeenCalled();
      },
    );

    it.each(readRoutes)(
      "%s passes the verified activeTenantId through to the handler",
      async (path, handlerMock) => {
        const route = circleRoutes.find(
          (r) => r.method === "GET" && r.path === path,
        );

        await route!.handler(mockRequest, mockEnv, {
          requestContext: mockRequestContext,
        });

        // Last positional argument, in every case.
        const args = handlerMock.mock.calls[0]!;
        expect(args[args.length - 1]).toBe("tenant-123");
      },
    );
  });

  describe("POST /api/circles/read", () => {
    const getRoute = () => circleRoutes.find((r) => r.method === "POST" && r.path === "/api/circles/read");

    it("should call handleMarkRead when session exists", async () => {
      const route = getRoute();
      const postRequest = new Request("https://example.com/api/circles/read", { method: "POST" });
      await route!.handler(postRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockGetSession).toHaveBeenCalledWith(postRequest, "test-secret", mockEnv);
      expect(mockHandleMarkRead).toHaveBeenCalledOnce();
      expect(mockAddSecurityHeaders).toHaveBeenCalledOnce();
    });

    it("should return 401 when session is null", async () => {
      mockGetSession.mockResolvedValue(null);
      const route = getRoute();
      const postRequest = new Request("https://example.com/api/circles/read", { method: "POST" });
      await route!.handler(postRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleMarkRead).not.toHaveBeenCalled();
    });
  });

  describe("Route configuration", () => {
    it("should have 7 circle routes", () => {
      expect(circleRoutes).toHaveLength(7);
    });

    it("should have correct HTTP methods", () => {
      const getRoutes = circleRoutes.filter((r) => r.method === "GET");
      const postRoutes = circleRoutes.filter((r) => r.method === "POST");
      expect(getRoutes).toHaveLength(6);
      expect(postRoutes).toHaveLength(1);
    });
  });
});
