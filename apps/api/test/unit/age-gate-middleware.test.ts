/**
 * Unit Tests: Age Gate Middleware
 *
 * Tests that the age gate middleware correctly injects featureAccess
 * into the request context based on the session's ageTier.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ageGateMiddleware } from "../../src/lib/age-gate-middleware.js";
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

  it("should inject CHILD featureAccess for authenticated CHILD user", async () => {
    const requestContext: Partial<TrellisRequestContext> = {
      region: "US" as any,
      config: {} as any,
      session: {
        userId: "child-1",
        email: "child@example.com",
        expiresAt: Date.now() + 3600000,
        dataRegion: "US",
        profileContext: "primary",
        ageTier: "CHILD",
      },
    };

    const context = createContext(requestContext);
    const response = await middleware(context, mockNext);

    expect(mockNext).toHaveBeenCalledOnce();
    expect(response).toBe(mockResponse);
    expect(context.requestContext?.featureAccess).toBeDefined();
    expect(context.requestContext?.featureAccess?.maxFeedPages).toBe(5);
    expect(context.requestContext?.featureAccess?.dmAccess).toBe("nobody");
    expect(context.requestContext?.featureAccess?.sentimentDisplay).toBe(
      "hidden",
    );
  });

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
