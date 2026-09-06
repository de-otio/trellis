/**
 * Unit tests: routes/email-subscriptions.ts — the route WIRING layer.
 *
 * `EmailSubscriptionHandler` itself has its own suite
 * (test/unit/email-subscription-handler.test.ts); this file pins that each
 * route dispatches to the correct handler method, that every route is gated
 * by the `email_subscriptions_enabled` feature toggle, and — the one branch
 * that lives in routes.ts itself rather than the handler — that the owner
 * summary route enforces its OWN 401 session gate before ever calling the
 * handler.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

const mockHandleSubscribe = vi.fn();
const mockHandleConfirmPage = vi.fn();
const mockHandleConfirm = vi.fn();
const mockHandleUnsubscribePage = vi.fn();
const mockHandleUnsubscribe = vi.fn();
const mockHandleOwnerSummary = vi.fn();
vi.mock("../../../src/lib/email-subscription-handler", () => ({
  EmailSubscriptionHandler: class {
    handleSubscribe = mockHandleSubscribe;
    handleConfirmPage = mockHandleConfirmPage;
    handleConfirm = mockHandleConfirm;
    handleUnsubscribePage = mockHandleUnsubscribePage;
    handleUnsubscribe = mockHandleUnsubscribe;
    handleOwnerSummary = mockHandleOwnerSummary;
  },
}));

vi.mock("../../../src/lib/feature-gate-middleware", () => ({
  featureToggleMiddleware: vi.fn((key: string) => ({ name: "feature-toggle", key })),
}));

vi.mock("../../../src/lib/middleware", () => ({
  corsMiddleware: vi.fn(() => ({ name: "cors" })),
}));

vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    addSecurityHeaders(response: Response) {
      return response;
    }
    createSecureResponse(body: BodyInit | null, init: ResponseInit) {
      return new Response(body, init);
    }
  },
}));

import { emailSubscriptionRoutes } from "../../../src/lib/routes/email-subscriptions.js";

const env = { SESSION_SECRET: "test-secret-32-characters-long!!" } as any;

function routeFor(method: string, path: string) {
  const r = emailSubscriptionRoutes.find((rt) => rt.method === method && rt.path === path);
  if (!r) throw new Error(`no route for ${method} ${path}`);
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("route registration", () => {
  it("registers all six subscription routes, each gated by the feature toggle", () => {
    expect(emailSubscriptionRoutes).toHaveLength(6);
    for (const r of emailSubscriptionRoutes) {
      const featureMw = r.middleware?.find((m: any) => m.name === "feature-toggle");
      expect(featureMw).toMatchObject({ key: "email_subscriptions_enabled" });
    }
  });
});

describe("POST /api/subscriptions/email", () => {
  it("dispatches to handleSubscribe and wraps the response with security headers", async () => {
    const inner = new Response("ok", { status: 200 });
    mockHandleSubscribe.mockResolvedValue(inner);
    const route = routeFor("POST", "/api/subscriptions/email");
    const res = await route.handler(
      new Request("https://api.example.com/api/subscriptions/email", { method: "POST" }),
      env,
      {} as any,
    );
    expect(mockHandleSubscribe).toHaveBeenCalledWith(expect.any(Request), env);
    expect(res).toBe(inner);
  });
});

describe("GET/POST /api/subscriptions/email/confirm", () => {
  it("GET renders the inert confirm page (handleConfirmPage, synchronous)", async () => {
    const inner = new Response("page");
    mockHandleConfirmPage.mockReturnValue(inner);
    const route = routeFor("GET", "/api/subscriptions/email/confirm");
    const res = await route.handler(
      new Request("https://api.example.com/api/subscriptions/email/confirm"),
      env,
      {} as any,
    );
    expect(mockHandleConfirmPage).toHaveBeenCalled();
    expect(res).toBe(inner);
  });

  it("POST completes the confirmation via handleConfirm", async () => {
    const inner = new Response("confirmed");
    mockHandleConfirm.mockResolvedValue(inner);
    const route = routeFor("POST", "/api/subscriptions/email/confirm");
    const res = await route.handler(
      new Request("https://api.example.com/api/subscriptions/email/confirm", { method: "POST" }),
      env,
      {} as any,
    );
    expect(mockHandleConfirm).toHaveBeenCalledWith(expect.any(Request), env);
    expect(res).toBe(inner);
  });
});

describe("GET/POST /api/subscriptions/email/unsubscribe", () => {
  it("GET renders the inert unsubscribe page", async () => {
    const inner = new Response("page");
    mockHandleUnsubscribePage.mockReturnValue(inner);
    const route = routeFor("GET", "/api/subscriptions/email/unsubscribe");
    const res = await route.handler(
      new Request("https://api.example.com/api/subscriptions/email/unsubscribe"),
      env,
      {} as any,
    );
    expect(mockHandleUnsubscribePage).toHaveBeenCalled();
    expect(res).toBe(inner);
  });

  it("POST completes the unsubscribe (RFC 8058 one-click) via handleUnsubscribe", async () => {
    const inner = new Response("unsubscribed");
    mockHandleUnsubscribe.mockResolvedValue(inner);
    const route = routeFor("POST", "/api/subscriptions/email/unsubscribe");
    const res = await route.handler(
      new Request("https://api.example.com/api/subscriptions/email/unsubscribe", {
        method: "POST",
      }),
      env,
      {} as any,
    );
    expect(mockHandleUnsubscribe).toHaveBeenCalledWith(expect.any(Request), env);
    expect(res).toBe(inner);
  });
});

describe("GET /api/entities/:id/subscribers/summary — the ONE authenticated route", () => {
  const route = routeFor("GET", "/api/entities/:id/subscribers/summary");

  it("401 when there is no session — handler is never reached", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await route.handler(
      new Request("https://api.example.com/api/entities/e1/subscribers/summary"),
      env,
      { params: { id: "e1" } } as any,
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
    expect(mockHandleOwnerSummary).not.toHaveBeenCalled();
  });

  it("200 delegates to handleOwnerSummary with the entity id and session, when authenticated", async () => {
    const session = { userId: "owner1" };
    mockGetSession.mockResolvedValue(session);
    const inner = new Response(JSON.stringify({ count: 3 }));
    mockHandleOwnerSummary.mockResolvedValue(inner);
    const res = await route.handler(
      new Request("https://api.example.com/api/entities/e1/subscribers/summary"),
      env,
      { params: { id: "e1" } } as any,
    );
    expect(mockHandleOwnerSummary).toHaveBeenCalledWith("e1", session, env);
    expect(res).toBe(inner);
  });
});
