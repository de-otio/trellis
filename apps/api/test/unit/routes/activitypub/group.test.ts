/**
 * Unit Tests: ActivityPub Group Routes
 *
 * Tests for ActivityPub group route handlers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../../src/env.js";
import { groupRoutes } from "../../../../src/lib/routes/activitypub/group.js";

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

// Mock the signature entry point (M13 route-status tests below)
const mockVerifyInboxRequest = vi.fn();
vi.mock("../../../../src/lib/activitypub/listeners/http-signatures", () => ({
  verifyInboxRequest: (...args: any[]) => mockVerifyInboxRequest(...args),
}));

// Mock GroupService
const mockSerializeActor = vi.fn();
const mockGetMemberRole = vi.fn();
const mockGetMemberActorUris = vi.fn();
const mockGetMembersCount = vi.fn();
vi.mock("../../../../src/lib/activitypub/group-service", () => ({
  GroupService: {
    serializeActor: (...args: any[]) => mockSerializeActor(...args),
    getMemberRole: (...args: any[]) => mockGetMemberRole(...args),
    getMemberActorUris: (...args: any[]) => mockGetMemberActorUris(...args),
    getMembersCount: (...args: any[]) => mockGetMembersCount(...args),
  },
}));

// M14: caller identity + the collections a group serves.
const mockGetSession = vi.fn();
vi.mock("../../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = (...args: any[]) => mockGetSession(...args);
  },
}));
const mockGetInboxActivities = vi.fn();
const mockGetInboxCount = vi.fn();
const mockGetOutboxActivities = vi.fn();
const mockGetOutboxCount = vi.fn();
vi.mock("../../../../src/lib/activitypub/activity-service", () => ({
  ActivityService: {
    getInboxActivities: (...a: any[]) => mockGetInboxActivities(...a),
    getInboxCount: (...a: any[]) => mockGetInboxCount(...a),
    getOutboxActivities: (...a: any[]) => mockGetOutboxActivities(...a),
    getOutboxCount: (...a: any[]) => mockGetOutboxCount(...a),
    storeInboxActivity: vi.fn(),
  },
}));

describe("ActivityPub Group Routes", () => {
  let mockEnv: Env;
  let mockRequest: Request;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockDb = {
      group: {
        findUnique: vi.fn(),
      },
      follow: {
        count: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
    };

    // M14 defaults: anonymous caller; collections return empty pages.
    mockGetSession.mockResolvedValue(null);
    mockGetMemberRole.mockResolvedValue(null);
    mockGetMemberActorUris.mockResolvedValue(["https://example.com/users/m1"]);
    mockGetMembersCount.mockResolvedValue(1);
    mockGetInboxActivities.mockResolvedValue([]);
    mockGetInboxCount.mockResolvedValue(0);
    mockGetOutboxActivities.mockResolvedValue([]);
    mockGetOutboxCount.mockResolvedValue(0);

    mockRequest = new Request("https://example.com/groups/group-123", {
      method: "GET",
    });

    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddCorsHeaders.mockImplementation(async (response) => response);
    mockDetectRegionSync.mockReturnValue("US");
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (db, region, env, fn) => {
        return await fn(mockDb);
      },
    );
  });

  // M14 — who may read a group's collections.
  describe("group collection read access (M14)", () => {
    const GROUP_URI = "https://example.com/groups/g1";
    const find = (method: string, path: string) =>
      groupRoutes.find((r) => r.method === method && r.path === path)!;
    const followers = () => find("GET", "/groups/:groupId/followers");
    const outbox = () => find("GET", "/groups/:groupId/outbox");
    const inbox = () => find("GET", "/groups/:groupId/inbox");

    const call = (route: ReturnType<typeof find>) =>
      route.handler(
        new Request(`https://example.com/groups/g1/${route.path.split("/").pop()}`),
        mockEnv,
        { params: { groupId: "g1" } } as any,
      );

    const withGroup = (privacy: string | null) =>
      mockDb.group.findUnique.mockResolvedValue(
        privacy === null
          ? null
          : { id: "g1", actorUri: GROUP_URI, followersUrl: `${GROUP_URI}/followers`, privacy },
      );

    /** Caller is signed in and holds `role` in the group (null = not a member). */
    const signedInAs = (role: "MEMBER" | "MODERATOR" | "ADMIN" | null) => {
      mockGetSession.mockResolvedValue({ userId: "u1" });
      mockDb.user.findUnique.mockResolvedValue({ actorUri: "https://example.com/users/u1" });
      mockGetMemberRole.mockResolvedValue(role);
    };

    const NOT_FOUND = JSON.stringify({ error: "Group not found" });

    describe.each([
      ["followers", followers],
      ["outbox", outbox],
    ])("%s", (_name, route) => {
      it("PUBLIC group stays open to anonymous callers (no session lookup at all)", async () => {
        withGroup("PUBLIC");
        const res = await call(route());
        expect(res.status).toBe(200);
        expect(mockGetSession).not.toHaveBeenCalled();
      });

      it.each(["PRIVATE", "FRIENDS_ONLY", "SOME_FUTURE_VALUE"])(
        "%s group: anonymous caller gets 404 and no data is read",
        async (privacy) => {
          withGroup(privacy);
          const res = await call(route());
          expect(res.status).toBe(404);
          expect(await res.text()).toBe(NOT_FOUND);
          expect(mockGetMemberActorUris).not.toHaveBeenCalled();
          expect(mockGetMembersCount).not.toHaveBeenCalled();
          expect(mockGetOutboxActivities).not.toHaveBeenCalled();
        },
      );

      it("PRIVATE group: a signed-in NON-member gets 404", async () => {
        withGroup("PRIVATE");
        signedInAs(null);
        const res = await call(route());
        expect(res.status).toBe(404);
        expect(mockGetMemberActorUris).not.toHaveBeenCalled();
      });

      it("PRIVATE group: a plain MEMBER is served", async () => {
        withGroup("PRIVATE");
        signedInAs("MEMBER");
        const res = await call(route());
        expect(res.status).toBe(200);
      });

      it("PRIVATE group: a refusal is byte-identical to a nonexistent group (no existence oracle)", async () => {
        withGroup("PRIVATE");
        const denied = await call(route());
        withGroup(null);
        const missing = await call(route());
        expect(denied.status).toBe(missing.status);
        expect(await denied.text()).toBe(await missing.text());
      });

      it("PRIVATE group: fails CLOSED when the caller's role cannot be established", async () => {
        withGroup("PRIVATE");
        signedInAs("ADMIN");
        mockDb.user.findUnique.mockRejectedValue(new Error("db down"));
        const res = await call(route());
        expect(res.status).toBe(404);
      });

      it("PRIVATE group: a signed-in user with no actorUri is refused", async () => {
        withGroup("PRIVATE");
        signedInAs("ADMIN");
        mockDb.user.findUnique.mockResolvedValue({ actorUri: null });
        const res = await call(route());
        expect(res.status).toBe(404);
      });
    });

    describe("inbox (owner-only, even for PUBLIC groups)", () => {
      it.each(["PUBLIC", "PRIVATE"])(
        "%s group: anonymous caller gets 404 and the inbox is never read",
        async (privacy) => {
          withGroup(privacy);
          const res = await call(inbox());
          expect(res.status).toBe(404);
          expect(await res.text()).toBe(NOT_FOUND);
          expect(mockGetInboxActivities).not.toHaveBeenCalled();
          expect(mockGetInboxCount).not.toHaveBeenCalled();
        },
      );

      it("PUBLIC group: a plain MEMBER cannot read the inbox", async () => {
        withGroup("PUBLIC");
        signedInAs("MEMBER");
        const res = await call(inbox());
        expect(res.status).toBe(404);
        expect(mockGetInboxActivities).not.toHaveBeenCalled();
      });

      it("PUBLIC group: a signed-in NON-member cannot read the inbox", async () => {
        withGroup("PUBLIC");
        signedInAs(null);
        expect((await call(inbox())).status).toBe(404);
      });

      it.each(["MODERATOR", "ADMIN"] as const)("%s can read the inbox", async (role) => {
        withGroup("PRIVATE");
        signedInAs(role);
        const res = await call(inbox());
        expect(res.status).toBe(200);
        expect(mockGetInboxActivities).toHaveBeenCalledTimes(1);
      });

      it("fails CLOSED when the role lookup throws", async () => {
        withGroup("PUBLIC");
        signedInAs("ADMIN");
        mockGetMemberRole.mockRejectedValue(new Error("db down"));
        expect((await call(inbox())).status).toBe(404);
        expect(mockGetInboxActivities).not.toHaveBeenCalled();
      });
    });

    it("the role check is made against THIS group and the caller's own actorUri", async () => {
      withGroup("PRIVATE");
      signedInAs("MEMBER");
      await call(followers());
      expect(mockGetMemberRole).toHaveBeenCalledTimes(1);
      const [, groupId, actorUri] = mockGetMemberRole.mock.calls[0];
      expect(groupId).toBe("g1");
      expect(actorUri).toBe("https://example.com/users/u1");
    });
  });

  describe("POST /groups/:groupId/inbox - verification failure status (M13)", () => {
    const route = groupRoutes.find(
      (r) => r.method === "POST" && r.path === "/groups/:groupId/inbox",
    )!;

    const post = (reason: string) => {
      mockVerifyInboxRequest.mockResolvedValue({ valid: false, reason });
      return route.handler(
        new Request("https://example.com/groups/group-123/inbox", {
          method: "POST",
          body: "{}",
        }),
        mockEnv,
        { params: { groupId: "group-123" } } as any,
      );
    };

    it.each([
      ["rate-limited", 429, "Try again later"],
      ["check-failed", 503, "Try again later"],
      ["bad-signature", 401, "Unauthorized"],
      ["missing-signature", 401, "Unauthorized"],
    ])("a %s outcome is HTTP %i", async (reason, status, error) => {
      const response = await post(reason);
      expect(response.status).toBe(status);
      expect((await response.json()).error).toBe(error);
    });
  });

  describe("GET /groups/:groupId - Get group actor", () => {
    const route = groupRoutes.find(
      (r) => r.method === "GET" && r.path === "/groups/:groupId",
    );

    it("should get group actor successfully", async () => {
      const mockGroup = {
        id: "group-123",
        name: "Test Group",
        description: "A test group",
      };
      mockDb.group.findUnique.mockResolvedValue(mockGroup);
      mockSerializeActor.mockResolvedValue({
        type: "Group",
        id: "https://example.com/groups/group-123",
        name: "Test Group",
      });

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { groupId: "group-123" },
      });

      expect(mockDb.group.findUnique).toHaveBeenCalled();
      expect(mockSerializeActor).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("should return 404 when group is not found", async () => {
      mockDb.group.findUnique.mockResolvedValue(null);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { groupId: "nonexistent" },
      });

      expect(response.status).toBe(404);
    });

    it("should handle errors", async () => {
      const error = new Error("Database error");
      mockWithQueryTimeoutAndRetry.mockRejectedValue(error);

      const response = await route!.handler(mockRequest, mockEnv, {
        params: { groupId: "group-123" },
      });

      // Logger error should be called
      expect(response.status).toBe(500);
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(groupRoutes.length).toBeGreaterThan(0);
    });

    it("should have middleware configured", () => {
      groupRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions", () => {
      groupRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
