/**
 * Unit Tests: S4 Runtime Hardening
 *
 * Tests for:
 * - S4.2: Rate limiter fail-closed on admin/auth routes
 * - S4.4: CSRF token rotation after 24 hours
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock SessionManager
vi.mock("../../src/lib/session-cookie", () => ({
  SessionManager: class {
    async getSession() {
      return null;
    }
  },
}));

// Force the (consolidated token-bucket) limiter to fail so the middleware's
// S4.2 failure policy is exercised: the strict distributed check rejects, and
// the middleware decides fail-closed (sensitive routes) vs fail-open.
vi.mock("../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    checkRateLimitKVStrict = vi
      .fn()
      .mockRejectedValue(new Error("rate limiter unavailable"));
  },
  buildRateLimitResponse: () =>
    new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    }),
}));


describe("S4.2: Rate limiter fail-closed on admin/auth routes", () => {
  let rateLimitMiddleware: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const middleware = await import("../../src/lib/middleware.js");
    rateLimitMiddleware = middleware.rateLimitMiddleware;
  });

  it("should return 503 when rate limiting fails on /api/admin routes", async () => {
    const middleware = rateLimitMiddleware();

    // Create a context with a broken KV that throws
    const brokenKV = {
      get: vi.fn().mockRejectedValue(new Error("KV unavailable")),
      put: vi.fn().mockRejectedValue(new Error("KV unavailable")),
    };

    const mockEnv = {
      FEED_CACHE_KV: brokenKV,
      SESSION_SECRET: "test-secret",
    } as any;

    const context = {
      request: new Request("https://api.example.com/api/admin/users", {
        method: "GET",
      }),
      env: mockEnv,
      url: new URL("https://api.example.com/api/admin/users"),
      pathname: "/api/admin/users",
      method: "GET",
    };

    const next = vi.fn().mockResolvedValue(new Response("OK"));
    const response = await middleware(context, next);

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe("Service temporarily unavailable");
    expect(next).not.toHaveBeenCalled();
  });

  it("should return 503 when rate limiting fails on /api/auth routes", async () => {
    const middleware = rateLimitMiddleware();

    const brokenKV = {
      get: vi.fn().mockRejectedValue(new Error("KV unavailable")),
      put: vi.fn().mockRejectedValue(new Error("KV unavailable")),
    };

    const mockEnv = {
      FEED_CACHE_KV: brokenKV,
      SESSION_SECRET: "test-secret",
    } as any;

    const context = {
      request: new Request("https://api.example.com/api/auth/login", {
        method: "POST",
      }),
      env: mockEnv,
      url: new URL("https://api.example.com/api/auth/login"),
      pathname: "/api/auth/login",
      method: "POST",
    };

    const next = vi.fn().mockResolvedValue(new Response("OK"));
    const response = await middleware(context, next);

    expect(response.status).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("should fail-open (call next) when rate limiting fails on non-sensitive routes", async () => {
    const middleware = rateLimitMiddleware();

    const brokenKV = {
      get: vi.fn().mockRejectedValue(new Error("KV unavailable")),
      put: vi.fn().mockRejectedValue(new Error("KV unavailable")),
    };

    const mockEnv = {
      FEED_CACHE_KV: brokenKV,
      SESSION_SECRET: "test-secret",
    } as any;

    const context = {
      request: new Request("https://api.example.com/api/feed", {
        method: "GET",
      }),
      env: mockEnv,
      url: new URL("https://api.example.com/api/feed"),
      pathname: "/api/feed",
      method: "GET",
    };

    const okResponse = new Response("OK", { status: 200 });
    const next = vi.fn().mockResolvedValue(okResponse);
    const response = await middleware(context, next);

    expect(next).toHaveBeenCalled();
    expect(response.status).toBe(200);
  });
});

describe("S4.4: CSRF token rotation after 24 hours", () => {
  let CSRFProtection: any;
  let csrfTokenNeedsRotation: (
    session: unknown,
    now?: number,
  ) => boolean;

  beforeEach(async () => {
    vi.clearAllMocks();
    const csrf = await import("../../src/lib/csrf.js");
    CSRFProtection = csrf.CSRFProtection;
    csrfTokenNeedsRotation = csrf.csrfTokenNeedsRotation as typeof csrfTokenNeedsRotation;
  });

  it("should store csrfTokenCreatedAt when storing token in session", () => {
    const session = {
      userId: "user-123",
      email: "user@example.com",
      expiresAt: Date.now() + 3600000,
      dataRegion: "EU",
      profileContext: "primary" as const,
    };
    const token = "test-token";

    const now = Date.now();
    const updatedSession = CSRFProtection.storeTokenInSession(token, session);

    expect(updatedSession.csrfToken).toBe(token);
    expect(updatedSession.csrfTokenCreatedAt).toBeGreaterThanOrEqual(now);
    expect(updatedSession.csrfTokenCreatedAt).toBeLessThanOrEqual(Date.now());
    expect(updatedSession.csrfTokenNeedsRotation).toBe(false);
  });

  it("reports rotation needed when the token is older than 24 hours", async () => {
    const token = "valid-token";
    const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;

    const session = {
      userId: "user-123",
      email: "user@example.com",
      expiresAt: Date.now() + 3600000,
      csrfToken: token,
      csrfTokenCreatedAt: twentyFiveHoursAgo,
      dataRegion: "EU",
      profileContext: "primary" as const,
    };

    const isValid = await CSRFProtection.validateToken(token, session);

    expect(isValid).toBe(true);
    expect(csrfTokenNeedsRotation(session)).toBe(true);
  });

  it("reports no rotation needed when the token is less than 24 hours old", async () => {
    const token = "valid-token";
    const oneHourAgo = Date.now() - 60 * 60 * 1000;

    const session = {
      userId: "user-123",
      email: "user@example.com",
      expiresAt: Date.now() + 3600000,
      csrfToken: token,
      csrfTokenCreatedAt: oneHourAgo,
      dataRegion: "EU",
      profileContext: "primary" as const,
    };

    const isValid = await CSRFProtection.validateToken(token, session);

    expect(isValid).toBe(true);
    expect(csrfTokenNeedsRotation(session)).toBe(false);
  });

  it("never writes the rotation flag into the session it validates", async () => {
    // S5: within one request every component shares one Session object, and
    // the memoised one is frozen — a validity check that wrote to it would
    // throw. The rotation question is answered about the session, not
    // recorded in it.
    const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;

    const session: { csrfTokenNeedsRotation?: boolean } = Object.freeze({
      userId: "user-123",
      email: "user@example.com",
      expiresAt: Date.now() + 3600000,
      csrfToken: "correct-token",
      csrfTokenCreatedAt: twentyFiveHoursAgo,
      dataRegion: "EU",
      profileContext: "primary" as const,
    });

    expect(await CSRFProtection.validateToken("correct-token", session)).toBe(true);
    expect(await CSRFProtection.validateToken("wrong-token", session)).toBe(false);
    expect(session.csrfTokenNeedsRotation).toBeUndefined();
  });

  it("reports no rotation needed for a legacy session with no csrfTokenCreatedAt", async () => {
    const token = "valid-token";

    const session = {
      userId: "user-123",
      email: "user@example.com",
      expiresAt: Date.now() + 3600000,
      csrfToken: token,
      // No csrfTokenCreatedAt set (legacy sessions)
      dataRegion: "EU",
      profileContext: "primary" as const,
    };

    const isValid = await CSRFProtection.validateToken(token, session);

    expect(isValid).toBe(true);
    // Nothing to date, so nothing to rotate.
    expect(csrfTokenNeedsRotation(session)).toBe(false);
  });
});
