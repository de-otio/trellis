/**
 * Unit Tests: Upload Session Routes
 *
 * Tests for upload session management endpoints including creation,
 * adding media, completing, and abandoning sessions.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadSessionRoutes } from "../../../src/lib/routes/upload-sessions.js";
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
  },
}));

// Mock RateLimiter
const mockApplyRateLimitKV = vi.fn();
vi.mock("../../../src/lib/rate-limit", () => ({
  RateLimiter: class {
    applyRateLimitKV = mockApplyRateLimitKV;
  },
}));


// Mock CorsHandler
vi.mock("../../../src/lib/cors-handler", () => ({
  CorsHandler: {
    addCorsHeaders: vi.fn((response) => response),
  },
}));

// Mock UploadSessionHandler
const mockCreateSession = vi.fn();
const mockAddMediaToSession = vi.fn();
const mockCompleteSession = vi.fn();
const mockAbandonSession = vi.fn();
vi.mock("../../../src/lib/upload-session-handler", () => ({
  UploadSessionHandler: class {
    createSession = mockCreateSession;
    addMediaToSession = mockAddMediaToSession;
    completeSession = mockCompleteSession;
    abandonSession = mockAbandonSession;
  },
}));

// Mock RegionDetector (dynamically imported)
const mockDetectRegion = vi.fn();
vi.mock("../../../src/lib/region-detection", () => ({
  RegionDetector: class {
    detectRegion = mockDetectRegion;
  },
}));

// Mock PresignedUploadHandler (T14). Default: complete/abandon MISS with 404
// so the legacy dispatch falls through; individual tests override to exercise
// the presigned branch.
const mockPresignedCreate = vi.fn();
const mockPresignedComplete = vi.fn(async () => ({
  ok: false as const,
  status: 404,
  error: "Not found",
  message: "No such upload session.",
}));
const mockPresignedAbandon = vi.fn(async () => ({
  ok: false as const,
  status: 404,
  error: "Not found",
  message: "No such upload session.",
}));
vi.mock("../../../src/lib/presigned-upload-handler", () => ({
  PresignedUploadHandler: class {
    createSession = mockPresignedCreate;
    completeSession = mockPresignedComplete;
    abandonSession = mockPresignedAbandon;
  },
}));

describe("Upload Session Routes", () => {
  let mockEnv: any;
  let mockSession: Session;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSession = {
      userId: "user-123",
      email: "test@example.com",
      expiresAt: Date.now() + 3600000,
    } as Session;

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
      ENVIRONMENT: "dev",
    };

    mockGetSession.mockResolvedValue(mockSession);
    mockApplyRateLimitKV.mockResolvedValue(null);
    mockCreateSecureResponse.mockImplementation(
      (body, options) => new Response(body, options),
    );
    mockAddSecurityHeaders.mockImplementation((response) => response);
    mockDetectRegion.mockResolvedValue("EU");
  });

  describe("POST /api/upload-sessions - Create upload session", () => {
    const route = uploadSessionRoutes.find(
      (r) => r.method === "POST" && r.path === "/api/upload-sessions",
    );

    it("should exist as a route", () => {
      expect(route).toBeDefined();
    });

    it("should require authentication - return 401", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request("https://example.com/api/upload-sessions", {
        method: "POST",
      });

      await route!.handler(request, mockEnv, {
        url: new URL("https://example.com/api/upload-sessions"),
        pathname: "/api/upload-sessions",
        params: {},
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it("should create upload session and return 201", async () => {
      const sessionResult = {
        sessionId: "session-abc",
        expiresAt: "2026-03-02T00:00:00Z",
      };
      mockCreateSession.mockResolvedValue(sessionResult);

      const request = new Request("https://example.com/api/upload-sessions", {
        method: "POST",
      });

      const response = await route!.handler(request, mockEnv, {
        url: new URL("https://example.com/api/upload-sessions"),
        pathname: "/api/upload-sessions",
        params: {},
      });

      expect(mockCreateSession).toHaveBeenCalledWith(
        "user-123",
        "EU",
        mockEnv,
      );
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body).toEqual(sessionResult);
    });

    it("should apply rate limiting (10/hour)", async () => {
      const rateLimitResponse = new Response(
        JSON.stringify({ error: "Rate limit exceeded" }),
        { status: 429 },
      );
      mockApplyRateLimitKV.mockResolvedValue(rateLimitResponse);

      const request = new Request("https://example.com/api/upload-sessions", {
        method: "POST",
      });

      await route!.handler(request, mockEnv, {
        url: new URL("https://example.com/api/upload-sessions"),
        pathname: "/api/upload-sessions",
        params: {},
      });

      expect(mockApplyRateLimitKV).toHaveBeenCalledWith(
        mockEnv,
        request,
        "/api/upload-sessions",
        10,
        3600,
        "user-123",
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(rateLimitResponse);
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it("should detect region from request", async () => {
      mockDetectRegion.mockResolvedValue("US");
      mockCreateSession.mockResolvedValue({ sessionId: "session-abc" });

      const request = new Request("https://example.com/api/upload-sessions", {
        method: "POST",
      });

      await route!.handler(request, mockEnv, {
        url: new URL("https://example.com/api/upload-sessions"),
        pathname: "/api/upload-sessions",
        params: {},
      });

      expect(mockDetectRegion).toHaveBeenCalledWith(
        request,
        undefined,
        undefined,
      );
      expect(mockCreateSession).toHaveBeenCalledWith("user-123", "US", mockEnv);
    });

    it("should return 500 on handler error", async () => {
      mockCreateSession.mockRejectedValue(new Error("DB connection failed"));

      const request = new Request("https://example.com/api/upload-sessions", {
        method: "POST",
      });

      const response = await route!.handler(request, mockEnv, {
        url: new URL("https://example.com/api/upload-sessions"),
        pathname: "/api/upload-sessions",
        params: {},
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({ error: "Internal server error" });
          });
  });

  describe("POST /api/upload-sessions/:id/media - Add media to session", () => {
    const route = uploadSessionRoutes.find(
      (r) =>
        r.method === "POST" && r.path === "/api/upload-sessions/:id/media",
    );

    it("should exist as a route", () => {
      expect(route).toBeDefined();
    });

    it("should require authentication - return 401", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "https://example.com/api/upload-sessions/session-abc/media",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mediaId: "media-123" }),
        },
      );

      await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/upload-sessions/session-abc/media",
        ),
        pathname: "/api/upload-sessions/session-abc/media",
        params: { id: "session-abc" },
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockAddMediaToSession).not.toHaveBeenCalled();
    });

    it("should return 400 when session ID is missing", async () => {
      const request = new Request(
        "https://example.com/api/upload-sessions//media",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mediaId: "media-123" }),
        },
      );

      await route!.handler(request, mockEnv, {
        url: new URL("https://example.com/api/upload-sessions//media"),
        pathname: "/api/upload-sessions//media",
        params: {},
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Session ID is required" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });

    it("should return 400 for invalid JSON body", async () => {
      const request = new Request(
        "https://example.com/api/upload-sessions/session-abc/media",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not-json",
        },
      );

      await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/upload-sessions/session-abc/media",
        ),
        pathname: "/api/upload-sessions/session-abc/media",
        params: { id: "session-abc" },
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });

    it("should return 400 when mediaId is missing from body", async () => {
      const request = new Request(
        "https://example.com/api/upload-sessions/session-abc/media",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/upload-sessions/session-abc/media",
        ),
        pathname: "/api/upload-sessions/session-abc/media",
        params: { id: "session-abc" },
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "mediaId is required" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });

    it("should add media to session and return 200", async () => {
      mockAddMediaToSession.mockResolvedValue({
        success: true,
        mediaId: "media-123",
      });

      const request = new Request(
        "https://example.com/api/upload-sessions/session-abc/media",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mediaId: "media-123" }),
        },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/upload-sessions/session-abc/media",
        ),
        pathname: "/api/upload-sessions/session-abc/media",
        params: { id: "session-abc" },
      });

      expect(mockAddMediaToSession).toHaveBeenCalledWith(
        "session-abc",
        "user-123",
        "media-123",
        "EU",
        mockEnv,
      );
      expect(response.status).toBe(200);
    });

    it("should return 400 when handler returns success: false", async () => {
      mockAddMediaToSession.mockResolvedValue({
        success: false,
        error: "Session not found",
      });

      const request = new Request(
        "https://example.com/api/upload-sessions/session-abc/media",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mediaId: "media-123" }),
        },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/upload-sessions/session-abc/media",
        ),
        pathname: "/api/upload-sessions/session-abc/media",
        params: { id: "session-abc" },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toEqual({ error: "Session not found" });
    });

    it("should return 500 on handler error", async () => {
      mockAddMediaToSession.mockRejectedValue(new Error("Unexpected error"));

      const request = new Request(
        "https://example.com/api/upload-sessions/session-abc/media",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mediaId: "media-123" }),
        },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/upload-sessions/session-abc/media",
        ),
        pathname: "/api/upload-sessions/session-abc/media",
        params: { id: "session-abc" },
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({ error: "Internal server error" });
    });
  });

  describe("POST /api/upload-sessions/:id/complete - Complete upload session", () => {
    const route = uploadSessionRoutes.find(
      (r) =>
        r.method === "POST" && r.path === "/api/upload-sessions/:id/complete",
    );

    it("should exist as a route", () => {
      expect(route).toBeDefined();
    });

    it("should require authentication - return 401", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "https://example.com/api/upload-sessions/session-abc/complete",
        { method: "POST" },
      );

      await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/upload-sessions/session-abc/complete",
        ),
        pathname: "/api/upload-sessions/session-abc/complete",
        params: { id: "session-abc" },
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockCompleteSession).not.toHaveBeenCalled();
    });

    it("should return 400 when session ID is missing", async () => {
      const request = new Request(
        "https://example.com/api/upload-sessions//complete",
        { method: "POST" },
      );

      await route!.handler(request, mockEnv, {
        url: new URL("https://example.com/api/upload-sessions//complete"),
        pathname: "/api/upload-sessions//complete",
        params: {},
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Session ID is required" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });

    it("should complete session and return 200", async () => {
      mockCompleteSession.mockResolvedValue({
        success: true,
        mediaCount: 3,
      });

      const request = new Request(
        "https://example.com/api/upload-sessions/session-abc/complete",
        { method: "POST" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/upload-sessions/session-abc/complete",
        ),
        pathname: "/api/upload-sessions/session-abc/complete",
        params: { id: "session-abc" },
      });

      expect(mockCompleteSession).toHaveBeenCalledWith(
        "session-abc",
        "user-123",
        "EU",
        mockEnv,
      );
      expect(response.status).toBe(200);
    });

    it("should return 400 when handler returns success: false", async () => {
      mockCompleteSession.mockResolvedValue({
        success: false,
        error: "Session already completed",
      });

      const request = new Request(
        "https://example.com/api/upload-sessions/session-abc/complete",
        { method: "POST" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/upload-sessions/session-abc/complete",
        ),
        pathname: "/api/upload-sessions/session-abc/complete",
        params: { id: "session-abc" },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toEqual({ error: "Session already completed" });
    });

    it("should return 500 on handler error", async () => {
      mockCompleteSession.mockRejectedValue(new Error("DB timeout"));

      const request = new Request(
        "https://example.com/api/upload-sessions/session-abc/complete",
        { method: "POST" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/upload-sessions/session-abc/complete",
        ),
        pathname: "/api/upload-sessions/session-abc/complete",
        params: { id: "session-abc" },
      });

      expect(response.status).toBe(500);
          });
  });

  describe("POST /api/upload-sessions/:id/abandon - Abandon upload session", () => {
    const route = uploadSessionRoutes.find(
      (r) =>
        r.method === "POST" && r.path === "/api/upload-sessions/:id/abandon",
    );

    it("should exist as a route", () => {
      expect(route).toBeDefined();
    });

    it("should require authentication - return 401", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "https://example.com/api/upload-sessions/session-abc/abandon",
        { method: "POST" },
      );

      await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/upload-sessions/session-abc/abandon",
        ),
        pathname: "/api/upload-sessions/session-abc/abandon",
        params: { id: "session-abc" },
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockAbandonSession).not.toHaveBeenCalled();
    });

    it("should return 400 when session ID is missing", async () => {
      const request = new Request(
        "https://example.com/api/upload-sessions//abandon",
        { method: "POST" },
      );

      await route!.handler(request, mockEnv, {
        url: new URL("https://example.com/api/upload-sessions//abandon"),
        pathname: "/api/upload-sessions//abandon",
        params: {},
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Session ID is required" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });

    it("should abandon session and return 200", async () => {
      mockAbandonSession.mockResolvedValue({
        success: true,
        orphanedCount: 2,
      });

      const request = new Request(
        "https://example.com/api/upload-sessions/session-abc/abandon",
        { method: "POST" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/upload-sessions/session-abc/abandon",
        ),
        pathname: "/api/upload-sessions/session-abc/abandon",
        params: { id: "session-abc" },
      });

      expect(mockAbandonSession).toHaveBeenCalledWith(
        "session-abc",
        "user-123",
        "EU",
        mockEnv,
      );
      expect(response.status).toBe(200);
    });

    it("should return 400 when handler returns success: false", async () => {
      mockAbandonSession.mockResolvedValue({
        success: false,
        error: "Session not found",
      });

      const request = new Request(
        "https://example.com/api/upload-sessions/session-abc/abandon",
        { method: "POST" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/upload-sessions/session-abc/abandon",
        ),
        pathname: "/api/upload-sessions/session-abc/abandon",
        params: { id: "session-abc" },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toEqual({ error: "Session not found" });
    });

    it("should return 500 on handler error", async () => {
      mockAbandonSession.mockRejectedValue(new Error("Network failure"));

      const request = new Request(
        "https://example.com/api/upload-sessions/session-abc/abandon",
        { method: "POST" },
      );

      const response = await route!.handler(request, mockEnv, {
        url: new URL(
          "https://example.com/api/upload-sessions/session-abc/abandon",
        ),
        pathname: "/api/upload-sessions/session-abc/abandon",
        params: { id: "session-abc" },
      });

      expect(response.status).toBe(500);
          });
  });
});

// ---------------------------------------------------------------------------
// T14 — presigned direct-to-S3 dispatch on the shared endpoints
// ---------------------------------------------------------------------------

describe("Upload Session Routes — presigned dispatch (T14)", () => {
  let mockEnv: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
      ENVIRONMENT: "dev",
    };
    mockGetSession.mockResolvedValue({
      userId: "user-123",
      email: "test@example.com",
      expiresAt: Date.now() + 3600000,
    } as Session);
    mockApplyRateLimitKV.mockResolvedValue(null);
    mockCreateSecureResponse.mockImplementation(
      (body: any, options: any) => new Response(body, options),
    );
    mockAddSecurityHeaders.mockImplementation((r: any) => r);
    mockDetectRegion.mockResolvedValue("EU");
    mockPresignedComplete.mockResolvedValue({
      ok: false,
      status: 404,
      error: "Not found",
      message: "No such upload session.",
    });
    mockPresignedAbandon.mockResolvedValue({
      ok: false,
      status: 404,
      error: "Not found",
      message: "No such upload session.",
    });
  });

  const createRoute = uploadSessionRoutes.find(
    (r) => r.method === "POST" && r.path === "/api/upload-sessions",
  );
  const completeRoute = uploadSessionRoutes.find(
    (r) => r.method === "POST" && r.path === "/api/upload-sessions/:id/complete",
  );

  it("a JSON body with {mimeType, sizeBytes} selects the presigned flow (201 + grant)", async () => {
    const grant = {
      ok: true,
      session: {
        sessionId: "csession000000000000000a1",
        mediaId: "cmedia00000000000000000a1",
        status: "awaiting-upload",
        expiresAt: "2026-07-06T00:00:00.000Z",
      },
      upload: {
        method: "POST",
        url: "https://bucket.s3.amazonaws.com/",
        fields: { key: "pending/t/s", policy: "p", "x-amz-signature": "s" },
        objectKey: "pending/t/s",
        expiresInSeconds: 900,
      },
      constraints: { maxBytes: 200000000, maxDurationSeconds: 60 },
    };
    mockPresignedCreate.mockResolvedValue(grant);

    const request = new Request("https://example.com/api/upload-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mimeType: "video/mp4", sizeBytes: 5000000 }),
    });
    const response = await createRoute!.handler(request, mockEnv, {
      url: new URL("https://example.com/api/upload-sessions"),
      pathname: "/api/upload-sessions",
      params: {},
    });

    expect(mockPresignedCreate).toHaveBeenCalledWith("user-123", "EU", mockEnv, {
      mimeType: "video/mp4",
      sizeBytes: 5000000,
    });
    // The LEGACY handler is not touched on the presigned branch.
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.upload.fields).toHaveProperty("x-amz-signature");
  });

  it("a half-declared body (mimeType without sizeBytes) is a 400, never a silent legacy fallback", async () => {
    const request = new Request("https://example.com/api/upload-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mimeType: "video/mp4" }),
    });
    const response = await createRoute!.handler(request, mockEnv, {
      url: new URL("https://example.com/api/upload-sessions"),
      pathname: "/api/upload-sessions",
      params: {},
    });
    expect(response.status).toBe(400);
    expect(mockPresignedCreate).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("a presigned refusal maps to its status code (e.g. 413)", async () => {
    mockPresignedCreate.mockResolvedValue({
      ok: false,
      status: 413,
      error: "File too large",
      message: "The declared size exceeds the upload size limit.",
    });
    const request = new Request("https://example.com/api/upload-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mimeType: "video/mp4", sizeBytes: 999999999999 }),
    });
    const response = await createRoute!.handler(request, mockEnv, {
      url: new URL("https://example.com/api/upload-sessions"),
      pathname: "/api/upload-sessions",
      params: {},
    });
    expect(response.status).toBe(413);
  });

  it("complete dispatches presigned-first; a presigned hit short-circuits the legacy handler", async () => {
    mockPresignedComplete.mockResolvedValue({
      ok: true,
      session: {
        sessionId: "csession000000000000000a1",
        mediaId: "cmedia00000000000000000a1",
        status: "uploaded",
      },
      media: { id: "cmedia00000000000000000a1", lifecycle: "UPLOADED" },
    });
    const request = new Request(
      "https://example.com/api/upload-sessions/csession000000000000000a1/complete",
      { method: "POST" },
    );
    const response = await completeRoute!.handler(request, mockEnv, {
      url: new URL(
        "https://example.com/api/upload-sessions/csession000000000000000a1/complete",
      ),
      pathname: "/api/upload-sessions/csession000000000000000a1/complete",
      params: { id: "csession000000000000000a1" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.media.lifecycle).toBe("UPLOADED");
    expect(mockCompleteSession).not.toHaveBeenCalled();
  });

  it("complete falls through to the legacy handler on a presigned 404 miss", async () => {
    mockCompleteSession.mockResolvedValue({ success: true, mediaCount: 2 });
    const request = new Request(
      "https://example.com/api/upload-sessions/legacy-1/complete",
      { method: "POST" },
    );
    const response = await completeRoute!.handler(request, mockEnv, {
      url: new URL("https://example.com/api/upload-sessions/legacy-1/complete"),
      pathname: "/api/upload-sessions/legacy-1/complete",
      params: { id: "legacy-1" },
    });
    expect(mockPresignedComplete).toHaveBeenCalled();
    expect(mockCompleteSession).toHaveBeenCalledWith(
      "legacy-1",
      "user-123",
      "EU",
      mockEnv,
    );
    expect(response.status).toBe(200);
  });

  it("a presigned non-404 refusal (e.g. 409) is returned as-is — no legacy fallback", async () => {
    mockPresignedComplete.mockResolvedValue({
      ok: false,
      status: 409,
      error: "Upload not found",
      message: "No object at the granted key.",
    });
    const request = new Request(
      "https://example.com/api/upload-sessions/csession000000000000000a1/complete",
      { method: "POST" },
    );
    const response = await completeRoute!.handler(request, mockEnv, {
      url: new URL(
        "https://example.com/api/upload-sessions/csession000000000000000a1/complete",
      ),
      pathname: "/api/upload-sessions/csession000000000000000a1/complete",
      params: { id: "csession000000000000000a1" },
    });
    expect(response.status).toBe(409);
    expect(mockCompleteSession).not.toHaveBeenCalled();
  });
});
