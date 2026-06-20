/**
 * Unit tests: encrypted-settings routes (WS5). Exercises auth gating, namespace
 * resolution, the GET/PUT wiring, and the handler -> route status mapping with a
 * mocked Prisma + session. Covers routes/settings.ts and config.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";

const mockEncryptedUserSetting = {
  findUnique: vi.fn(),
  create: vi.fn(),
  updateMany: vi.fn(),
  findMany: vi.fn(),
};
const mockPrisma = { encryptedUserSetting: mockEncryptedUserSetting };

vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

const mockGetSession = vi.fn();
vi.mock("../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

const mockAuthMiddleware = vi.fn();
vi.mock("../../src/lib/auth/auth-middleware", () => ({
  authMiddleware: (...args: unknown[]) => mockAuthMiddleware(...args),
}));

vi.mock("../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse(body: BodyInit | null, init: ResponseInit) {
      return new Response(body, init);
    }
    addSecurityHeaders(response: Response) {
      return response;
    }
  },
}));

vi.mock("../../src/lib/middleware", () => ({
  corsMiddleware: vi.fn(() => ({ name: "cors" })),
  csrfMiddleware: vi.fn(() => ({ name: "csrf" })),
  rateLimitMiddleware: vi.fn(() => ({ name: "rateLimit" })),
}));

import { settingsRoutes } from "../../src/lib/routes/settings.js";

const NOW = new Date("2026-06-20T00:00:00.000Z");

function ctx(pathname: string) {
  return {
    url: new URL(`https://api.example.com${pathname}`),
    pathname,
    params: {},
  } as any;
}

const CHANGES_RE = /\\\/changes\$/;
function getRoute() {
  // The per-namespace GET (NOT the /changes cursor route).
  return settingsRoutes.find(
    (r) => r.method === "GET" && !CHANGES_RE.test(String(r.path)),
  )!;
}
function putRoute() {
  return settingsRoutes.find((r) => r.method === "PUT")!;
}
function changesRoute() {
  return settingsRoutes.find(
    (r) => r.method === "GET" && CHANGES_RE.test(String(r.path)),
  )!;
}

describe("settings routes", () => {
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    env = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      SESSION_SECRET: "test-secret-32-characters-long!!",
      REALTIME_SETTING_NAMESPACES: ["feed_filters"],
      REALTIME_SETTING_MAX_BYTES: 64,
      realtimeTransport: { kind: "poll", deliver: vi.fn(), getSetting: vi.fn(), putSetting: vi.fn() },
    } as unknown as Env;
  });

  it("registers three routes (changes-GET + namespace-GET + PUT)", () => {
    expect(settingsRoutes).toHaveLength(3);
    expect(settingsRoutes.map((r) => r.method).sort()).toEqual([
      "GET",
      "GET",
      "PUT",
    ]);
  });

  it("registers the /changes cursor route BEFORE the :namespace capture", () => {
    const changesIdx = settingsRoutes.findIndex((r) =>
      CHANGES_RE.test(String(r.path)),
    );
    const namespaceIdx = settingsRoutes.findIndex(
      (r) => r.method === "GET" && !CHANGES_RE.test(String(r.path)),
    );
    expect(changesIdx).toBeGreaterThanOrEqual(0);
    expect(changesIdx).toBeLessThan(namespaceIdx);
  });

  describe("GET", () => {
    it("401 when unauthenticated", async () => {
      mockGetSession.mockResolvedValue(null);
      const res = await getRoute().handler(
        new Request("https://api.example.com/api/settings/feed_filters"),
        env as any,
        ctx("/api/settings/feed_filters"),
      );
      expect(res.status).toBe(401);
    });

    it("404 for an unknown namespace", async () => {
      mockGetSession.mockResolvedValue({ userId: "u1", expiresAt: Date.now() + 1e6 });
      const res = await getRoute().handler(
        new Request("https://api.example.com/api/settings/unknown_ns"),
        env as any,
        ctx("/api/settings/unknown_ns"),
      );
      expect(res.status).toBe(404);
    });

    it("404 when no blob exists", async () => {
      mockGetSession.mockResolvedValue({ userId: "u1", expiresAt: Date.now() + 1e6 });
      mockEncryptedUserSetting.findUnique.mockResolvedValue(null);
      const res = await getRoute().handler(
        new Request("https://api.example.com/api/settings/feed_filters"),
        env as any,
        ctx("/api/settings/feed_filters"),
      );
      expect(res.status).toBe(404);
    });

    it("200 with the blob and ETag", async () => {
      mockGetSession.mockResolvedValue({ userId: "u1", expiresAt: Date.now() + 1e6 });
      mockEncryptedUserSetting.findUnique.mockResolvedValue({
        ciphertext: "CT",
        version: 2,
        updatedAt: NOW,
      });
      const res = await getRoute().handler(
        new Request("https://api.example.com/api/settings/feed_filters"),
        env as any,
        ctx("/api/settings/feed_filters"),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBe("2");
      expect((await res.json()).ciphertext).toBe("CT");
    });

    it("304 when If-None-Match matches", async () => {
      mockGetSession.mockResolvedValue({ userId: "u1", expiresAt: Date.now() + 1e6 });
      mockEncryptedUserSetting.findUnique.mockResolvedValue({
        ciphertext: "CT",
        version: 2,
        updatedAt: NOW,
      });
      const res = await getRoute().handler(
        new Request("https://api.example.com/api/settings/feed_filters", {
          headers: { "if-none-match": "2" },
        }),
        env as any,
        ctx("/api/settings/feed_filters"),
      );
      expect(res.status).toBe(304);
    });
  });

  describe("PUT", () => {
    beforeEach(() => {
      mockGetSession.mockResolvedValue({ userId: "u1", expiresAt: Date.now() + 1e6 });
      mockAuthMiddleware.mockResolvedValue({ userId: "u1", activeTenantId: "t1" });
    });

    it("401 when unauthenticated session", async () => {
      mockGetSession.mockResolvedValue(null);
      const res = await putRoute().handler(
        new Request("https://api.example.com/api/settings/feed_filters", {
          method: "PUT",
          body: JSON.stringify({ ciphertext: "X", expectVersion: 0 }),
        }),
        env as any,
        ctx("/api/settings/feed_filters"),
      );
      expect(res.status).toBe(401);
    });

    it("401 when auth middleware yields no active tenant", async () => {
      mockAuthMiddleware.mockResolvedValue(null);
      const res = await putRoute().handler(
        new Request("https://api.example.com/api/settings/feed_filters", {
          method: "PUT",
          body: JSON.stringify({ ciphertext: "X", expectVersion: 0 }),
        }),
        env as any,
        ctx("/api/settings/feed_filters"),
      );
      expect(res.status).toBe(401);
    });

    it("400 on invalid JSON", async () => {
      const res = await putRoute().handler(
        new Request("https://api.example.com/api/settings/feed_filters", {
          method: "PUT",
          body: "{not json",
        }),
        env as any,
        ctx("/api/settings/feed_filters"),
      );
      expect(res.status).toBe(400);
    });

    it("404 for an unknown namespace", async () => {
      const res = await putRoute().handler(
        new Request("https://api.example.com/api/settings/unknown_ns", {
          method: "PUT",
          body: JSON.stringify({ ciphertext: "X", expectVersion: 0 }),
        }),
        env as any,
        ctx("/api/settings/unknown_ns"),
      );
      expect(res.status).toBe(404);
    });

    it("413 when the ciphertext exceeds the configured cap", async () => {
      const res = await putRoute().handler(
        new Request("https://api.example.com/api/settings/feed_filters", {
          method: "PUT",
          body: JSON.stringify({ ciphertext: "x".repeat(65), expectVersion: 0 }),
        }),
        env as any,
        ctx("/api/settings/feed_filters"),
      );
      expect(res.status).toBe(413);
      expect(mockEncryptedUserSetting.create).not.toHaveBeenCalled();
    });

    it("200 on a successful first write (version 1)", async () => {
      mockEncryptedUserSetting.create.mockResolvedValue({
        ciphertext: "CT",
        version: 1,
        updatedAt: NOW,
      });
      const res = await putRoute().handler(
        new Request("https://api.example.com/api/settings/feed_filters", {
          method: "PUT",
          body: JSON.stringify({ ciphertext: "CT", expectVersion: 0 }),
        }),
        env as any,
        ctx("/api/settings/feed_filters"),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).version).toBe(1);
    });

    it("409 on a version conflict", async () => {
      mockEncryptedUserSetting.updateMany.mockResolvedValue({ count: 0 });
      mockEncryptedUserSetting.findUnique.mockResolvedValue({
        ciphertext: "SERVER",
        version: 5,
        updatedAt: NOW,
      });
      const res = await putRoute().handler(
        new Request("https://api.example.com/api/settings/feed_filters", {
          method: "PUT",
          body: JSON.stringify({ ciphertext: "STALE", expectVersion: 3 }),
        }),
        env as any,
        ctx("/api/settings/feed_filters"),
      );
      expect(res.status).toBe(409);
      expect((await res.json()).current.version).toBe(5);
    });

    it("500 on an unexpected store error", async () => {
      mockEncryptedUserSetting.create.mockRejectedValue(new Error("db down"));
      const res = await putRoute().handler(
        new Request("https://api.example.com/api/settings/feed_filters", {
          method: "PUT",
          body: JSON.stringify({ ciphertext: "CT", expectVersion: 0 }),
        }),
        env as any,
        ctx("/api/settings/feed_filters"),
      );
      expect(res.status).toBe(500);
    });
  });

  describe("GET /api/settings/changes (Track C cursor)", () => {
    it("401 when unauthenticated", async () => {
      mockGetSession.mockResolvedValue(null);
      const res = await changesRoute().handler(
        new Request("https://api.example.com/api/settings/changes?since=0"),
        env as any,
        ctx("/api/settings/changes?since=0"),
      );
      expect(res.status).toBe(401);
    });

    it("200 with metadata-only changes (no ciphertext) for the session user", async () => {
      mockGetSession.mockResolvedValue({ userId: "u1", expiresAt: Date.now() + 1e6 });
      mockEncryptedUserSetting.findMany.mockResolvedValue([
        { namespace: "feed_filters", version: 4, updatedAt: NOW },
      ]);
      const res = await changesRoute().handler(
        new Request("https://api.example.com/api/settings/changes?since=2"),
        env as any,
        ctx("/api/settings/changes?since=2"),
      );
      expect(res.status).toBe(200);

      // Query is user-scoped with a strict version predicate; ciphertext NOT selected.
      expect(mockEncryptedUserSetting.findMany).toHaveBeenCalledWith({
        where: { userId: "u1", version: { gt: 2 } },
        select: { namespace: true, version: true, updatedAt: true },
        orderBy: { version: "asc" },
      });

      const raw = await res.text();
      expect(raw).not.toContain("ciphertext");
      const body = JSON.parse(raw);
      expect(body.cursor).toBe(4);
      expect(body.changes).toEqual([
        { namespace: "feed_filters", version: 4, updatedAt: NOW.toISOString() },
      ]);
    });

    it("treats a missing/invalid ?since as 0 (full backfill)", async () => {
      mockGetSession.mockResolvedValue({ userId: "u1", expiresAt: Date.now() + 1e6 });
      mockEncryptedUserSetting.findMany.mockResolvedValue([]);
      await changesRoute().handler(
        new Request("https://api.example.com/api/settings/changes?since=notanumber"),
        env as any,
        ctx("/api/settings/changes?since=notanumber"),
      );
      expect(mockEncryptedUserSetting.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "u1", version: { gt: 0 } } }),
      );
    });

    it("500 on an unexpected store error", async () => {
      mockGetSession.mockResolvedValue({ userId: "u1", expiresAt: Date.now() + 1e6 });
      mockEncryptedUserSetting.findMany.mockRejectedValue(new Error("db down"));
      const res = await changesRoute().handler(
        new Request("https://api.example.com/api/settings/changes"),
        env as any,
        ctx("/api/settings/changes"),
      );
      expect(res.status).toBe(500);
    });
  });
});
