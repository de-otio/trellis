/**
 * Unit Tests: Block Routes
 *
 * Every route must refuse an unauthenticated caller AND a caller whose JWT
 * carries no active tenant — the block table is tenant-scoped by its unique
 * key, so a tenantless call would either write into the wrong scope or fail
 * opaquely at the database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type { TrellisRequestContext } from "../../../src/lib/request-context.js";
import { blockRoutes } from "../../../src/lib/routes/blocks.js";
import type { Session } from "../../../src/lib/session-cookie.js";

const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

const mockCreateSecureResponse = vi.fn();
const mockAddSecurityHeaders = vi.fn();
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    addSecurityHeaders = mockAddSecurityHeaders;
    constructor(_env: any) {}
  },
}));

const mockHandleBlockUser = vi.fn();
const mockHandleUnblockUser = vi.fn();
const mockHandleListBlocks = vi.fn();
vi.mock("../../../src/lib/block-handler", () => ({
  BlockHandler: class {
    handleBlockUser = mockHandleBlockUser;
    handleUnblockUser = mockHandleUnblockUser;
    handleListBlocks = mockHandleListBlocks;
  },
}));

const mockAuthMiddleware = vi.fn();
vi.mock("../../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: any[]) => mockAuthMiddleware(...args),
}));

const TENANT = "tenant-test-123";

const postRoute = blockRoutes.find(
  (r) => r.method === "POST" && r.path === "/api/blocks",
)!;
const getRoute = blockRoutes.find(
  (r) => r.method === "GET" && r.path === "/api/blocks",
)!;
const deleteRoute = blockRoutes.find((r) => r.method === "DELETE")!;

describe("Block Routes", () => {
  let mockEnv: Env;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockSession = { userId: "user-123" } as Session;
    mockRequestContext = { region: "US" } as TrellisRequestContext;

    mockGetSession.mockResolvedValue(mockSession);
    mockAuthMiddleware.mockResolvedValue({
      userId: "user-123",
      activeTenantId: TENANT,
    });
    mockCreateSecureResponse.mockImplementation(
      (body: any, options: any) => new Response(body, options),
    );
    mockAddSecurityHeaders.mockImplementation((r: Response) => r);
    mockHandleBlockUser.mockResolvedValue(new Response("{}", { status: 201 }));
    mockHandleUnblockUser.mockResolvedValue(new Response(null, { status: 204 }));
    mockHandleListBlocks.mockResolvedValue(new Response("{}", { status: 200 }));
  });

  describe("all three routes require an authenticated, tenant-scoped caller", () => {
    const cases: Array<[string, typeof postRoute, () => any]> = [
      ["POST /api/blocks", postRoute, () => mockHandleBlockUser],
      ["GET /api/blocks", getRoute, () => mockHandleListBlocks],
      ["DELETE /api/blocks/:userId", deleteRoute, () => mockHandleUnblockUser],
    ];

    for (const [name, route, handlerMock] of cases) {
      it(`${name} returns 401 with no session`, async () => {
        mockGetSession.mockResolvedValue(null);

        const response = await route.handler(
          new Request("https://example.com/api/blocks/user-target", {
            method: route.method as string,
          }),
          mockEnv,
          {
            pathname: "/api/blocks/user-target",
            params: { userId: "user-target" },
            requestContext: mockRequestContext,
          } as any,
        );

        expect(response.status).toBe(401);
        expect(handlerMock()).not.toHaveBeenCalled();
      });

      it(`${name} returns 401 when the JWT carries no active tenant`, async () => {
        mockAuthMiddleware.mockResolvedValue({ userId: "user-123" });

        const response = await route.handler(
          new Request("https://example.com/api/blocks/user-target", {
            method: route.method as string,
          }),
          mockEnv,
          {
            pathname: "/api/blocks/user-target",
            params: { userId: "user-target" },
            requestContext: mockRequestContext,
          } as any,
        );

        expect(response.status).toBe(401);
        expect(handlerMock()).not.toHaveBeenCalled();
      });
    }
  });

  it("POST passes the JWT tenant, never anything from the body", async () => {
    const request = new Request("https://example.com/api/blocks", {
      method: "POST",
      body: JSON.stringify({ userId: "user-target", tenantId: "attacker" }),
    });

    await postRoute.handler(request, mockEnv, {
      pathname: "/api/blocks",
      requestContext: mockRequestContext,
    } as any);

    expect(mockHandleBlockUser).toHaveBeenCalledWith(
      request,
      mockSession,
      mockEnv,
      mockRequestContext,
      TENANT,
    );
  });

  it("DELETE extracts the target id from the path", async () => {
    await deleteRoute.handler(
      new Request("https://example.com/api/blocks/user-target", {
        method: "DELETE",
      }),
      mockEnv,
      {
        pathname: "/api/blocks/user-target",
        params: { userId: "user-target" },
        requestContext: mockRequestContext,
      } as any,
    );

    expect(mockHandleUnblockUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      mockSession,
      mockEnv,
      mockRequestContext,
      TENANT,
    );
    expect(mockHandleUnblockUser.mock.calls[0][0]).toBe("user-target");
  });

  it("DELETE falls back to the pathname when the router supplies no params", async () => {
    await deleteRoute.handler(
      new Request("https://example.com/api/blocks/user-target", {
        method: "DELETE",
      }),
      mockEnv,
      {
        pathname: "/api/blocks/user-target",
        requestContext: mockRequestContext,
      } as any,
    );

    expect(mockHandleUnblockUser.mock.calls[0][0]).toBe("user-target");
  });

  it("GET is a read route: CORS only, no CSRF", () => {
    const names = (route: typeof getRoute) => route.middleware ?? [];
    // The state-changing routes carry one more middleware (CSRF) plus the
    // rate limiter; the read route must not require a CSRF token.
    expect(names(getRoute)).toHaveLength(1);
    expect(names(postRoute).length).toBeGreaterThan(names(getRoute).length);
    expect(names(deleteRoute).length).toBeGreaterThan(names(getRoute).length);
  });

  it("wraps every response in security headers", async () => {
    await getRoute.handler(
      new Request("https://example.com/api/blocks"),
      mockEnv,
      { pathname: "/api/blocks", requestContext: mockRequestContext } as any,
    );
    expect(mockAddSecurityHeaders).toHaveBeenCalled();
  });
});
