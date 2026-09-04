import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataRouterEnv } from "../../src/lib/data-router.js";
import { DataRouter } from "../../src/lib/data-router.js";

// Captured mocks for inspecting calls in tests (updated by createMockDatabase)
let mockPostMediaCreateMany: ReturnType<typeof vi.fn>;
let mockMediaFileUpdateMany: ReturnType<typeof vi.fn>;

// Create mock database factory function
function createMockDatabase() {
  const mockPostCreate = vi.fn(async (data: any) => ({
    id: "post-123",
    authorId: data.data.authorId,
    text: data.data.text,
    dataRegion: data.data.dataRegion,
  }));

  mockPostMediaCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  mockMediaFileUpdateMany = vi.fn().mockResolvedValue({ count: 0 });

  return {
    user: {
      create: vi.fn(async (data: any) => ({
        id: data.data.id,
        email: data.data.email,
        region: data.data.region,
        dataRegion: data.data.dataRegion,
      })),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(async (query: any) => {
        if (query.where.id === "user-123") {
          return {
            id: "user-123",
            email: "test@example.com",
            region: "US",
            dataRegion: "US",
          };
        }
        return null;
      }),
      update: vi.fn(async (query: any) => ({
        id: query.where.id,
        email: query.data.email || "test@example.com",
        region: query.data.region || "US",
        dataRegion: query.data.dataRegion || "US",
      })),
      upsert: vi.fn(async (query: any) => ({
        id: query.where.id,
        email: query.create.email || query.update.email || "test@example.com",
        region: query.create.region || query.update.region || "US",
        dataRegion: query.create.dataRegion || query.update.dataRegion || "US",
        lastChanged: new Date(),
        changedBy: query.create.changedBy || query.update.changedBy,
      })),
    },
    post: {
      create: mockPostCreate,
      findUnique: vi.fn(async (query: any) => {
        if (query.where.id === "post-123") {
          return {
            id: "post-123",
            authorId: "user-123",
            text: "Test post",
            dataRegion: "US",
          };
        }
        return null;
      }),
    },
    postEntity: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    entity: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi.fn(async (callback: any) => {
      const tx = {
        post: { create: mockPostCreate },
        postEntity: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        postMedia: { createMany: mockPostMediaCreateMany },
        mediaFile: { updateMany: mockMediaFileUpdateMany },
        // Outbox writer (plan 034 lane E) — `post.published` is emitted inside
        // this same transaction, so the tx double needs the delegate.
        domainEvent: { create: vi.fn().mockResolvedValue({ id: "de_1" }) },
        entity: { findMany: vi.fn().mockResolvedValue([]) },
      };
      return await callback(tx);
    }),
  };
}

// Mock db module
vi.mock("../../src/db", () => ({
  createPrismaForRegion: vi.fn((region: string, env: any) =>
    createMockDatabase(),
  ),
}));

// Mock database connection manager to use mocked database (no real connections)
// This ensures unit tests don't try to connect to Hyperdrive or real database
vi.mock("../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {
    executeWithRetry: async (
      region: string,
      env: any,
      queryFn: (db: any) => Promise<any>,
      options?: any,
    ) => {
      // Use the mocked createPrismaForRegion from the db mock
      const dbModule = await import("../../src/db.js");
      const db = (dbModule.createPrismaForRegion as any)(region, env);
      return await queryFn(db);
    },
  },
  DatabaseConnectionManager: class {
    executeWithRetry = async (
      region: string,
      env: any,
      queryFn: (db: any) => Promise<any>,
      options?: any,
    ) => {
      const dbModule = await import("../../src/db.js");
      const db = (dbModule.createPrismaForRegion as any)(region, env);
      return await queryFn(db);
    };
  },
}));

// Mock region-detection
vi.mock("../../src/lib/region-detection", () => {
  const mockIsValidRegion = vi.fn((region: string) =>
    ["US", "EU", "CN"].includes(region),
  );
  return {
    isValidRegion: mockIsValidRegion,
    RegionDetector: class RegionDetector {
      isValidRegion = mockIsValidRegion;
    },
  };
});

// Mock audit-logger
const mockLogDataAccess = vi.fn().mockResolvedValue(undefined);
const mockLogUserAction = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/lib/audit-composer", () => {
  // Create a mock class inside the factory function (required for hoisting)
  class MockAuditLogger {
    logDataAccess = mockLogDataAccess;
    logUserAction = mockLogUserAction;

    withRequestId(requestId: string) {
      // Return a new instance with the same methods
      return new MockAuditLogger();
    }
  }

  return {
    TrellisAuditLogger: MockAuditLogger,
  };
});

// Mock ip-scrubber
vi.mock("../../src/lib/ip-scrubber", () => ({
  getIPAddress: vi.fn((request: Request) => {
    return request.headers.get("CF-Connecting-IP") || "127.0.0.1";
  }),
}));

describe("Data Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockEnv = (
    overrides: Partial<DataRouterEnv> = {},
  ): DataRouterEnv => ({
    DATABASE_URL: "postgres://test",
    DEFAULT_REGION: "US",
    HYPERDRIVE: {
      connectionString:
        "postgresql://test-hyperdrive.hyperdrive.workers.dev:5432/postgres",
    } as any,
    ...overrides,
  });

  describe("getDatabaseForRegion", () => {
    it("should return database client for valid region", () => {
      const env = createMockEnv();
      const db = DataRouter.getDatabaseForRegion("US", env);
      expect(db).toBeDefined();
    });

    it("should throw error for invalid region", () => {
      const env = createMockEnv();
      expect(() => {
        DataRouter.getDatabaseForRegion("INVALID", env);
      }).toThrow("Invalid region: INVALID");
    });
  });

  describe("createUser", () => {
    it("should create user with region and dataRegion set", async () => {
      const env = createMockEnv();
      const userData = {
        id: "user-123",
        email: "test@example.com",
        role: "END_USER",
      };

      const user = await DataRouter.createUser(userData, "US", env);

      expect(user.id).toBe("user-123");
      expect(user.email).toBe("test@example.com");
      expect(user.region).toBe("US");
      expect(user.dataRegion).toBe("US");
    });

    it("should log audit event when creating user", async () => {
      const env = createMockEnv();
      const userData = {
        id: "user-123",
        email: "test@example.com",
      };
      const request = new Request("https://example.com", {
        headers: {
          "User-Agent": "test-agent",
          "CF-Connecting-IP": "192.168.1.1",
        },
      });

      await DataRouter.createUser(userData, "US", env, request, "req-123");

      expect(mockLogUserAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "user_created",
          resource: "user",
          resourceId: "user-123",
          region: "US",
          dataRegion: "US",
          success: true,
        }),
        env,
      );
    });

    it("should handle audit logging failure gracefully", async () => {
      const env = createMockEnv();
      const userData = {
        id: "user-123",
        email: "test@example.com",
      };

      // Mock audit logging failure
      mockLogUserAction.mockRejectedValueOnce(new Error("Audit log failed"));

      // Should still create user (audit logging shouldn't break the operation)
      const user = await DataRouter.createUser(userData, "US", env);
      expect(user.id).toBe("user-123");
    });

    it("should enforce dataRegion matches region", async () => {
      const env = createMockEnv();
      const userData = {
        id: "user-123",
        email: "test@example.com",
      };

      const user = await DataRouter.createUser(userData, "CN", env);
      expect(user.dataRegion).toBe("CN");
    });

    it("should throw error for invalid region", async () => {
      const env = createMockEnv();
      const userData = {
        id: "user-123",
        email: "test@example.com",
      };

      await expect(
        DataRouter.createUser(userData, "INVALID", env),
      ).rejects.toThrow("Invalid region: INVALID");
    });
  });

  describe("getUser", () => {
    it("should get user from region-specific database", async () => {
      const env = createMockEnv();
      const user = await DataRouter.getUser("user-123", "US", env);

      expect(user).toBeDefined();
      expect(user?.id).toBe("user-123");
      expect(user?.dataRegion).toBe("US");
    });

    it("should log audit event when getting user", async () => {
      const env = createMockEnv();
      const request = new Request("https://example.com", {
        headers: {
          "User-Agent": "test-agent",
          "CF-Connecting-IP": "192.168.1.1",
        },
      });

      await DataRouter.getUser(
        "user-123",
        "US",
        env,
        request,
        "req-123",
        "requester-456",
      );

      expect(mockLogDataAccess).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "user_accessed",
          resource: "user",
          resourceId: "user-123",
          userId: "requester-456",
          region: "US",
          dataRegion: "US",
          success: true,
        }),
        env,
      );
    });

    it("should log failed access when user not found", async () => {
      const env = createMockEnv();
      const request = new Request("https://example.com");

      await DataRouter.getUser("non-existent", "US", env, request);

      expect(mockLogDataAccess).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "user_accessed",
          resource: "user",
          resourceId: "non-existent",
          success: false,
        }),
        env,
      );
    });

    it("should return null if user not found", async () => {
      const env = createMockEnv();
      const user = await DataRouter.getUser("non-existent", "US", env);

      expect(user).toBeNull();
    });

    it("should throw error if dataRegion mismatch detected", async () => {
      const env = createMockEnv();

      // Mock user with mismatched dataRegion
      const { createPrismaForRegion } = await import("../../src/db.js");
      vi.mocked(createPrismaForRegion).mockReturnValueOnce({
        user: {
          findFirst: vi.fn().mockResolvedValue(null),
          findUnique: vi.fn(async () => ({
            id: "user-123",
            email: "test@example.com",
            region: "US",
            dataRegion: "CN", // Mismatch!
          })),
        },
      } as any);

      // DataRouter returns null instead of throwing for security (don't expose cross-region data)
      const result = await DataRouter.getUser("user-123", "US", env);
      expect(result).toBeNull();
    });

    it("should throw error for invalid region", async () => {
      const env = createMockEnv();
      await expect(
        DataRouter.getUser("user-123", "INVALID", env),
      ).rejects.toThrow("Invalid region: INVALID");
    });
  });

  describe("updateUser", () => {
    it("should update user in region-specific database", async () => {
      const env = createMockEnv();
      const updateData = {
        email: "updated@example.com",
      };

      const user = await DataRouter.updateUser(
        "user-123",
        updateData,
        "US",
        env,
      );

      expect(user).toBeDefined();
      expect(user.id).toBe("user-123");
    });

    it("should log audit event when updating user", async () => {
      const env = createMockEnv();
      const updateData = {
        email: "updated@example.com",
      };
      const request = new Request("https://example.com", {
        headers: {
          "User-Agent": "test-agent",
          "CF-Connecting-IP": "192.168.1.1",
        },
      });

      await DataRouter.updateUser(
        "user-123",
        updateData,
        "US",
        env,
        request,
        "req-123",
        "requester-456",
      );

      expect(mockLogUserAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "user_updated",
          resource: "user",
          resourceId: "user-123",
          userId: "requester-456",
          region: "US",
          success: true,
          metadata: expect.objectContaining({
            updatedFields: ["email"],
          }),
        }),
        env,
      );
    });

    it("should prevent dataRegion from being changed", async () => {
      const env = createMockEnv();
      const updateData = {
        dataRegion: "CN", // Attempt to change dataRegion
      };

      await expect(
        DataRouter.updateUser("user-123", updateData, "US", env),
      ).rejects.toThrow("dataRegion cannot be changed");
    });

    it("should throw error for invalid region", async () => {
      const env = createMockEnv();
      await expect(
        DataRouter.updateUser("user-123", {}, "INVALID", env),
      ).rejects.toThrow("Invalid region: INVALID");
    });
  });

  describe("createPost", () => {
    it("should create post with dataRegion set", async () => {
      const env = createMockEnv();
      const postData = {
        authorId: "user-123",
        text: "Test post",
        radius: "SHOUT",
        tenantId: "tenant-x",
      };

      const post = await DataRouter.createPost(postData, "US", env);

      expect(post.id).toBe("post-123");
      expect(post.authorId).toBe("user-123");
      expect(post.dataRegion).toBe("US");
    });

    it("should log audit event when creating post", async () => {
      const env = createMockEnv();
      const postData = {
        authorId: "user-123",
        text: "Test post",
        radius: "SHOUT",
        tenantId: "tenant-x",
        geoData: { lat: 40.7128, lng: -74.006 },
      };
      const request = new Request("https://example.com", {
        headers: {
          "User-Agent": "test-agent",
          "CF-Connecting-IP": "192.168.1.1",
        },
      });

      await DataRouter.createPost(postData, "US", env, request, "req-123");

      expect(mockLogUserAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "post_created",
          resource: "post",
          resourceId: "post-123",
          userId: "user-123",
          region: "US",
          dataRegion: "US",
          success: true,
          metadata: expect.objectContaining({
            radius: "SHOUT",
            hasGeoData: true,
          }),
        }),
        env,
      );
    });

    it("should enforce dataRegion matches region", async () => {
      const env = createMockEnv();
      const postData = {
        authorId: "user-123",
        text: "Test post",
        radius: "SHOUT",
        tenantId: "tenant-x",
      };

      const post = await DataRouter.createPost(postData, "CN", env);
      expect(post.dataRegion).toBe("CN");
    });

    it("should throw error for invalid region", async () => {
      const env = createMockEnv();
      const postData = {
        authorId: "user-123",
        text: "Test post",
        radius: "SHOUT",
        tenantId: "tenant-x",
      };

      await expect(
        DataRouter.createPost(postData, "INVALID", env),
      ).rejects.toThrow("Invalid region: INVALID");
    });

    it("should set attachedToPost=true on MediaFiles when post is created with media", async () => {
      const env = createMockEnv();
      const postData = {
        authorId: "user-123",
        text: "Post with image",
        radius: "SHOUT",
        tenantId: "tenant-x",
        media: [
          { id: "media-1", alt: "A photo" },
          { id: "media-2", alt: "" },
        ],
      };

      await DataRouter.createPost(postData, "US", env);

      expect(mockPostMediaCreateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            { postId: "post-123", mediaId: "media-1", alt: "A photo", order: 0 },
            { postId: "post-123", mediaId: "media-2", alt: "", order: 1 },
          ],
          skipDuplicates: true,
        }),
      );

      expect(mockMediaFileUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ["media-1", "media-2"] } },
        data: { attachedToPost: true, orphanedAt: null },
      });
    });

    it("should clear orphanedAt when creating post with previously-orphaned media", async () => {
      const env = createMockEnv();
      const postData = {
        authorId: "user-123",
        text: "Post reclaiming orphaned image",
        radius: "SHOUT",
        tenantId: "tenant-x",
        media: [{ id: "media-orphaned", alt: "" }],
      };

      await DataRouter.createPost(postData, "US", env);

      // The updateMany call must include orphanedAt: null to clear the stale flag
      expect(mockMediaFileUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ orphanedAt: null, attachedToPost: true }),
        }),
      );
    });

    it("should not call postMedia or mediaFile update when post has no media", async () => {
      const env = createMockEnv();
      const postData = {
        authorId: "user-123",
        text: "Text-only post",
        radius: "SHOUT",
        tenantId: "tenant-x",
      };

      await DataRouter.createPost(postData, "US", env);

      expect(mockPostMediaCreateMany).not.toHaveBeenCalled();
      expect(mockMediaFileUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe("getPost", () => {
    it("should get post from region-specific database", async () => {
      const env = createMockEnv();
      const post = await DataRouter.getPost("post-123", "US", env);

      expect(post).toBeDefined();
      expect(post?.id).toBe("post-123");
      expect(post?.dataRegion).toBe("US");
    });

    it("should log audit event when getting post", async () => {
      const env = createMockEnv();
      const request = new Request("https://example.com", {
        headers: {
          "User-Agent": "test-agent",
          "CF-Connecting-IP": "192.168.1.1",
        },
      });

      await DataRouter.getPost(
        "post-123",
        "US",
        env,
        request,
        "req-123",
        "requester-456",
      );

      expect(mockLogDataAccess).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "post_accessed",
          resource: "post",
          resourceId: "post-123",
          userId: "requester-456",
          region: "US",
          dataRegion: "US",
          success: true,
        }),
        env,
      );
    });

    it("should return null if post not found", async () => {
      const env = createMockEnv();
      const post = await DataRouter.getPost("non-existent", "US", env);

      expect(post).toBeNull();
    });

    it("should throw error if dataRegion mismatch detected", async () => {
      const env = createMockEnv();

      // Mock post with mismatched dataRegion
      const { createPrismaForRegion } = await import("../../src/db.js");
      vi.mocked(createPrismaForRegion).mockReturnValueOnce({
        post: {
          findUnique: vi.fn(async () => ({
            id: "post-123",
            authorId: "user-123",
            text: "Test post",
            dataRegion: "CN", // Mismatch!
          })),
        },
      } as any);

      // DataRouter returns null instead of throwing for security (don't expose cross-region data)
      const result = await DataRouter.getPost("post-123", "US", env);
      expect(result).toBeNull();
    });

    it("should throw error for invalid region", async () => {
      const env = createMockEnv();
      await expect(
        DataRouter.getPost("post-123", "INVALID", env),
      ).rejects.toThrow("Invalid region: INVALID");
    });
  });
});
