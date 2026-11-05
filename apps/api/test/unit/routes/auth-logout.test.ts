/**
 * M9 — POST /auth/logout (+ /api/auth/logout alias).
 *
 * The revocation semantics themselves (blocklist read by BOTH auth paths) are
 * covered end-to-end in `auth/auth-middleware-revocation.test.ts` and
 * `session-revocation.test.ts`. These tests pin the ROUTE's contract: who may
 * write to the blocklist, what a failure looks like, and that the specific
 * route is not shadowed by the `/auth/*` wildcard.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { authRoutes } from "../../../src/lib/routes/auth.js";

const mockGetSession = vi.fn();
const mockRevokeSession = vi.fn();
const mockClearSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
    revokeSession = mockRevokeSession;
    clearSession = mockClearSession;
  },
}));

vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = (body: BodyInit | null, init?: ResponseInit) =>
      new Response(body, init);
    addSecurityHeaders = (r: Response) => r;
  },
}));

// The wildcard handler imports the worker; keep it inert.
vi.mock("../../../src/worker", () => ({
  handleAuthRoutes: vi.fn(),
  addCorsHeaders: (r: Response) => r,
}));

const kvEnv = () =>
  ({
    SESSION_SECRET: "s",
    SESSION_BLOCKLIST_KV: { get: vi.fn(), put: vi.fn() },
  }) as any;

const logoutRoutes = authRoutes.filter(
  (r) => typeof r.path === "string" && r.path.endsWith("/logout"),
);
const route = logoutRoutes.find((r) => r.path === "/auth/logout")!;

const post = (headers: Record<string, string> = {}) =>
  new Request("https://api.example.com/auth/logout", {
    method: "POST",
    headers,
  });

describe("POST /auth/logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClearSession.mockImplementation((r: Response) => {
      r.headers.set("x-cleared", "1");
      return r;
    });
    mockRevokeSession.mockResolvedValue(undefined);
  });

  it("is registered for both /auth/logout and /api/auth/logout, POST only, with CORS + CSRF", () => {
    expect(logoutRoutes.map((r) => r.path).sort()).toEqual([
      "/api/auth/logout",
      "/auth/logout",
    ]);
    for (const r of logoutRoutes) {
      expect(r.method).toBe("POST");
      expect(r.middleware).toHaveLength(2); // corsMiddleware + csrfMiddleware
    }
  });

  it("is registered BEFORE the /auth/* wildcards so it is not shadowed", () => {
    const idx = (p: string) => authRoutes.findIndex((r) => r.path === p);
    expect(idx("/auth/logout")).toBeGreaterThanOrEqual(0);
    expect(idx("/auth/logout")).toBeLessThan(idx("/auth/*"));
    expect(idx("/api/auth/logout")).toBeLessThan(idx("/api/auth/*"));
  });

  it("valid session: revokes the presented token, clears the cookie, 204", async () => {
    mockGetSession.mockResolvedValue({ userId: "u1" });
    const request = post({ Authorization: "Bearer tok" });
    const env = kvEnv();

    const res = await route.handler(request, env, {} as any);

    expect(res.status).toBe(204);
    expect(mockRevokeSession).toHaveBeenCalledWith(request, env);
    expect(res.headers.get("x-cleared")).toBe("1");
  });

  it("NO valid session: 204, cookie cleared, and NOTHING is written to the blocklist", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await route.handler(post(), kvEnv(), {} as any);

    expect(res.status).toBe(204);
    expect(mockRevokeSession).not.toHaveBeenCalled();
    expect(res.headers.get("x-cleared")).toBe("1");
  });

  it("a revocation write failure is a 500, not a silent success (cookie still cleared)", async () => {
    mockGetSession.mockResolvedValue({ userId: "u1" });
    mockRevokeSession.mockRejectedValue(new Error("KV unreachable"));

    const res = await route.handler(post(), kvEnv(), {} as any);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "logout_failed" });
    expect(res.headers.get("x-cleared")).toBe("1");
  });

  it("no KV bound + SESSION_BLOCKLIST_REQUIRED=true: 503 and no pretend-logout", async () => {
    mockGetSession.mockResolvedValue({ userId: "u1" });

    const res = await route.handler(
      post(),
      { SESSION_SECRET: "s", SESSION_BLOCKLIST_REQUIRED: "true" } as any,
      {} as any,
    );

    expect(res.status).toBe(503);
    expect(mockRevokeSession).not.toHaveBeenCalled();
  });

  it("no KV bound, not required: still 204 (cookie cleared; deployment shape)", async () => {
    mockGetSession.mockResolvedValue({ userId: "u1" });

    const res = await route.handler(
      post(),
      { SESSION_SECRET: "s" } as any,
      {} as any,
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("x-cleared")).toBe("1");
  });

  it("the /api/auth alias behaves identically", async () => {
    mockGetSession.mockResolvedValue({ userId: "u1" });
    const alias = logoutRoutes.find((r) => r.path === "/api/auth/logout")!;

    const res = await alias.handler(post(), kvEnv(), {} as any);

    expect(res.status).toBe(204);
    expect(mockRevokeSession).toHaveBeenCalledTimes(1);
  });
});
