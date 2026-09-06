/**
 * Tests for Fedify Outbox Listener
 *
 * Tests outbox activity retrieval with Fedify integration.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getOutboxActivities } from "../../../../src/lib/activitypub/listeners/outbox.js";
import type { Env } from "../../../../src/env.js";

// Mock dependencies
vi.mock("../../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {
    getConnection: vi.fn(),
  },
}));

vi.mock("../../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: vi.fn(),
  QueryTimeoutPresets: {
    STANDARD: {},
  },
}));

vi.mock("../../../../src/lib/region-detection", () => ({
  detectRegionSync: vi.fn(() => "EU"),
}));

vi.mock("../../../../src/lib/activitypub/activity-service", () => ({
  ActivityService: {
    getOutboxActivities: vi.fn(),
    getOutboxCount: vi.fn(),
  },
}));

describe("Fedify Outbox Listener", () => {
  const mockEnv: Partial<Env> = {
    LOG_LEVEL: "INFO",
    ACTIVITYPUB_BASE_URL: "https://example.com",
    DATABASE_URL: "postgresql://test",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getOutboxActivities", () => {
    it("should return 404 for non-existent user", async () => {
      const request = new Request(
        "https://example.com/users/nonexistent/outbox",
        {
          method: "GET",
        },
      );

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue(null),
            },
          };
          return callback(mockDb as any);
        },
      );

      const response = await getOutboxActivities(
        request,
        mockEnv as Env,
        "nonexistent",
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("User not found");
    });

    it("should return 404 for user missing actorId", async () => {
      const request = new Request("https://example.com/users/bob/outbox", {
        method: "GET",
      });

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue({
                id: "user-123",
                username: "bob",
                actorUri: null,
              }),
            },
          };
          return callback(mockDb as any);
        },
      );

      const response = await getOutboxActivities(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(404);
    });

    it("should return OrderedCollection for user with activities", async () => {
      const request = new Request("https://example.com/users/bob/outbox", {
        method: "GET",
      });

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: "user-123",
            username: "bob",
            actorUri: "https://example.com/users/bob",
          }),
        },
      };

      const mockActivities = [
        {
          type: "Create",
          actorUri: "https://example.com/users/bob",
          objectId: "https://example.com/posts/123",
          targetId: null,
          to: ["https://www.w3.org/ns/activitystreams#Public"],
          cc: null,
          bto: null,
          bcc: null,
          published: new Date("2024-01-01T00:00:00Z"),
        },
      ];

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const { ActivityService } = await import(
        "../../../../src/lib/activitypub/activity-service.js"
      );
      vi.mocked(ActivityService.getOutboxActivities).mockResolvedValue(
        mockActivities as any,
      );
      vi.mocked(ActivityService.getOutboxCount).mockResolvedValue(1);

      const response = await getOutboxActivities(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.type).toBe("OrderedCollection");
      expect(body.totalItems).toBe(1);
      expect(body.orderedItems).toHaveLength(1);
      expect(body["@context"]).toBe("https://www.w3.org/ns/activitystreams");
    });

    it("never publishes bto/bcc on served items (AS2 blind recipients)", async () => {
      const request = new Request("https://example.com/users/bob/outbox", {
        method: "GET",
      });

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: "user-123",
            username: "bob",
            actorUri: "https://example.com/users/bob",
          }),
        },
      };

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const { ActivityService } = await import(
        "../../../../src/lib/activitypub/activity-service.js"
      );
      vi.mocked(ActivityService.getOutboxActivities).mockResolvedValue([
        {
          type: "Create",
          actorUri: "https://example.com/users/bob",
          objectId: "https://example.com/posts/123",
          targetId: null,
          to: ["https://www.w3.org/ns/activitystreams#Public"],
          cc: null,
          bto: ["https://example.com/users/carol"],
          bcc: ["https://example.com/users/dave"],
          published: new Date("2024-01-01T00:00:00Z"),
        },
      ] as any);
      vi.mocked(ActivityService.getOutboxCount).mockResolvedValue(1);

      const response = await getOutboxActivities(request, mockEnv as Env, "bob");
      const body = await response.json();
      const item = body.orderedItems[0];
      expect(item.to).toEqual(["https://www.w3.org/ns/activitystreams#Public"]);
      expect(item).not.toHaveProperty("bto");
      expect(item).not.toHaveProperty("bcc");
      expect(JSON.stringify(body)).not.toContain("carol");
      expect(JSON.stringify(body)).not.toContain("dave");
    });

    it("should return empty OrderedCollection for user with no activities", async () => {
      const request = new Request("https://example.com/users/bob/outbox", {
        method: "GET",
      });

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: "user-123",
            username: "bob",
            actorUri: "https://example.com/users/bob",
          }),
        },
      };

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const { ActivityService } = await import(
        "../../../../src/lib/activitypub/activity-service.js"
      );
      vi.mocked(ActivityService.getOutboxActivities).mockResolvedValue([]);
      vi.mocked(ActivityService.getOutboxCount).mockResolvedValue(0);

      const response = await getOutboxActivities(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.totalItems).toBe(0);
      expect(body.orderedItems).toHaveLength(0);
    });

    it("should handle pagination parameters", async () => {
      const request = new Request(
        "https://example.com/users/bob/outbox?page=2&limit=10",
        {
          method: "GET",
        },
      );

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: "user-123",
            username: "bob",
            actorUri: "https://example.com/users/bob",
          }),
        },
      };

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const { ActivityService } = await import(
        "../../../../src/lib/activitypub/activity-service.js"
      );
      vi.mocked(ActivityService.getOutboxActivities).mockResolvedValue([]);
      vi.mocked(ActivityService.getOutboxCount).mockResolvedValue(0);

      const response = await getOutboxActivities(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(200);
      expect(ActivityService.getOutboxActivities).toHaveBeenCalledWith(
        expect.anything(),
        "https://example.com/users/bob",
        2,
        10,
      );
    });

    it("should enforce maximum limit", async () => {
      const request = new Request(
        "https://example.com/users/bob/outbox?limit=200",
        {
          method: "GET",
        },
      );

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: "user-123",
            username: "bob",
            actorUri: "https://example.com/users/bob",
          }),
        },
      };

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const { ActivityService } = await import(
        "../../../../src/lib/activitypub/activity-service.js"
      );
      vi.mocked(ActivityService.getOutboxActivities).mockResolvedValue([]);
      vi.mocked(ActivityService.getOutboxCount).mockResolvedValue(0);

      const response = await getOutboxActivities(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(200);
      expect(ActivityService.getOutboxActivities).toHaveBeenCalledWith(
        expect.anything(),
        "https://example.com/users/bob",
        1,
        100,
      );
    });

    it("should handle errors gracefully", async () => {
      const request = new Request("https://example.com/users/bob/outbox", {
        method: "GET",
      });

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockRejectedValue(
        new Error("Database error"),
      );

      const response = await getOutboxActivities(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Internal server error");
    });
  });
});
