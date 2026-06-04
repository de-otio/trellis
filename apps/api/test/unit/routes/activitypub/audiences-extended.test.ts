/**
 * Extended Unit Tests: ActivityPub Audiences Routes
 *
 * Tests for untested paths in ActivityPub custom audience route handlers:
 * - POST /api/audiences: creator not found, suspended creator, "not found" error messages
 * - GET /audiences/:audienceId: full handler coverage
 * - POST /api/audiences/:audienceId/members: add member handler
 * - DELETE /api/audiences/:audienceId/members/:memberId: remove member handler
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../../src/env.js";
import { audienceRoutes } from "../../../../src/lib/routes/activitypub/audiences.js";

// Mock SessionManager
const mockGetSession = vi.fn();
vi.mock("../../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

// Mock SecurityHeaders
const mockCreateSecureResponse = vi.fn();
vi.mock("../../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    constructor(env: any) {}
  },
}));

// Mock addCorsHeaders
const mockAddCorsHeaders = vi.fn();
vi.mock("../../../../src/worker", () => ({
  addCorsHeaders: (...args: any[]) => mockAddCorsHeaders(...args),
}));


// Mock withQueryTimeoutAndRetry
const mockWithQueryTimeoutAndRetry = vi.fn();
vi.mock("../../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: (...args: any[]) =>
    mockWithQueryTimeoutAndRetry(...args),
  QueryTimeoutPresets: {
    STANDARD: { timeoutMs: 3000, retryTimeoutMs: 2000 },
  },
}));

// Mock detectRegionSync
const mockDetectRegionSync = vi.fn();
vi.mock("../../../../src/lib/region-detection", () => ({
  detectRegionSync: (...args: any[]) => mockDetectRegionSync(...args),
}));

// Mock sharedDatabaseConnectionManager
vi.mock("../../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {
    getConnection: vi.fn(),
  },
}));

// Mock CustomAudienceService
const mockCreateAudience = vi.fn();
const mockCreateOrderedCollection = vi.fn();
const mockAddMember = vi.fn();
const mockRemoveMember = vi.fn();
vi.mock("../../../../src/lib/activitypub/audience-service", () => ({
  CustomAudienceService: {
    createAudience: (...args: any[]) => mockCreateAudience(...args),
    createOrderedCollection: (...args: any[]) =>
      mockCreateOrderedCollection(...args),
    addMember: (...args: any[]) => mockAddMember(...args),
    removeMember: (...args: any[]) => mockRemoveMember(...args),
  },
}));

// Mock getFedifyContext
const mockGetFedifyContext = vi.fn();
vi.mock("../../../../src/lib/activitypub/fedify/context", () => ({
  getFedifyContext: (...args: any[]) => mockGetFedifyContext(...args),
}));

// Mock respondWithObject
const mockRespondWithObject = vi.fn();
vi.mock("@fedify/fedify", () => ({
  respondWithObject: (...args: any[]) => mockRespondWithObject(...args),
}));

// Mock middleware
vi.mock("../../../../src/lib/middleware", () => ({
  corsMiddleware: () => vi.fn(),
  csrfMiddleware: () => vi.fn(),
}));

describe("ActivityPub Audiences Routes - Extended", () => {
  let mockEnv: Env;
  let mockSession: any;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockSession = {
      userId: "user-123",
      email: "user@example.com",
    };

    mockDb = {
      user: {
        findUnique: vi.fn(),
      },
      customAudience: {
        findUnique: vi.fn(),
      },
    };

    mockGetSession.mockResolvedValue(mockSession);
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddCorsHeaders.mockImplementation(async (response) => response);
    mockDetectRegionSync.mockReturnValue("US");
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (_db: any, _region: any, _env: any, fn: any) => {
        return await fn(mockDb);
      },
    );
  });

  // ---- POST /api/audiences: untested paths ----

  describe("POST /api/audiences - Extended paths", () => {
    const getRoute = () =>
      audienceRoutes.find(
        (r) => r.method === "POST" && r.path === "/api/audiences",
      )!;

    it("should return 404 when creator is not found", async () => {
      mockDb.user.findUnique.mockResolvedValue(null);

      const request = new Request("https://example.com/api/audiences", {
        method: "POST",
        body: JSON.stringify({
          name: "My Audience",
          memberIds: ["member-1"],
        }),
      });

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toContain("not found");
    });

    it("should return 404 when creator has no actorUri", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        id: "user-123",
        username: "creator",
        actorUri: null,
        publicKey: "key",
        suspended: false,
        deletionConfirmedAt: null,
      });

      const request = new Request("https://example.com/api/audiences", {
        method: "POST",
        body: JSON.stringify({
          name: "My Audience",
          memberIds: ["member-1"],
        }),
      });

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toContain("not configured for ActivityPub");
    });

    it("should return 404 when creator has no publicKey", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        id: "user-123",
        username: "creator",
        actorUri: "https://example.com/users/creator",
        publicKey: null,
        suspended: false,
        deletionConfirmedAt: null,
      });

      const request = new Request("https://example.com/api/audiences", {
        method: "POST",
        body: JSON.stringify({
          name: "My Audience",
          memberIds: ["member-1"],
        }),
      });

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(404);
    });

    it("should return 403 when creator is suspended", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        id: "user-123",
        username: "creator",
        actorUri: "https://example.com/users/creator",
        publicKey: "key",
        suspended: true,
        deletionConfirmedAt: null,
      });

      const request = new Request("https://example.com/api/audiences", {
        method: "POST",
        body: JSON.stringify({
          name: "My Audience",
          memberIds: ["member-1"],
        }),
      });

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain("suspended or deleted");
    });

    it("should return 403 when creator has deletion confirmed", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        id: "user-123",
        username: "creator",
        actorUri: "https://example.com/users/creator",
        publicKey: "key",
        suspended: false,
        deletionConfirmedAt: new Date(),
      });

      const request = new Request("https://example.com/api/audiences", {
        method: "POST",
        body: JSON.stringify({
          name: "My Audience",
          memberIds: ["member-1"],
        }),
      });

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(403);
    });

    it("should return 404 when error message contains 'not found'", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        id: "user-123",
        username: "creator",
        actorUri: "https://example.com/users/creator",
        publicKey: "key",
        suspended: false,
        deletionConfirmedAt: null,
      });
      mockCreateAudience.mockRejectedValue(
        new Error("Member not found in system"),
      );

      const request = new Request("https://example.com/api/audiences", {
        method: "POST",
        body: JSON.stringify({
          name: "My Audience",
          memberIds: ["member-1"],
        }),
      });

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toContain("not found");
    });

    it("should return 404 when error message contains 'not configured'", async () => {
      mockDb.user.findUnique.mockResolvedValue({
        id: "user-123",
        username: "creator",
        actorUri: "https://example.com/users/creator",
        publicKey: "key",
        suspended: false,
        deletionConfirmedAt: null,
      });
      mockCreateAudience.mockRejectedValue(
        new Error("User not configured for federation"),
      );

      const request = new Request("https://example.com/api/audiences", {
        method: "POST",
        body: JSON.stringify({
          name: "My Audience",
          memberIds: ["member-1"],
        }),
      });

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(404);
    });

    it("should return 400 when name is empty string", async () => {
      const request = new Request("https://example.com/api/audiences", {
        method: "POST",
        body: JSON.stringify({
          name: "   ",
          memberIds: ["member-1"],
        }),
      });

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("name is required");
    });

    it("should return 400 when memberIds is not an array", async () => {
      const request = new Request("https://example.com/api/audiences", {
        method: "POST",
        body: JSON.stringify({
          name: "My Audience",
          memberIds: "not-an-array",
        }),
      });

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("memberIds must be a non-empty array");
    });
  });

  // ---- GET /audiences/:audienceId ----

  describe("GET /audiences/:audienceId - Get audience collection", () => {
    const getRoute = () =>
      audienceRoutes.find(
        (r) => r.method === "GET" && r.path === "/audiences/:audienceId",
      )!;

    it("should return 400 when audienceId is missing", async () => {
      const request = new Request("https://example.com/audiences/", {
        method: "GET",
      });

      const response = await getRoute().handler(request, mockEnv, {
        params: {},
        url: new URL(request.url),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("Audience ID is required");
    });

    it("should return audience collection successfully", async () => {
      const mockCollection = {
        type: "OrderedCollection",
        totalItems: 2,
      };
      mockCreateOrderedCollection.mockResolvedValue(mockCollection);
      mockGetFedifyContext.mockReturnValue({});
      mockRespondWithObject.mockResolvedValue(
        new Response(JSON.stringify(mockCollection), {
          status: 200,
          headers: { "content-type": "application/activity+json" },
        }),
      );

      const request = new Request(
        "https://example.com/audiences/audience-123",
        { method: "GET" },
      );

      const response = await getRoute().handler(request, mockEnv, {
        params: { audienceId: "audience-123" },
        url: new URL(request.url),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/activity+json",
      );
    });

    it("should parse page and limit from query parameters", async () => {
      const mockCollection = { type: "OrderedCollection" };
      mockCreateOrderedCollection.mockResolvedValue(mockCollection);
      mockGetFedifyContext.mockReturnValue({});
      mockRespondWithObject.mockResolvedValue(
        new Response(JSON.stringify(mockCollection), {
          status: 200,
          headers: { "content-type": "application/activity+json" },
        }),
      );

      const request = new Request(
        "https://example.com/audiences/audience-123?page=2&limit=10",
        { method: "GET" },
      );

      const response = await getRoute().handler(request, mockEnv, {
        params: { audienceId: "audience-123" },
        url: new URL(request.url),
      });

      expect(response.status).toBe(200);
      // Verify createOrderedCollection was called with parsed pagination
      expect(mockCreateOrderedCollection).toHaveBeenCalledWith(
        expect.anything(),
        "audience-123",
        expect.anything(),
        expect.any(String),
        2,
        10,
      );
    });

    it("should cap limit to maximum of 50", async () => {
      const mockCollection = { type: "OrderedCollection" };
      mockCreateOrderedCollection.mockResolvedValue(mockCollection);
      mockGetFedifyContext.mockReturnValue({});
      mockRespondWithObject.mockResolvedValue(
        new Response(JSON.stringify(mockCollection), {
          status: 200,
          headers: { "content-type": "application/activity+json" },
        }),
      );

      const request = new Request(
        "https://example.com/audiences/audience-123?limit=100",
        { method: "GET" },
      );

      await getRoute().handler(request, mockEnv, {
        params: { audienceId: "audience-123" },
        url: new URL(request.url),
      });

      expect(mockCreateOrderedCollection).toHaveBeenCalledWith(
        expect.anything(),
        "audience-123",
        expect.anything(),
        expect.any(String),
        1,
        50,
      );
    });

    it("should return 404 when error message contains 'not found'", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Audience not found"),
      );

      const request = new Request(
        "https://example.com/audiences/audience-123",
        { method: "GET" },
      );

      const response = await getRoute().handler(request, mockEnv, {
        params: { audienceId: "audience-123" },
        url: new URL(request.url),
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toContain("Audience not found");
    });

    it("should return 500 on generic errors", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database connection lost"),
      );

      const request = new Request(
        "https://example.com/audiences/audience-123",
        { method: "GET" },
      );

      const response = await getRoute().handler(request, mockEnv, {
        params: { audienceId: "audience-123" },
        url: new URL(request.url),
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Internal server error");
    });

    it("should default page to 1 and limit to 50 when not provided", async () => {
      const mockCollection = { type: "OrderedCollection" };
      mockCreateOrderedCollection.mockResolvedValue(mockCollection);
      mockGetFedifyContext.mockReturnValue({});
      mockRespondWithObject.mockResolvedValue(
        new Response(JSON.stringify(mockCollection), {
          status: 200,
          headers: { "content-type": "application/activity+json" },
        }),
      );

      const request = new Request(
        "https://example.com/audiences/audience-123",
        { method: "GET" },
      );

      await getRoute().handler(request, mockEnv, {
        params: { audienceId: "audience-123" },
        url: new URL(request.url),
      });

      expect(mockCreateOrderedCollection).toHaveBeenCalledWith(
        expect.anything(),
        "audience-123",
        expect.anything(),
        expect.any(String),
        1,
        50,
      );
    });
  });

  // ---- POST /api/audiences/:audienceId/members ----

  describe("POST /api/audiences/:audienceId/members - Add member", () => {
    const getRoute = () =>
      audienceRoutes.find(
        (r) =>
          r.method === "POST" &&
          r.path === "/api/audiences/:audienceId/members",
      )!;

    function createAddMemberRequest(
      audienceId: string,
      memberId: string,
    ): Request {
      const req = new Request(
        `https://example.com/api/audiences/${audienceId}/members`,
        {
          method: "POST",
          body: JSON.stringify({ memberId }),
        },
      ) as any;
      req.params = { audienceId };
      return req;
    }

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = createAddMemberRequest("audience-123", "member-1");

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(401);
    });

    it("should return 400 when audienceId is missing", async () => {
      const request = new Request(
        "https://example.com/api/audiences//members",
        {
          method: "POST",
          body: JSON.stringify({ memberId: "member-1" }),
        },
      ) as any;
      request.params = {};

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("audienceId and memberId are required");
    });

    it("should return 400 when memberId is missing in body", async () => {
      const request = new Request(
        "https://example.com/api/audiences/audience-123/members",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      ) as any;
      request.params = { audienceId: "audience-123" };

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(400);
    });

    it("should return 403 when audience is not found", async () => {
      mockDb.customAudience.findUnique.mockResolvedValue(null);

      const request = createAddMemberRequest("audience-123", "member-1");

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain("not found or access denied");
    });

    it("should return 403 when user does not own the audience", async () => {
      mockDb.customAudience.findUnique.mockResolvedValue({
        creatorId: "different-user",
      });

      const request = createAddMemberRequest("audience-123", "member-1");

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(403);
    });

    it("should add member successfully when user owns audience", async () => {
      mockDb.customAudience.findUnique.mockResolvedValue({
        creatorId: "user-123",
      });
      mockAddMember.mockResolvedValue(undefined);

      const request = createAddMemberRequest("audience-123", "member-1");

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(mockAddMember).toHaveBeenCalledWith(
        expect.anything(),
        "audience-123",
        "member-1",
      );
    });

    it("should return 400 on handler error", async () => {
      mockDb.customAudience.findUnique.mockResolvedValue({
        creatorId: "user-123",
      });
      mockAddMember.mockRejectedValue(new Error("Duplicate member"));

      const request = createAddMemberRequest("audience-123", "member-1");

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("Duplicate member");
    });
  });

  // ---- DELETE /api/audiences/:audienceId/members/:memberId ----

  describe("DELETE /api/audiences/:audienceId/members/:memberId - Remove member", () => {
    const getRoute = () =>
      audienceRoutes.find(
        (r) =>
          r.method === "DELETE" &&
          r.path === "/api/audiences/:audienceId/members/:memberId",
      )!;

    function createDeleteMemberRequest(
      audienceId: string,
      memberId: string,
    ): Request {
      const req = new Request(
        `https://example.com/api/audiences/${audienceId}/members/${memberId}`,
        { method: "DELETE" },
      ) as any;
      req.params = { audienceId, memberId };
      return req;
    }

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = createDeleteMemberRequest("audience-123", "member-1");

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(401);
    });

    it("should return 400 when audienceId is missing", async () => {
      const request = new Request(
        "https://example.com/api/audiences//members/member-1",
        { method: "DELETE" },
      ) as any;
      request.params = { memberId: "member-1" };

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("audienceId and memberId are required");
    });

    it("should return 400 when memberId is missing", async () => {
      const request = new Request(
        "https://example.com/api/audiences/audience-123/members/",
        { method: "DELETE" },
      ) as any;
      request.params = { audienceId: "audience-123" };

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(400);
    });

    it("should return 403 when audience is not found", async () => {
      mockDb.customAudience.findUnique.mockResolvedValue(null);

      const request = createDeleteMemberRequest("audience-123", "member-1");

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain("not found or access denied");
    });

    it("should return 403 when user does not own the audience", async () => {
      mockDb.customAudience.findUnique.mockResolvedValue({
        creatorId: "other-user",
      });

      const request = createDeleteMemberRequest("audience-123", "member-1");

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(403);
    });

    it("should remove member successfully when user owns audience", async () => {
      mockDb.customAudience.findUnique.mockResolvedValue({
        creatorId: "user-123",
      });
      mockRemoveMember.mockResolvedValue(undefined);

      const request = createDeleteMemberRequest("audience-123", "member-1");

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(mockRemoveMember).toHaveBeenCalledWith(
        expect.anything(),
        "audience-123",
        "member-1",
      );
    });

    it("should return 500 on handler error", async () => {
      mockDb.customAudience.findUnique.mockResolvedValue({
        creatorId: "user-123",
      });
      mockRemoveMember.mockRejectedValue(new Error("Database error"));

      const request = createDeleteMemberRequest("audience-123", "member-1");

      const response = await getRoute().handler(request, mockEnv, {
        url: new URL(request.url),
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Failed to remove member");
    });
  });
});
