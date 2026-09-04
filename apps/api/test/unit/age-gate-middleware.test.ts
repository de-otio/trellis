/**
 * Unit Tests: Age Gate Middleware
 *
 * The middleware's job is now a quarantine guarantee, so that is what these
 * tests assert: whatever tier a session carries, the injected `featureAccess`
 * is the ADULT one. Minor accounts are not a supported account type (see
 * `src/lib/age-gate.ts`, MINOR_TIERS_SUPPORTED).
 *
 * The old suite asserted the opposite — that a CHILD session got CHILD caps —
 * and passed, while in production no token path ever populated `ageTier` and
 * the CHILD branch never ran for anyone. A test that green-lights a code path
 * nothing reaches is worse than no test: it reports the feature as working.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ageGateMiddleware } from "../../src/lib/age-gate-middleware.js";
import { getFeatureAccess } from "../../src/lib/age-gate.js";
import type { MiddlewareContext } from "../../src/lib/middleware.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";

describe("ageGateMiddleware", () => {
  let middleware: ReturnType<typeof ageGateMiddleware>;
  let mockNext: ReturnType<typeof vi.fn>;
  let mockResponse: Response;

  beforeEach(() => {
    vi.clearAllMocks();
    middleware = ageGateMiddleware();
    mockResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    mockNext = vi.fn().mockResolvedValue(mockResponse);
  });

  function createContext(
    requestContext?: Partial<TrellisRequestContext>,
  ): MiddlewareContext {
    return {
      request: new Request("https://api.example.com/api/feed"),
      env: {} as any,
      requestContext: requestContext as TrellisRequestContext | undefined,
      url: new URL("https://api.example.com/api/feed"),
      pathname: "/api/feed",
      method: "GET",
    };
  }

  // The quarantine assertion. A session that explicitly claims a minor tier
  // must still be served ADULT access — the resolution ignores the claim
  // rather than merely never seeing it.
  it.each(["CHILD", "TEEN"] as const)(
    "resolves a %s session to ADULT featureAccess (minor tiers quarantined)",
    async (claimedTier) => {
      const requestContext: Partial<TrellisRequestContext> = {
        region: "US" as any,
        config: {} as any,
        session: {
          userId: "minor-1",
          email: "minor@example.com",
          expiresAt: Date.now() + 3600000,
          dataRegion: "US",
          profileContext: "primary",
          ageTier: claimedTier,
        },
      };

      const context = createContext(requestContext);
      const response = await middleware(context, mockNext);

      expect(mockNext).toHaveBeenCalledOnce();
      expect(response).toBe(mockResponse);

      const access = context.requestContext?.featureAccess;
      expect(access).toBeDefined();
      // Byte-for-byte the ADULT table — no cap, no redaction, no lock.
      expect(access).toEqual(getFeatureAccess("ADULT"));
      // Spelled out too, so a change to the ADULT table cannot quietly make
      // the equality above pass against a restricted config.
      expect(access?.maxFeedPages).toBeNull();
      expect(access?.dmAccess).toBe("connections");
      expect(access?.sentimentDisplay).toBe("full");
      expect(access?.showUnreadCount).toBe(true);
      expect(access?.canEditNotificationPreferences).toBe(true);
    },
  );

  it("should inject ADULT featureAccess for authenticated ADULT user", async () => {
    const requestContext: Partial<TrellisRequestContext> = {
      region: "US" as any,
      config: {} as any,
      session: {
        userId: "adult-1",
        email: "adult@example.com",
        expiresAt: Date.now() + 3600000,
        dataRegion: "US",
        profileContext: "primary",
        ageTier: "ADULT",
      },
    };

    const context = createContext(requestContext);
    await middleware(context, mockNext);

    expect(context.requestContext?.featureAccess).toBeDefined();
    expect(context.requestContext?.featureAccess?.maxFeedPages).toBeNull();
    expect(context.requestContext?.featureAccess?.dmAccess).toBe("connections");
    expect(context.requestContext?.featureAccess?.sentimentDisplay).toBe("full");
  });

  it("should not set featureAccess when there is no session (unauthenticated)", async () => {
    const requestContext: Partial<TrellisRequestContext> = {
      region: "US" as any,
      config: {} as any,
      session: null,
    };

    const context = createContext(requestContext);
    const response = await middleware(context, mockNext);

    expect(mockNext).toHaveBeenCalledOnce();
    expect(response).toBe(mockResponse);
    expect(context.requestContext?.featureAccess).toBeUndefined();
  });

  it("should default to ADULT when session has no ageTier", async () => {
    const requestContext: Partial<TrellisRequestContext> = {
      region: "US" as any,
      config: {} as any,
      session: {
        userId: "user-1",
        email: "user@example.com",
        expiresAt: Date.now() + 3600000,
        dataRegion: "US",
        profileContext: "primary",
        // ageTier intentionally omitted
      },
    };

    const context = createContext(requestContext);
    await middleware(context, mockNext);

    expect(context.requestContext?.featureAccess).toBeDefined();
    expect(context.requestContext?.featureAccess?.maxFeedPages).toBeNull();
    expect(context.requestContext?.featureAccess?.sentimentDisplay).toBe("full");
    expect(context.requestContext?.featureAccess?.canViewSentimentUsers).toBe(
      true,
    );
  });

  it("should call next() and return its response", async () => {
    const customResponse = new Response("custom", { status: 201 });
    mockNext.mockResolvedValue(customResponse);

    const context = createContext({
      region: "US" as any,
      config: {} as any,
      session: {
        userId: "user-1",
        email: "user@example.com",
        expiresAt: Date.now() + 3600000,
        dataRegion: "US",
        profileContext: "primary",
        ageTier: "TEEN",
      },
    });

    const response = await middleware(context, mockNext);

    expect(mockNext).toHaveBeenCalledOnce();
    expect(response).toBe(customResponse);
    expect(response.status).toBe(201);
  });
});
