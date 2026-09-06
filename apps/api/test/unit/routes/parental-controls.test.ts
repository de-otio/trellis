/**
 * Unit tests: parental-controls routes.
 *
 * Baseline route contract (per doc/.../testing.md "Required for all routes"):
 *  - the route array is registered with the expected paths/methods/shape;
 *  - every route rejects an unauthenticated request with 401 (no auth bypass).
 *
 * The 401 path returns before any handler/DB work, so mocking SessionManager
 * (no session) + SecurityHeaders is sufficient and keeps this a fast unit test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));

vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = getSessionMock;
  },
}));

vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    addSecurityHeaders(r: Response) {
      return r;
    }
    createSecureResponse(body: string, init: ResponseInit) {
      return new Response(body, init);
    }
  },
}));

import { composeMiddleware } from "../../../src/lib/middleware.js";
import { parentalControlRoutes } from "../../../src/lib/routes/parental-controls.js";

const mockEnv = { SESSION_SECRET: "test-secret-32-characters-long!!" } as any;

function ctxFor(pathname: string) {
  return {
    url: new URL(`https://api.example.com${pathname}`),
    pathname,
    params: {},
    requestContext: undefined,
  };
}

describe("parental-controls routes: registration", () => {
  it("registers a non-empty set of well-formed routes", () => {
    expect(parentalControlRoutes.length).toBeGreaterThanOrEqual(7);
    for (const route of parentalControlRoutes) {
      expect(route.path).toBeInstanceOf(RegExp);
      expect(typeof route.method).toBe("string");
      expect(typeof route.handler).toBe("function");
      expect(route.description, `route ${route.path} should be documented`).toBeTruthy();
      expect(Array.isArray(route.middleware)).toBe(true);
      expect(route.middleware!.length).toBeGreaterThan(0);
    }
  });

  it("covers the documented child-management surface", () => {
    const methods = parentalControlRoutes.map((r) => r.method);
    expect(methods).toContain("GET");
    expect(methods).toContain("PUT");
    expect(methods).toContain("DELETE");
  });
});

/**
 * A route whose description carries the quarantine marker (see
 * `gateWhileMinorsUnsupported` in ../../../src/lib/routes/parental-controls.ts)
 * answers 410 unconditionally — session or no session — because minor
 * accounts don't exist and the endpoint holds no data to gate. Any route
 * without that marker is a live, session-backed endpoint and must still
 * refuse an unauthenticated caller with 401.
 */
function isGone(route: (typeof parentalControlRoutes)[number]): boolean {
  return (route.description ?? "").includes("GONE");
}

function requestFor(pathname: string, method: string): Request {
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD") {
    init.body = JSON.stringify({});
    init.headers = { "content-type": "application/json" };
  }
  return new Request(`https://api.example.com${pathname}`, init);
}

async function invoke(route: (typeof parentalControlRoutes)[number], method: string) {
  const pathname = "/api/parental/children/child-123/settings";
  const request = requestFor(pathname, method);
  return route.handler(request, mockEnv, ctxFor(pathname) as any);
}

/**
 * Run a request through the route's *actual* middleware chain
 * (`composeMiddleware(route.middleware)`, terminated by the handler) rather
 * than calling `route.handler` directly. This is the same composition
 * production uses (`app.ts`'s `mount()`: `[...route.middleware, …, handler]`)
 * and is load-bearing for the GONE-authenticated-caller assertion below:
 * `route.handler` alone always returns 410 regardless of CSRF, so invoking it
 * directly (as `invoke` above does) cannot detect a broken
 * `gateWhileMinorsUnsupported` CSRF strip (B2). Composing the real chain
 * means a CSRF middleware that survives the strip actually intercepts the
 * request — with a session present and no `X-CSRF-Token` header, it answers
 * 403 before the handler ever runs.
 */
async function invokeThroughMiddleware(
  route: (typeof parentalControlRoutes)[number],
  method: string,
) {
  const pathname = "/api/parental/children/child-123/settings";
  const request = requestFor(pathname, method);
  const url = new URL(request.url);
  const chain = composeMiddleware(route.middleware ?? []);
  return chain({ request, env: mockEnv, url, pathname, method }, () =>
    route.handler(request, mockEnv, ctxFor(pathname) as any),
  );
}

describe("parental-controls routes: auth gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue(null); // unauthenticated
  });

  it("every non-GONE route returns 401 when there is no session; every GONE route returns 410 regardless", async () => {
    let liveRouteCount = 0;

    for (const route of parentalControlRoutes) {
      const method = Array.isArray(route.method) ? route.method[0] : route.method!;
      const res = await invoke(route, method);

      if (isGone(route)) {
        expect(
          res.status,
          `route "${route.description}" (${method}) is quarantined and must answer 410 regardless of session`,
        ).toBe(410);
      } else {
        liveRouteCount++;
        expect(
          res.status,
          `route "${route.description}" (${method}) must gate unauthenticated access`,
        ).toBe(401);
        const body = await res.json();
        expect(body.error).toBe("Unauthorized");
      }
    }
    // Sanity: the unauthenticated check actually ran for every live route.
    expect(getSessionMock).toHaveBeenCalledTimes(liveRouteCount);
  });

  it("every GONE route also returns 410 for an authenticated caller, through the real middleware chain", async () => {
    getSessionMock.mockResolvedValue({
      userId: "guardian1",
      email: "guardian@example.com",
      expiresAt: Date.now() + 3600000,
    });

    for (const route of parentalControlRoutes.filter(isGone)) {
      const method = Array.isArray(route.method) ? route.method[0] : route.method!;
      // No X-CSRF-Token header: a state-changing (PUT/DELETE) request with an
      // authenticated session but no CSRF token is exactly the request shape
      // csrfMiddleware() answers with 403 "CSRF token required" when it is
      // still wired into the chain. Running through the composed middleware
      // (not the handler alone) is what makes this assertion meaningful — see
      // `invokeThroughMiddleware`.
      const res = await invokeThroughMiddleware(route, method);
      expect(
        res.status,
        `route "${route.description}" (${method}) must stay 410 even for an authenticated caller (a 403 here means the CSRF strip in gateWhileMinorsUnsupported broke)`,
      ).toBe(410);
    }
  });
});
