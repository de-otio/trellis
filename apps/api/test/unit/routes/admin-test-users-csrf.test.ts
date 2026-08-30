/**
 * Unit Tests: POST /api/admin/test/users — middleware composition + the real
 * super-admin gate.
 *
 * Two regressions this file exists to catch, neither of which any other test
 * would fail on:
 *
 * 1. Dropping `csrfMiddleware()` from the route's `middleware` array would
 *    silently reopen the CSRF-disabled finding fixed in SEC L1 —
 *    `admin.test.ts` calls `route.handler()` directly and so bypasses the
 *    middleware entirely. This file composes the route's ACTUAL middleware
 *    array with its ACTUAL handler (via the real `composeMiddleware`), so the
 *    absence of CSRF enforcement turns the no-token case from 403 into 201.
 *
 * 2. The super-admin gate itself (`requireSuperAdminSession`) is exercised
 *    against production code here — replacing the deleted
 *    `super-admin-access.test.ts`, which asserted only against hand-written
 *    inline closures and covered nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { adminRoutes } from "../../../src/lib/routes/admin.js";
import { composeMiddleware } from "../../../src/lib/middleware.js";
import { createMockEnv } from "../../utils/mock-env.js";

// Session plane: the CSRF middleware and the handler both resolve the session
// through SessionManager; give them a controllable one.
const mockGetSession = vi.fn();
const mockSetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
    setSession = mockSetSession;
  },
}));

// CSRF token validation: accept exactly one token value so the "missing" and
// "present+valid" cases are both expressible.
const mockValidateToken = vi.fn();
vi.mock("../../../src/lib/csrf", () => ({
  CSRFProtection: {
    validateToken: (...args: unknown[]) => mockValidateToken(...args),
  },
}));

// Response plumbing the handler uses on its way out — pass-through fakes.
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse(body: string, init?: ResponseInit) {
      return new Response(body, init);
    }
    addSecurityHeaders(response: Response) {
      return response;
    }
  },
}));
vi.mock("../../../src/worker", () => ({
  addCorsHeaders: (response: Response) => response,
}));

// DB plane: `mockUserRole` drives what the real `requireSuperAdminSession`
// sees when it looks the caller's role up.
const mockCreateUser = vi.fn();
vi.mock("../../../src/lib/data-router", () => ({
  DataRouter: {
    createUser: (...args: unknown[]) => mockCreateUser(...args),
  },
}));
const mockUserFindUnique = vi.fn();
vi.mock("../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: async (
    _mgr: unknown,
    _region: unknown,
    _env: unknown,
    fn: (db: unknown) => Promise<unknown>,
  ) => fn({ user: { findUnique: mockUserFindUnique } }),
  QueryTimeoutPresets: { USER_FACING: { timeoutMs: 1000 } },
}));
vi.mock("../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {},
}));
vi.mock("../../../src/lib/region-detection", () => ({
  detectRegionSync: () => "US",
}));

const ROUTE_PATH = "/api/admin/test/users";

function findRoute() {
  const route = adminRoutes.find(
    (r) => r.path === ROUTE_PATH && r.method === "POST",
  );
  if (!route) throw new Error(`route POST ${ROUTE_PATH} not found`);
  return route;
}

/** Run the route the way the router does: middleware chain around the handler. */
async function dispatch(request: Request, env: Env): Promise<Response> {
  const route = findRoute();
  const url = new URL(request.url);
  const context = {
    request,
    env,
    url,
    pathname: url.pathname,
    method: request.method,
  };
  const chain = composeMiddleware(route.middleware ?? []);
  return chain(context, () =>
    route.handler(request, env, {
      url,
      pathname: url.pathname,
      params: {},
    }),
  );
}

function makeRequest(headers: Record<string, string>): Request {
  return new Request(`https://api.example.com${ROUTE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ email: "someone@test.example.com", role: "END_USER" }),
  });
}

const superAdminSession = {
  userId: "super-admin-1",
  email: "admin@example.com",
  role: "SUPER_ADMIN",
  expiresAt: Date.now() + 3_600_000,
  csrfToken: "valid-csrf-token",
  sessionType: "user",
};

describe("POST /api/admin/test/users — composed route", () => {
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    env = createMockEnv({ ENABLE_TEST_ROUTES: "true" }) as unknown as Env;
    mockGetSession.mockResolvedValue(superAdminSession);
    mockSetSession.mockImplementation(async (response: Response) => response);
    mockValidateToken.mockImplementation(
      async (token: string) => token === "valid-csrf-token",
    );
    mockUserFindUnique.mockResolvedValue({ role: "SUPER_ADMIN" });
    mockCreateUser.mockResolvedValue({
      id: "created-user-1",
      email: "someone@test.example.com",
      region: "US",
      dataRegion: "US",
    });
  });

  describe("CSRF enforcement comes from the route's middleware array", () => {
    it("rejects a cookie-authenticated POST without a CSRF token (403), handler untouched", async () => {
      const response = await dispatch(
        makeRequest({ Cookie: "session=sealed-session-value" }),
        env,
      );

      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/CSRF/i);
      // The exploit this guards: without csrfMiddleware() in route.middleware,
      // this request would have minted a user + session.
      expect(mockCreateUser).not.toHaveBeenCalled();
      expect(mockSetSession).not.toHaveBeenCalled();
    });

    it("rejects a cookie-authenticated POST with an INVALID CSRF token (403)", async () => {
      const response = await dispatch(
        makeRequest({
          Cookie: "session=sealed-session-value",
          "X-CSRF-Token": "wrong-token",
        }),
        env,
      );

      expect(response.status).toBe(403);
      expect(mockCreateUser).not.toHaveBeenCalled();
    });

    it("lets a valid CSRF token through to the handler (201) — the 403 above is really CSRF", async () => {
      const response = await dispatch(
        makeRequest({
          Cookie: "session=sealed-session-value",
          "X-CSRF-Token": "valid-csrf-token",
        }),
        env,
      );

      expect(response.status).toBe(201);
      expect(mockCreateUser).toHaveBeenCalledTimes(1);
    });
  });

  describe("requireSuperAdminSession — the real gate (production code)", () => {
    it("returns 401 when there is no session at all", async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await dispatch(makeRequest({}), env);

      expect(response.status).toBe(401);
      expect(mockCreateUser).not.toHaveBeenCalled();
    });

    it.each(["INTERNAL", "END_USER", "B2B_PARTNER"])(
      "returns 403 when the caller's DB role is %s",
      async (role) => {
        mockUserFindUnique.mockResolvedValue({ role });

        const response = await dispatch(
          makeRequest({
            Cookie: "session=sealed-session-value",
            "X-CSRF-Token": "valid-csrf-token",
          }),
          env,
        );

        expect(response.status).toBe(403);
        const body = (await response.json()) as { error: string };
        expect(body.error).toMatch(/Super-admin/i);
        expect(mockCreateUser).not.toHaveBeenCalled();
      },
    );

    it("returns 403 when the role lookup finds no user (fail closed)", async () => {
      mockUserFindUnique.mockResolvedValue(null);

      const response = await dispatch(
        makeRequest({
          Cookie: "session=sealed-session-value",
          "X-CSRF-Token": "valid-csrf-token",
        }),
        env,
      );

      expect(response.status).toBe(403);
      expect(mockCreateUser).not.toHaveBeenCalled();
    });

    it("allows a verified SUPER_ADMIN (201)", async () => {
      const response = await dispatch(
        makeRequest({
          Cookie: "session=sealed-session-value",
          "X-CSRF-Token": "valid-csrf-token",
        }),
        env,
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { success: boolean };
      expect(body.success).toBe(true);
    });
  });
});
