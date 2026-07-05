/**
 * Unit Tests: Media Handler
 *
 * Tests for media listing, details, hide/unhide, delete operations, including timeout/retry logic.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import { MediaHandler } from "../../src/lib/media-handler.js";

// Mock withQueryTimeoutAndRetry
const mockWithQueryTimeoutAndRetry = vi.fn();

// Mock database connection manager
const mockSharedDatabaseConnectionManager = {
  executeWithRetry: vi.fn(),
};

vi.mock("../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: mockSharedDatabaseConnectionManager,
  DatabaseConnectionManager: class DatabaseConnectionManager {
    executeWithRetry = mockSharedDatabaseConnectionManager.executeWithRetry;
  },
}));

vi.mock("../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: (...args: any[]) =>
    mockWithQueryTimeoutAndRetry(...args),
  QueryTimeoutPresets: {
    USER_FACING: { timeoutMs: 3000, retryTimeoutMs: 2000 },
    BACKGROUND: { timeoutMs: 12000, retryTimeoutMs: 5000 },
    CRITICAL: { timeoutMs: 5000, retryTimeoutMs: 3000 },
    STANDARD: { timeoutMs: 3000, retryTimeoutMs: 2000 },
  },
}));

// Mock DataRouter
vi.mock("../../src/lib/data-router", () => ({
  DataRouter: {
    getDatabaseForRegion: vi.fn(),
  },
}));

// Mock the audit composer (TrellisAuditLogger replaces AuditLogger)
const mockAuditLoggerLog = vi.fn();
vi.mock("../../src/lib/audit-composer", () => ({
  TrellisAuditLogger: class TrellisAuditLogger {
    constructor(env: any) {}
    log = mockAuditLoggerLog;
  },
}));

describe("MediaHandler", () => {
  let handler: MediaHandler;
  let mockEnv: Env;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditLoggerLog.mockResolvedValue(undefined); // Default: audit logging succeeds

    mockDb = {
      post: {
        findMany: vi.fn(),
      },
      postMedia: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        count: vi.fn(),
      },
      mediaFile: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        count: vi.fn(),
      },
      entity: {
        findMany: vi.fn(),
      },
      entityAvatar: {
        findMany: vi.fn(),
      },
    };

    // Default mock: withQueryTimeoutAndRetry executes the query function with mockDb
    // Also ensure Entity queries succeed by default (newer ownership logic)
    mockDb.entity.findMany.mockResolvedValue([]);
    mockDb.entityAvatar.findMany.mockResolvedValue([]);
    mockWithQueryTimeoutAndRetry.mockImplementation(
      async (
        manager: any,
        region: string,
        env: any,
        queryFn: (db: any) => Promise<any>,
      ) => {
        return await queryFn(mockDb);
      },
    );

    mockEnv = {
      DATABASE_URL: "postgres://test",
      DEFAULT_REGION: "US",
      ENVIRONMENT: "dev",
      APP_DOMAIN: "https://api.test.com",
    } as Env;

    // Create handler after env is ready so Logger.getInstance is configured
    handler = new MediaHandler(mockEnv);
  });

  describe("create factory method", () => {
    it("should create MediaHandler instance", () => {
      const instance = MediaHandler.create(mockEnv);
      expect(instance).toBeInstanceOf(MediaHandler);
    });
  });

  describe("getApiDomain edge cases (via public methods)", () => {
    it("should handle invalid URL gracefully", async () => {
      const envWithInvalidUrl = {
        ...mockEnv,
        APP_DOMAIN: "not-a-valid-url",
      };

      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          return await queryFn({
            ...mockDb,
            post: { findMany: vi.fn().mockResolvedValue([]) },
          });
        },
      );

      const handler = new MediaHandler(envWithInvalidUrl);
      const result = await handler.listUserMedia(
        "user-123",
        {},
        envWithInvalidUrl,
      );

      // Should use default domain when URL is invalid
      expect(result.media).toEqual([]);
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should handle domain without api subdomain", async () => {
      const envWithoutApi = {
        ...mockEnv,
        APP_DOMAIN: "https://example.com",
      };

      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          return await queryFn({
            ...mockDb,
            post: { findMany: vi.fn().mockResolvedValue([]) },
          });
        },
      );

      const handler = new MediaHandler(envWithoutApi);
      await handler.listUserMedia("user-123", {}, envWithoutApi);

      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should handle domain with www prefix", async () => {
      const envWithWww = {
        ...mockEnv,
        APP_DOMAIN: "https://www.example.com",
      };

      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          return await queryFn({
            ...mockDb,
            post: { findMany: vi.fn().mockResolvedValue([]) },
          });
        },
      );

      const handler = new MediaHandler(envWithWww);
      await handler.listUserMedia("user-123", {}, envWithWww);

      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should use default domain when APP_DOMAIN not provided", async () => {
      const envWithoutDomain = {
        ...mockEnv,
        APP_DOMAIN: undefined,
      };

      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          return await queryFn({
            ...mockDb,
            post: { findMany: vi.fn().mockResolvedValue([]) },
          });
        },
      );

      const handler = new MediaHandler(envWithoutDomain);
      await handler.listUserMedia("user-123", {}, envWithoutDomain);

      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should handle domain with single-level domain (no subdomain)", async () => {
      const envWithSingleDomain = {
        ...mockEnv,
        APP_DOMAIN: "https://localhost",
      };

      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          return await queryFn({
            ...mockDb,
            post: { findMany: vi.fn().mockResolvedValue([]) },
          });
        },
      );

      const handler = new MediaHandler(envWithSingleDomain);
      await handler.listUserMedia("user-123", {}, envWithSingleDomain);

      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should handle domain that already has api subdomain", async () => {
      const envWithApi = {
        ...mockEnv,
        APP_DOMAIN: "https://api.example.com",
      };

      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          return await queryFn({
            ...mockDb,
            post: { findMany: vi.fn().mockResolvedValue([]) },
          });
        },
      );

      const handler = new MediaHandler(envWithApi);
      await handler.listUserMedia("user-123", {}, envWithApi);

      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should handle domain with single-level domain (parts.length < 2)", async () => {
      const envWithSingleLevel = {
        ...mockEnv,
        APP_DOMAIN: "https://localhost",
      };

      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          return await queryFn({
            ...mockDb,
            post: { findMany: vi.fn().mockResolvedValue([]) },
          });
        },
      );

      const handler = new MediaHandler(envWithSingleLevel);
      await handler.listUserMedia("user-123", {}, envWithSingleLevel);

      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });
  });

  describe("listUserMedia", () => {
    it("should return totalCount when includeTotalCount is true", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
          options?: any,
        ) => {
          const op = options?.context?.operation;

          if (op === "listUserMedia_userEntities") {
            return await queryFn({
              ...mockDb,
              entity: { findMany: vi.fn().mockResolvedValue([]) },
            });
          }

          if (op === "listUserMedia_userPosts") {
            return await queryFn({
              ...mockDb,
              post: { findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]) },
            });
          }

          if (op === "listUserMedia_postMedia") {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi
                  .fn()
                  .mockResolvedValue([
                    { mediaId: "media-1" },
                    { mediaId: "media-2" },
                  ]),
              },
            });
          }

          if (op === "listUserMedia_mediaFiles") {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "media-1",
                    contentHash: "hash1",
                    mimeType: "image/jpeg",
                    size: 100,
                    createdAt: new Date("2025-01-15T10:00:00Z"),
                    hidden: false,
                  },
                  {
                    id: "media-2",
                    contentHash: "hash2",
                    mimeType: "image/png",
                    size: 200,
                    createdAt: new Date("2025-01-16T10:00:00Z"),
                    hidden: false,
                  },
                ]),
              },
            });
          }

          if (op === "listUserMedia_postCount") {
            return await queryFn({
              ...mockDb,
              postMedia: { count: vi.fn().mockResolvedValue(1) },
            });
          }

          if (op === "listUserMedia_totalCount") {
            return await queryFn({
              ...mockDb,
              mediaFile: { count: vi.fn().mockResolvedValue(2) },
            });
          }

          return await queryFn(mockDb);
        },
      );

      const result = await handler.listUserMedia(
        "user-123",
        { limit: 50, includeTotalCount: true },
        mockEnv,
      );

      expect(result.totalCount).toBe(2);
      expect(result.media).toHaveLength(2);
    });

    it("should not return totalCount when includeTotalCount is false", async () => {
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
          options?: any,
        ) => {
          const op = options?.context?.operation;

          if (op === "listUserMedia_userEntities") {
            return await queryFn({
              ...mockDb,
              entity: { findMany: vi.fn().mockResolvedValue([]) },
            });
          }

          if (op === "listUserMedia_userPosts") {
            return await queryFn({
              ...mockDb,
              post: { findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]) },
            });
          }

          if (op === "listUserMedia_postMedia") {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([{ mediaId: "media-1" }]),
              },
            });
          }

          if (op === "listUserMedia_mediaFiles") {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "media-1",
                    contentHash: "hash1",
                    mimeType: "image/jpeg",
                    size: 100,
                    createdAt: new Date("2025-01-15T10:00:00Z"),
                    hidden: false,
                  },
                ]),
              },
            });
          }

          if (op === "listUserMedia_postCount") {
            return await queryFn({
              ...mockDb,
              postMedia: { count: vi.fn().mockResolvedValue(1) },
            });
          }

          return await queryFn(mockDb);
        },
      );

      const result = await handler.listUserMedia(
        "user-123",
        { limit: 50, includeTotalCount: false },
        mockEnv,
      );

      expect(result.totalCount).toBeUndefined();
    });

    it("should return empty array when user has no posts", async () => {
      mockDb.post.findMany.mockResolvedValue([]);

      const result = await handler.listUserMedia("user-123", {}, mockEnv);

      expect(result.media).toEqual([]);
      expect(result.cursor).toBeNull();

      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should return empty array when user has posts but no media", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 2) {
            // No media for these posts
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([]), // No media
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      const result = await handler.listUserMedia("user-123", {}, mockEnv);

      expect(result.media).toEqual([]);
      expect(result.cursor).toBeNull();
    });

    it("should return media files for user", async () => {
      mockDb.post.findMany.mockResolvedValue([
        { id: "post-1" },
        { id: "post-2" },
      ]);
      mockDb.postMedia.findMany.mockResolvedValue([
        { mediaId: "media-1" },
        { mediaId: "media-2" },
      ]);
      mockDb.mediaFile.findMany.mockResolvedValue([
        {
          id: "media-1",
          contentHash: "hash-1",
          mimeType: "image/jpeg",
          size: 1024,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          hidden: false,
        },
      ]);
      mockDb.postMedia.count.mockResolvedValue(1);

      const result = await handler.listUserMedia(
        "user-123",
        { limit: 20 },
        mockEnv,
      );

      expect(result.media).toHaveLength(1);
      expect(result.media[0].id).toBe("media-1");
      expect(result.media[0].postCount).toBe(1);

      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should filter by type photo", async () => {
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
          options?: any,
        ) => {
          const op = options?.context?.operation;

          if (op === "listUserMedia_userEntities") {
            return await queryFn({
              ...mockDb,
              entity: { findMany: vi.fn().mockResolvedValue([]) },
            });
          }

          if (op === "listUserMedia_userPosts") {
            return await queryFn({
              ...mockDb,
              post: { findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]) },
            });
          }

          if (op === "listUserMedia_postMedia") {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([{ mediaId: "media-1" }]),
              },
            });
          }

          if (op === "listUserMedia_mediaFiles") {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "media-1",
                    contentHash: "hash-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    createdAt: new Date("2024-01-01T10:00:00Z"),
                    hidden: false,
                  },
                ]),
              },
            });
          }

          if (op === "listUserMedia_postCount") {
            return await queryFn({
              ...mockDb,
              postMedia: { count: vi.fn().mockResolvedValue(1) },
            });
          }

          return await queryFn(mockDb);
        },
      );

      const result = await handler.listUserMedia(
        "user-123",
        { limit: 20, type: "photo" },
        mockEnv,
      );

      expect(result.media).toHaveLength(1);
      expect(result.media[0].mimeType).toMatch(/^image\//);
    });

    it("should filter by type video", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([{ mediaId: "media-1" }]),
              },
            });
          }
          // callCount === 3 is userEntities (entity.findMany), handled by mockDb default
          if (callCount === 4) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "media-1",
                    contentHash: "hash-1",
                    mimeType: "video/mp4",
                    size: 2048,
                    createdAt: new Date("2024-01-01T10:00:00Z"),
                    hidden: false,
                  },
                ]),
              },
            });
          }
          return await queryFn({
            ...mockDb,
            postMedia: {
              count: vi.fn().mockResolvedValue(1),
            },
          });
        },
      );

      const result = await handler.listUserMedia(
        "user-123",
        { limit: 20, type: "video" },
        mockEnv,
      );

      expect(result.media).toHaveLength(1);
      expect(result.media[0].mimeType).toMatch(/^video\//);
    });

    it("should handle cursor pagination with oldest sort", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([{ mediaId: "media-1" }]),
              },
            });
          }
          // callCount === 3 is userEntities (entity.findMany), handled by mockDb default
          if (callCount === 4) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "media-1",
                    contentHash: "hash-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    createdAt: new Date("2024-01-02T10:00:00Z"), // After cursor
                    hidden: false,
                  },
                ]),
              },
            });
          }
          return await queryFn({
            ...mockDb,
            postMedia: {
              count: vi.fn().mockResolvedValue(1),
            },
          });
        },
      );

      const result = await handler.listUserMedia(
        "user-123",
        { limit: 20, cursor: "2024-01-01T10:00:00Z", sort: "oldest" },
        mockEnv,
      );

      expect(result.media).toHaveLength(1);
      expect(result.media[0].id).toBe("media-1");
    });

    it("should handle cursor pagination with default sort (newest)", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([{ mediaId: "media-1" }]),
              },
            });
          }
          // callCount === 3 is userEntities (entity.findMany), handled by mockDb default
          if (callCount === 4) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "media-1",
                    contentHash: "hash-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    createdAt: new Date("2024-01-01T09:00:00Z"), // Before cursor
                    hidden: false,
                  },
                ]),
              },
            });
          }
          return await queryFn({
            ...mockDb,
            postMedia: {
              count: vi.fn().mockResolvedValue(1),
            },
          });
        },
      );

      const result = await handler.listUserMedia(
        "user-123",
        { limit: 20, cursor: "2024-01-01T10:00:00Z", sort: "newest" },
        mockEnv,
      );

      expect(result.media).toHaveLength(1);
      expect(result.media[0].id).toBe("media-1");
    });

    it("should use timeout/retry logic with USER_FACING preset", async () => {
      mockDb.post.findMany.mockResolvedValue([]);

      await handler.listUserMedia("user-123", {}, mockEnv);

      // Verify withQueryTimeoutAndRetry was called with USER_FACING preset
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledWith(
        mockSharedDatabaseConnectionManager,
        "US",
        mockEnv,
        expect.any(Function),
        expect.objectContaining({
          timeoutMs: 3000,
          retryTimeoutMs: 2000,
          maxRetries: 3,
          baseDelayMs: 100,
          context: expect.objectContaining({
            operation: "listUserMedia_userPosts",
          }),
        }),
      );
    });

    it("should handle database errors gracefully", async () => {
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

      await expect(
        handler.listUserMedia("user-123", {}, mockEnv),
      ).rejects.toThrow();
    });
  });

  describe("getMediaDetails", () => {
    it("should return media details successfully", async () => {
      // Setup mocks for all queries in getMediaDetails
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          // First call: findUnique media
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findUnique: vi.fn().mockResolvedValue({
                  id: "media-1",
                  contentHash: "hash-1",
                  mimeType: "image/jpeg",
                  size: 1024,
                  createdAt: new Date("2024-01-01T10:00:00Z"),
                  updatedAt: new Date("2024-01-01T10:00:00Z"),
                  hidden: false,
                  hiddenAt: null,
                  deletedAt: null,
                }),
              },
            });
          }
          // Second call: findMany user posts
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          // Third call: findFirst postMedia
          if (callCount === 3) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findFirst: vi.fn().mockResolvedValue({
                  mediaId: "media-1",
                  postId: "post-1",
                }),
              },
            });
          }
          // Fourth call: userEntities (entity.findMany), handled by mockDb default
          // Fifth call: findMany posts with media (postsWithMedia)
          if (callCount === 5) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "post-1",
                    text: "Test post",
                    createdAt: new Date("2024-01-01T10:00:00Z"),
                    visibility: "PUBLIC",
                  },
                ]),
              },
            });
          }
          // Sixth call: findMany all posts with media (checkShared)
          if (callCount === 6) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    post: { authorId: "user-123" },
                  },
                ]),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      const result = await handler.getMediaDetails(
        "media-1",
        "user-123",
        mockEnv,
      );

      expect(result.id).toBe("media-1");
      expect(result.contentHash).toBe("hash-1");
      expect(result.posts).toHaveLength(1);

      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should throw error if media not found (null)", async () => {
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce(null);

      await expect(
        handler.getMediaDetails("media-1", "user-123", mockEnv),
      ).rejects.toThrow("Media not found");
    });

    it("should throw error if media not found (no posts)", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findUnique: vi.fn().mockResolvedValue({
                  id: "media-1",
                  contentHash: "hash-1",
                  mimeType: "image/jpeg",
                  size: 1024,
                  createdAt: new Date("2024-01-01T10:00:00Z"),
                  updatedAt: new Date("2024-01-01T10:00:00Z"),
                  hidden: false,
                  hiddenAt: null,
                  deletedAt: null,
                }),
              },
            });
          }
          if (callCount === 2) {
            // User has no posts with this media
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([]), // No posts
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      await expect(
        handler.getMediaDetails("media-1", "user-123", mockEnv),
      ).rejects.toThrow("Media not found");
    });

    it("should throw error if media not found (no postMedia)", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findUnique: vi.fn().mockResolvedValue({
                  id: "media-1",
                  contentHash: "hash-1",
                  mimeType: "image/jpeg",
                  size: 1024,
                  createdAt: new Date("2024-01-01T10:00:00Z"),
                  updatedAt: new Date("2024-01-01T10:00:00Z"),
                  hidden: false,
                  hiddenAt: null,
                  deletedAt: null,
                }),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 3) {
            // postMedia not found
            return await queryFn({
              ...mockDb,
              postMedia: {
                findFirst: vi.fn().mockResolvedValue(null), // Not found
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      await expect(
        handler.getMediaDetails("media-1", "user-123", mockEnv),
      ).rejects.toThrow("Media not found");
    });

    it("should use timeout/retry logic for all queries", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findUnique: vi.fn().mockResolvedValue({
                  id: "media-1",
                  contentHash: "hash-1",
                  mimeType: "image/jpeg",
                  size: 1024,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  hidden: false,
                  hiddenAt: null,
                  deletedAt: null,
                }),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 3) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findFirst: vi.fn().mockResolvedValue({}),
              },
            });
          }
          // callCount === 4 is userEntities (entity.findMany), handled by mockDb default
          if (callCount === 5) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([]),
              },
            });
          }
          if (callCount === 6) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([]),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      await handler.getMediaDetails("media-1", "user-123", mockEnv);

      // Verify withQueryTimeoutAndRetry was called multiple times
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    // ── T11: metadata-visibility gate ──────────────────────────────────────

    /**
     * Wire up the six withQueryTimeoutAndRetry calls that getMediaDetails makes,
     * using the supplied mediaFile fixture for the first (findUnique) call.
     */
    function setupGetMediaDetailsMocks(mediaFixture: Record<string, unknown>) {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          _manager: any,
          _region: string,
          _env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findUnique: vi.fn().mockResolvedValue(mediaFixture),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              post: { findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]) },
            });
          }
          if (callCount === 3) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findFirst: vi.fn().mockResolvedValue({ mediaId: "media-1", postId: "post-1" }),
              },
            });
          }
          // callCount === 4: userEntities — handled by mockDb default (returns [])
          if (callCount === 5) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "post-1",
                    text: "test",
                    createdAt: new Date("2024-01-01"),
                    visibility: "PUBLIC",
                  },
                ]),
              },
            });
          }
          if (callCount === 6) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([{ post: { authorId: "user-123" } }]),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );
    }

    it("should omit exif/iptc/dateTaken when metadataVisible is false", async () => {
      setupGetMediaDetailsMocks({
        id: "media-1",
        contentHash: "abc123",
        mimeType: "image/jpeg",
        size: 2048,
        createdAt: new Date("2024-06-01"),
        updatedAt: new Date("2024-06-01"),
        hidden: false,
        hiddenAt: null,
        deletedAt: null,
        metadataVisible: false,
        locationVisible: false,
        exifData: { make: "Canon", model: "EOS" },
        iptcData: { caption: "A photo" },
        dateTaken: new Date("2024-05-15"),
        videoMetadata: null,
      });

      const result = await handler.getMediaDetails("media-1", "user-123", mockEnv);

      expect(result.metadataVisible).toBe(false);
      expect(result.exifData).toBeUndefined();
      expect(result.iptcData).toBeUndefined();
      expect(result.dateTaken).toBeUndefined();
    });

    it("should include exif/iptc/dateTaken when metadataVisible is true", async () => {
      setupGetMediaDetailsMocks({
        id: "media-1",
        contentHash: "abc123",
        mimeType: "image/jpeg",
        size: 2048,
        createdAt: new Date("2024-06-01"),
        updatedAt: new Date("2024-06-01"),
        hidden: false,
        hiddenAt: null,
        deletedAt: null,
        metadataVisible: true,
        locationVisible: false,
        exifData: { make: "Canon", model: "EOS" },
        iptcData: { caption: "A photo" },
        dateTaken: new Date("2024-05-15T12:00:00Z"),
        videoMetadata: null,
      });

      const result = await handler.getMediaDetails("media-1", "user-123", mockEnv);

      expect(result.metadataVisible).toBe(true);
      expect(result.exifData).toEqual({ make: "Canon", model: "EOS" });
      expect(result.iptcData).toEqual({ caption: "A photo" });
      expect(result.dateTaken).toBe("2024-05-15T12:00:00.000Z");
    });

    it("should hide metadata by default (new row: metadataVisible defaults false)", async () => {
      // Simulate a freshly-created row where metadataVisible is absent/null (DB default = false)
      setupGetMediaDetailsMocks({
        id: "media-new",
        contentHash: "def456",
        mimeType: "image/png",
        size: 512,
        createdAt: new Date("2024-07-01"),
        updatedAt: new Date("2024-07-01"),
        hidden: false,
        hiddenAt: null,
        deletedAt: null,
        metadataVisible: null,   // simulates a missing/null value (falls back to false)
        locationVisible: null,
        exifData: { software: "Example" },
        iptcData: null,
        dateTaken: null,
        videoMetadata: null,
      });

      const result = await handler.getMediaDetails("media-new", "user-123", mockEnv);

      // Default row: metadata must be hidden
      expect(result.metadataVisible).toBe(false);
      expect(result.locationVisible).toBe(false);
      expect(result.exifData).toBeUndefined();
      expect(result.iptcData).toBeUndefined();
      expect(result.dateTaken).toBeUndefined();
    });
  });

  describe("hideMedia", () => {
    it("should hide media successfully", async () => {
      // Mock getMediaDetails (6 calls) + hideMedia update (1 call)
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          // Calls 1-6: getMediaDetails queries
          if (callCount <= 6) {
            if (callCount === 1) {
              return await queryFn({
                ...mockDb,
                mediaFile: {
                  findUnique: vi.fn().mockResolvedValue({
                    id: "media-1",
                    contentHash: "hash-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    hidden: false,
                    hiddenAt: null,
                    deletedAt: null,
                  }),
                },
              });
            }
            if (callCount === 2) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
                },
              });
            }
            if (callCount === 3) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findFirst: vi.fn().mockResolvedValue({}),
                },
              });
            }
            // callCount === 4 is userEntities (entity.findMany), handled by mockDb default
            if (callCount === 5) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
            if (callCount === 6) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
          }
          // Call 7: hideMedia update
          if (callCount === 7) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                update: vi.fn().mockResolvedValue({
                  id: "media-1",
                  hidden: true,
                  hiddenAt: new Date("2024-01-01T10:00:00Z"),
                }),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      const result = await handler.hideMedia("media-1", "user-123", mockEnv);

      expect(result.hidden).toBe(true);
      expect(result.hiddenAt).toBeDefined();

      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should throw error if media is already hidden", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findUnique: vi.fn().mockResolvedValue({
                  id: "media-1",
                  contentHash: "hash-1",
                  mimeType: "image/jpeg",
                  size: 1024,
                  createdAt: new Date("2024-01-01T10:00:00Z"),
                  updatedAt: new Date("2024-01-01T10:00:00Z"),
                  hidden: true, // Already hidden
                  hiddenAt: new Date("2024-01-01T09:00:00Z"),
                  deletedAt: null,
                }),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 3) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findFirst: vi.fn().mockResolvedValue({
                  mediaId: "media-1",
                  postId: "post-1",
                }),
              },
            });
          }
          // callCount === 4 is userEntities (entity.findMany), handled by mockDb default
          if (callCount === 5) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([]),
              },
            });
          }
          if (callCount === 6) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([]),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      await expect(
        handler.hideMedia("media-1", "user-123", mockEnv),
      ).rejects.toThrow("Media is already hidden");
    });

    it("should throw error if media is deleted", async () => {
      // Mock getMediaDetails to return deleted media
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findUnique: vi.fn().mockResolvedValue({
                  id: "media-1",
                  contentHash: "hash-1",
                  mimeType: "image/jpeg",
                  size: 1024,
                  createdAt: new Date("2024-01-01T10:00:00Z"),
                  updatedAt: new Date("2024-01-01T10:00:00Z"),
                  hidden: false,
                  hiddenAt: null,
                  deletedAt: new Date("2024-01-01T11:00:00Z"), // Deleted
                }),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 3) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findFirst: vi.fn().mockResolvedValue({}),
              },
            });
          }
          // callCount === 4 is userEntities (entity.findMany), handled by mockDb default
          if (callCount === 5) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([]),
              },
            });
          }
          if (callCount === 6) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([]),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      await expect(
        handler.hideMedia("media-1", "user-123", mockEnv),
      ).rejects.toThrow("Cannot hide deleted media");
    });

    it("should handle audit logging failure gracefully in hideMedia", async () => {
      mockAuditLoggerLog.mockRejectedValueOnce(
        new Error("Audit logging failed"),
      );

      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount <= 6) {
            // getMediaDetails queries
            if (callCount === 1) {
              return await queryFn({
                ...mockDb,
                mediaFile: {
                  findUnique: vi.fn().mockResolvedValue({
                    id: "media-1",
                    contentHash: "hash-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    createdAt: new Date("2024-01-01T10:00:00Z"),
                    updatedAt: new Date("2024-01-01T10:00:00Z"),
                    hidden: false,
                    hiddenAt: null,
                    deletedAt: null,
                  }),
                },
              });
            }
            if (callCount === 2) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
                },
              });
            }
            if (callCount === 3) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findFirst: vi.fn().mockResolvedValue({}),
                },
              });
            }
            // callCount === 4 is userEntities (entity.findMany), handled by mockDb default
            if (callCount === 5) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
            if (callCount === 6) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
          }
          // hideMedia update
          if (callCount === 7) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                update: vi.fn().mockResolvedValue({
                  id: "media-1",
                  hidden: true,
                  hiddenAt: new Date("2024-01-01T10:00:00Z"),
                }),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      const result = await handler.hideMedia("media-1", "user-123", mockEnv);

      expect(result.hidden).toBe(true);
      // Operation should complete even if audit logging fails
      expect(mockAuditLoggerLog).toHaveBeenCalled();
    });

    it("should use timeout/retry logic", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount <= 6) {
            // getMediaDetails queries
            if (callCount === 1) {
              return await queryFn({
                ...mockDb,
                mediaFile: {
                  findUnique: vi.fn().mockResolvedValue({
                    id: "media-1",
                    contentHash: "hash-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    createdAt: new Date("2024-01-01T10:00:00Z"),
                    updatedAt: new Date("2024-01-01T10:00:00Z"),
                    hidden: false,
                    hiddenAt: null,
                    deletedAt: null,
                  }),
                },
              });
            }
            if (callCount === 2) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
                },
              });
            }
            if (callCount === 3) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findFirst: vi.fn().mockResolvedValue({}),
                },
              });
            }
            // callCount === 4 is userEntities (entity.findMany), handled by mockDb default
            if (callCount === 5) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
            if (callCount === 6) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
          }
          // hideMedia update
          if (callCount === 7) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                update: vi.fn().mockResolvedValue({
                  id: "media-1",
                  hidden: true,
                  hiddenAt: new Date(),
                }),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      await handler.hideMedia("media-1", "user-123", mockEnv);

      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledWith(
        mockSharedDatabaseConnectionManager,
        "US",
        mockEnv,
        expect.any(Function),
        expect.objectContaining({
          context: expect.objectContaining({
            operation: "hideMedia",
          }),
        }),
      );
    });
  });

  describe("unhideMedia", () => {
    it("should unhide media successfully", async () => {
      // Mock getMediaDetails (6 calls) + unhideMedia update (1 call)
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount <= 6) {
            // getMediaDetails queries
            if (callCount === 1) {
              return await queryFn({
                ...mockDb,
                mediaFile: {
                  findUnique: vi.fn().mockResolvedValue({
                    id: "media-1",
                    contentHash: "hash-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    createdAt: new Date("2024-01-01T10:00:00Z"),
                    updatedAt: new Date("2024-01-01T10:00:00Z"),
                    hidden: true,
                    hiddenAt: new Date("2024-01-01T09:00:00Z"),
                    deletedAt: null,
                  }),
                },
              });
            }
            if (callCount === 2) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
                },
              });
            }
            if (callCount === 3) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findFirst: vi.fn().mockResolvedValue({}),
                },
              });
            }
            // callCount === 4 is userEntities (entity.findMany), handled by mockDb default
            if (callCount === 5) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
            if (callCount === 6) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
          }
          // unhideMedia update
          if (callCount === 7) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                update: vi.fn().mockResolvedValue({
                  id: "media-1",
                  hidden: false,
                  hiddenAt: null,
                }),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      const result = await handler.unhideMedia("media-1", "user-123", mockEnv);

      expect(result.hidden).toBe(false);
      expect(result.hiddenAt).toBeNull();

      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should throw error if media is deleted when trying to unhide", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findUnique: vi.fn().mockResolvedValue({
                  id: "media-1",
                  contentHash: "hash-1",
                  mimeType: "image/jpeg",
                  size: 1024,
                  createdAt: new Date("2024-01-01T10:00:00Z"),
                  updatedAt: new Date("2024-01-01T10:00:00Z"),
                  hidden: true,
                  hiddenAt: new Date("2024-01-01T09:00:00Z"),
                  deletedAt: new Date("2024-01-01T11:00:00Z"), // Deleted
                }),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 3) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findFirst: vi.fn().mockResolvedValue({
                  mediaId: "media-1",
                  postId: "post-1",
                }),
              },
            });
          }
          // callCount === 4 is userEntities (entity.findMany), handled by mockDb default
          if (callCount === 5) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([]),
              },
            });
          }
          if (callCount === 6) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([]),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      await expect(
        handler.unhideMedia("media-1", "user-123", mockEnv),
      ).rejects.toThrow("Cannot unhide deleted media");
    });

    it("should throw error if media is not hidden", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findUnique: vi.fn().mockResolvedValue({
                  id: "media-1",
                  contentHash: "hash-1",
                  mimeType: "image/jpeg",
                  size: 1024,
                  createdAt: new Date("2024-01-01T10:00:00Z"),
                  updatedAt: new Date("2024-01-01T10:00:00Z"),
                  hidden: false, // Not hidden
                  hiddenAt: null,
                  deletedAt: null,
                }),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 3) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findFirst: vi.fn().mockResolvedValue({}),
              },
            });
          }
          // callCount === 4 is userEntities (entity.findMany), handled by mockDb default
          if (callCount === 5) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([]),
              },
            });
          }
          if (callCount === 6) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([]),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      await expect(
        handler.unhideMedia("media-1", "user-123", mockEnv),
      ).rejects.toThrow("Media is not hidden");
    });

    it("should handle audit logging failure gracefully in unhideMedia", async () => {
      mockAuditLoggerLog.mockRejectedValueOnce(
        new Error("Audit logging failed"),
      );

      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount <= 6) {
            // getMediaDetails queries
            if (callCount === 1) {
              return await queryFn({
                ...mockDb,
                mediaFile: {
                  findUnique: vi.fn().mockResolvedValue({
                    id: "media-1",
                    contentHash: "hash-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    createdAt: new Date("2024-01-01T10:00:00Z"),
                    updatedAt: new Date("2024-01-01T10:00:00Z"),
                    hidden: true,
                    hiddenAt: new Date("2024-01-01T09:00:00Z"),
                    deletedAt: null,
                  }),
                },
              });
            }
            if (callCount === 2) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
                },
              });
            }
            if (callCount === 3) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findFirst: vi.fn().mockResolvedValue({}),
                },
              });
            }
            // callCount === 4 is userEntities (entity.findMany), handled by mockDb default
            if (callCount === 5) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
            if (callCount === 6) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
          }
          // unhideMedia update
          if (callCount === 7) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                update: vi.fn().mockResolvedValue({
                  id: "media-1",
                  hidden: false,
                  hiddenAt: null,
                }),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      const result = await handler.unhideMedia("media-1", "user-123", mockEnv);

      expect(result.hidden).toBe(false);
      // Operation should complete even if audit logging fails
      expect(mockAuditLoggerLog).toHaveBeenCalled();
    });

    it("should use timeout/retry logic", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount <= 6) {
            // getMediaDetails queries
            if (callCount === 1) {
              return await queryFn({
                ...mockDb,
                mediaFile: {
                  findUnique: vi.fn().mockResolvedValue({
                    id: "media-1",
                    contentHash: "hash-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    createdAt: new Date("2024-01-01T10:00:00Z"),
                    updatedAt: new Date("2024-01-01T10:00:00Z"),
                    hidden: true,
                    hiddenAt: new Date("2024-01-01T09:00:00Z"),
                    deletedAt: null,
                  }),
                },
              });
            }
            if (callCount === 2) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
                },
              });
            }
            if (callCount === 3) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findFirst: vi.fn().mockResolvedValue({}),
                },
              });
            }
            // callCount === 4 is userEntities (entity.findMany), handled by mockDb default
            if (callCount === 5) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
            if (callCount === 6) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
          }
          // unhideMedia update
          if (callCount === 7) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                update: vi.fn().mockResolvedValue({
                  id: "media-1",
                  hidden: false,
                  hiddenAt: null,
                }),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      await handler.unhideMedia("media-1", "user-123", mockEnv);

      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledWith(
        mockSharedDatabaseConnectionManager,
        "US",
        mockEnv,
        expect.any(Function),
        expect.objectContaining({
          context: expect.objectContaining({
            operation: "unhideMedia",
          }),
        }),
      );
    });
  });

  describe("deleteMedia", () => {
    it("should delete media successfully", async () => {
      // Mock getMediaDetails (6 calls) + deleteMedia checkShared (1 call) + update (1 call)
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount <= 6) {
            // getMediaDetails queries
            if (callCount === 1) {
              return await queryFn({
                ...mockDb,
                mediaFile: {
                  findUnique: vi.fn().mockResolvedValue({
                    id: "media-1",
                    contentHash: "hash-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    createdAt: new Date("2024-01-01T10:00:00Z"),
                    updatedAt: new Date("2024-01-01T10:00:00Z"),
                    hidden: false,
                    hiddenAt: null,
                    deletedAt: null,
                  }),
                },
              });
            }
            if (callCount === 2) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
                },
              });
            }
            if (callCount === 3) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findFirst: vi.fn().mockResolvedValue({}),
                },
              });
            }
            // callCount === 4 is userEntities (entity.findMany), handled by mockDb default
            if (callCount === 5) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
            if (callCount === 6) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
          }
          // deleteMedia checkShared
          if (callCount === 7) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    post: { authorId: "user-123" },
                  },
                ]),
              },
            });
          }
          // deleteMedia update
          if (callCount === 8) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                update: vi.fn().mockResolvedValue({
                  id: "media-1",
                  deletedAt: new Date(),
                }),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      await handler.deleteMedia("media-1", "user-123", mockEnv);

      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should hide instead of delete if media is shared", async () => {
      // Mock getMediaDetails (6 calls) + deleteMedia checkShared (1 call) + hideMedia (7 calls)
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount <= 6) {
            // getMediaDetails queries
            if (callCount === 1) {
              return await queryFn({
                ...mockDb,
                mediaFile: {
                  findUnique: vi.fn().mockResolvedValue({
                    id: "media-1",
                    contentHash: "hash-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    createdAt: new Date("2024-01-01T10:00:00Z"),
                    updatedAt: new Date("2024-01-01T10:00:00Z"),
                    hidden: false,
                    hiddenAt: null,
                    deletedAt: null,
                  }),
                },
              });
            }
            if (callCount === 2) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
                },
              });
            }
            if (callCount === 3) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findFirst: vi.fn().mockResolvedValue({}),
                },
              });
            }
            // callCount === 4 is userEntities (entity.findMany), handled by mockDb default
            if (callCount === 5) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
            if (callCount === 6) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
          }
          // deleteMedia checkShared - has other user's posts
          if (callCount === 7) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    post: { authorId: "user-123" },
                  },
                  {
                    post: { authorId: "user-456" }, // Other user
                  },
                ]),
              },
            });
          }
          // hideMedia queries (calls 8-14)
          if (callCount >= 8 && callCount <= 14) {
            const hideCall = callCount - 7;
            if (hideCall === 1) {
              return await queryFn({
                ...mockDb,
                mediaFile: {
                  findUnique: vi.fn().mockResolvedValue({
                    id: "media-1",
                    contentHash: "hash-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    createdAt: new Date("2024-01-01T10:00:00Z"),
                    updatedAt: new Date("2024-01-01T10:00:00Z"),
                    hidden: false,
                    hiddenAt: null,
                    deletedAt: null,
                  }),
                },
              });
            }
            if (hideCall === 2) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
                },
              });
            }
            if (hideCall === 3) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findFirst: vi.fn().mockResolvedValue({}),
                },
              });
            }
            // hideCall === 4 is userEntities (entity.findMany), handled by mockDb default
            if (hideCall === 5) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
            if (hideCall === 6) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
            if (hideCall === 7) {
              return await queryFn({
                ...mockDb,
                mediaFile: {
                  update: vi.fn().mockResolvedValue({
                    id: "media-1",
                    hidden: true,
                    hiddenAt: new Date(),
                  }),
                },
              });
            }
          }
          return await queryFn(mockDb);
        },
      );

      await expect(
        handler.deleteMedia("media-1", "user-123", mockEnv),
      ).rejects.toThrow("Media is used by other users");
    });

    it("should use timeout/retry logic", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount <= 6) {
            // getMediaDetails queries
            if (callCount === 1) {
              return await queryFn({
                ...mockDb,
                mediaFile: {
                  findUnique: vi.fn().mockResolvedValue({
                    id: "media-1",
                    contentHash: "hash-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    createdAt: new Date("2024-01-01T10:00:00Z"),
                    updatedAt: new Date("2024-01-01T10:00:00Z"),
                    hidden: false,
                    hiddenAt: null,
                    deletedAt: null,
                  }),
                },
              });
            }
            if (callCount === 2) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
                },
              });
            }
            if (callCount === 3) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findFirst: vi.fn().mockResolvedValue({}),
                },
              });
            }
            // callCount === 4 is userEntities (entity.findMany), handled by mockDb default
            if (callCount === 5) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
            if (callCount === 6) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
          }
          // deleteMedia checkShared
          if (callCount === 7) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi
                  .fn()
                  .mockResolvedValue([{ post: { authorId: "user-123" } }]),
              },
            });
          }
          // deleteMedia update
          if (callCount === 8) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                update: vi.fn().mockResolvedValue({
                  id: "media-1",
                  contentHash: "hash-1",
                  mimeType: "image/jpeg",
                  size: 1024,
                  createdAt: new Date("2024-01-01T10:00:00Z"),
                  updatedAt: new Date("2024-01-01T10:00:00Z"),
                  hidden: false,
                  hiddenAt: null,
                  deletedAt: new Date(),
                }),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      await handler.deleteMedia("media-1", "user-123", mockEnv);

      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledWith(
        mockSharedDatabaseConnectionManager,
        "US",
        mockEnv,
        expect.any(Function),
        expect.objectContaining({
          context: expect.objectContaining({
            operation: "deleteMedia",
          }),
        }),
      );
    });

    it("should throw error if media is already deleted", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            // getMediaDetails - findUnique (returns media with deletedAt)
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findUnique: vi.fn().mockResolvedValue({
                  id: "media-1",
                  contentHash: "hash-1",
                  mimeType: "image/jpeg",
                  size: 1024,
                  createdAt: new Date("2024-01-01T10:00:00Z"),
                  updatedAt: new Date("2024-01-01T10:00:00Z"),
                  hidden: false,
                  hiddenAt: null,
                  deletedAt: new Date("2024-01-01T11:00:00Z"), // Already deleted
                }),
              },
            });
          }
          if (callCount === 2) {
            // getMediaDetails - findMany posts
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 3) {
            // getMediaDetails - findFirst postMedia
            return await queryFn({
              ...mockDb,
              postMedia: {
                findFirst: vi.fn().mockResolvedValue({
                  mediaId: "media-1",
                  postId: "post-1",
                }),
              },
            });
          }
          // callCount === 4 is userEntities (entity.findMany), handled by mockDb default
          if (callCount === 5) {
            // getMediaDetails - findMany posts with details (postsWithMedia)
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "post-1",
                    text: "Test post",
                    visibility: "PUBLIC",
                    createdAt: new Date("2024-01-01T10:00:00Z"),
                  },
                ]),
              },
            });
          }
          if (callCount === 6) {
            // getMediaDetails - findMany postMedia (checkShared)
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    post: { authorId: "user-123" },
                  },
                ]),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      await expect(
        handler.deleteMedia("media-1", "user-123", mockEnv),
      ).rejects.toThrow("Media is already deleted");
    });

    // TRIAGE(AR14): fix — no reason was documented for this skip (undocumented
    // at introduction, see git blame). The mock is a real, detailed call-count
    // sequence, not a stub — looks like it broke under a prior refactor of the
    // delete-media query path. Needs owner investigation: either repair the
    // mock sequence or confirm audit-log-failure-during-delete is covered
    // another way before deleting.
    it.skip("should handle audit logging failure gracefully when deleting shared media", async () => {
      // Mock audit logging to fail
      mockAuditLoggerLog.mockRejectedValueOnce(
        new Error("Audit logging failed"),
      );

      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount <= 5) {
            // getMediaDetails queries
            if (callCount === 1) {
              return await queryFn({
                ...mockDb,
                mediaFile: {
                  findUnique: vi.fn().mockResolvedValue({
                    id: "media-1",
                    contentHash: "hash-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    createdAt: new Date("2024-01-01T10:00:00Z"),
                    updatedAt: new Date("2024-01-01T10:00:00Z"),
                    hidden: false,
                    hiddenAt: null,
                    deletedAt: null,
                  }),
                },
              });
            }
            if (callCount === 2) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
                },
              });
            }
            if (callCount === 3) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findFirst: vi.fn().mockResolvedValue({}),
                },
              });
            }
            if (callCount === 4) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([
                    {
                      id: "post-1",
                      text: "Test post",
                      visibility: "PUBLIC",
                      createdAt: new Date("2024-01-01T10:00:00Z"),
                    },
                  ]),
                },
              });
            }
            if (callCount === 5) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findMany: vi.fn().mockResolvedValue([
                    {
                      postId: "post-1",
                      mediaId: "media-1",
                    },
                  ]),
                },
              });
            }
          }
          // deleteMedia checkShared - has other user's posts
          if (callCount === 6) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    post: { authorId: "user-123" },
                  },
                  {
                    post: { authorId: "user-456" }, // Other user
                  },
                ]),
              },
            });
          }
          if (callCount >= 7 && callCount <= 12) {
            // hideMedia queries (6 calls)
            const hideCall = callCount - 6;
            if (hideCall === 1) {
              return await queryFn({
                ...mockDb,
                mediaFile: {
                  findUnique: vi.fn().mockResolvedValue({
                    id: "media-1",
                    contentHash: "hash-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    createdAt: new Date("2024-01-01T10:00:00Z"),
                    updatedAt: new Date("2024-01-01T10:00:00Z"),
                    hidden: false,
                    hiddenAt: null,
                    deletedAt: null,
                  }),
                },
              });
            }
            if (hideCall === 2) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
                },
              });
            }
            if (hideCall === 3) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findFirst: vi.fn().mockResolvedValue({}),
                },
              });
            }
            if (hideCall === 4) {
              return await queryFn({
                ...mockDb,
                post: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
            if (hideCall === 5) {
              return await queryFn({
                ...mockDb,
                postMedia: {
                  findMany: vi.fn().mockResolvedValue([]),
                },
              });
            }
            if (hideCall === 6) {
              return await queryFn({
                ...mockDb,
                mediaFile: {
                  update: vi.fn().mockResolvedValue({
                    id: "media-1",
                    hidden: true,
                    hiddenAt: new Date(),
                  }),
                },
              });
            }
          }
          return await queryFn(mockDb);
        },
      );

      await expect(
        handler.deleteMedia("media-1", "user-123", mockEnv),
      ).rejects.toThrow("Media is used by other users");

      // Audit logging failure should be logged but not cause operation to fail
      // The error is caught and logged, but the operation continues
      // We can't easily verify logger.warn was called without accessing the instance,
      // but the operation should complete (throw the expected error) even if audit logging fails
    });

    it("should handle audit logging failure gracefully when deleting media", async () => {
      // Mock audit logging to fail
      mockAuditLoggerLog.mockRejectedValueOnce(
        new Error("Audit logging failed"),
      );

      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            // getMediaDetails - findUnique
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findUnique: vi.fn().mockResolvedValue({
                  id: "media-1",
                  contentHash: "hash-1",
                  mimeType: "image/jpeg",
                  size: 1024,
                  createdAt: new Date("2024-01-01T10:00:00Z"),
                  updatedAt: new Date("2024-01-01T10:00:00Z"),
                  hidden: false,
                  hiddenAt: null,
                  deletedAt: null,
                }),
              },
            });
          }
          if (callCount === 2) {
            // getMediaDetails - findMany posts
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 3) {
            // getMediaDetails - findFirst postMedia
            return await queryFn({
              ...mockDb,
              postMedia: {
                findFirst: vi.fn().mockResolvedValue({
                  mediaId: "media-1",
                  postId: "post-1",
                }),
              },
            });
          }
          // callCount === 4 is userEntities (entity.findMany), handled by mockDb default
          if (callCount === 5) {
            // getMediaDetails - findMany posts with details (postsWithMedia)
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "post-1",
                    text: "Test post",
                    visibility: "PUBLIC",
                    createdAt: new Date("2024-01-01T10:00:00Z"),
                  },
                ]),
              },
            });
          }
          if (callCount === 6) {
            // getMediaDetails - findMany postMedia (checkShared)
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    post: { authorId: "user-123" },
                  },
                ]),
              },
            });
          }
          if (callCount === 7) {
            // deleteMedia checkShared - media is not shared
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    post: { authorId: "user-123" },
                  },
                ]),
              },
            });
          }
          if (callCount === 8) {
            // Delete call
            return await queryFn({
              ...mockDb,
              mediaFile: {
                update: vi.fn().mockResolvedValue({
                  id: "media-1",
                  deletedAt: new Date(),
                }),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      // Operation should complete successfully even if audit logging fails
      await handler.deleteMedia("media-1", "user-123", mockEnv);

      // Verify that audit logging was attempted (even though it failed)
      expect(mockAuditLoggerLog).toHaveBeenCalled();
    });
  });

  describe("listUserMediaGrouped", () => {
    it("should return empty groups when user has no posts", async () => {
      mockDb.post.findMany.mockResolvedValue([]);

      const result = await handler.listUserMediaGrouped(
        "user-123",
        "month",
        {},
        mockEnv,
      );

      expect(result.groups).toEqual([]);
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should group media by month", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          // First call: user posts
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          // Second call: post media
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi
                  .fn()
                  .mockResolvedValue([
                    { mediaId: "media-1" },
                    { mediaId: "media-2" },
                  ]),
              },
            });
          }
          // Third call: media files
          if (callCount === 3) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "media-1",
                    contentHash: "hash-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    createdAt: new Date("2025-01-15T10:00:00Z"),
                    hidden: false,
                  },
                  {
                    id: "media-2",
                    contentHash: "hash-2",
                    mimeType: "image/png",
                    size: 2048,
                    createdAt: new Date("2025-01-20T10:00:00Z"),
                    hidden: false,
                  },
                ]),
              },
            });
          }
          // Subsequent calls: post counts
          if (callCount >= 4) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                count: vi.fn().mockResolvedValue(1),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      const result = await handler.listUserMediaGrouped(
        "user-123",
        "month",
        {},
        mockEnv,
      );

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].period).toBe("2025-01");
      expect(result.groups[0].displayName).toContain("January 2025");
      expect(result.groups[0].count).toBe(2);
      expect(result.groups[0].media).toHaveLength(2);
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should group media by year", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi
                  .fn()
                  .mockResolvedValue([
                    { mediaId: "media-1" },
                    { mediaId: "media-2" },
                  ]),
              },
            });
          }
          if (callCount === 3) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "media-1",
                    contentHash: "hash-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    createdAt: new Date("2025-01-15T10:00:00Z"),
                    hidden: false,
                  },
                  {
                    id: "media-2",
                    contentHash: "hash-2",
                    mimeType: "image/png",
                    size: 2048,
                    createdAt: new Date("2024-12-20T10:00:00Z"),
                    hidden: false,
                  },
                ]),
              },
            });
          }
          if (callCount >= 4) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                count: vi.fn().mockResolvedValue(1),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      const result = await handler.listUserMediaGrouped(
        "user-123",
        "year",
        {},
        mockEnv,
      );

      expect(result.groups).toHaveLength(2);
      expect(result.groups[0].period).toBe("2025");
      expect(result.groups[1].period).toBe("2024");
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should filter hidden media when includeHidden is false", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([{ mediaId: "media-1" }]),
              },
            });
          }
          if (callCount === 3) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue([]), // No visible media
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      const result = await handler.listUserMediaGrouped(
        "user-123",
        "month",
        { includeHidden: false },
        mockEnv,
      );

      expect(result.groups).toEqual([]);
    });

    it("should filter by type (photo)", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi
                  .fn()
                  .mockResolvedValue([
                    { mediaId: "media-1" },
                    { mediaId: "media-2" },
                  ]),
              },
            });
          }
          if (callCount === 3) {
            // When type='photo', the where clause filters to only image/* mimeTypes
            // So the mock should return only photo media
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "media-1",
                    contentHash: "hash1",
                    mimeType: "image/jpeg",
                    size: 100,
                    createdAt: new Date("2025-01-15T10:00:00Z"),
                    hidden: false,
                  },
                  // media-2 (video) is filtered out by the where clause
                ]),
              },
            });
          }
          // postCount query for the media item
          return await queryFn({
            ...mockDb,
            postMedia: {
              count: vi.fn().mockResolvedValue(1),
            },
          });
        },
      );

      const result = await handler.listUserMediaGrouped(
        "user-123",
        "month",
        { type: "photo" },
        mockEnv,
      );

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].media).toHaveLength(1);
      expect(result.groups[0].media[0].mimeType).toMatch(/^image\//);
    });

    it("should filter by type (video)", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi
                  .fn()
                  .mockResolvedValue([
                    { mediaId: "media-1" },
                    { mediaId: "media-2" },
                  ]),
              },
            });
          }
          if (callCount === 3) {
            // When type='video', the where clause filters to only video/* mimeTypes
            // So the mock should return only video media (filtered at DB level)
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "media-2",
                    contentHash: "hash2",
                    mimeType: "video/mp4",
                    size: 200,
                    createdAt: new Date("2025-01-16T10:00:00Z"),
                    hidden: false,
                  },
                  // media-1 (photo) is filtered out by the where clause
                ]),
              },
            });
          }
          // postCount query for the media item
          return await queryFn({
            ...mockDb,
            postMedia: {
              count: vi.fn().mockResolvedValue(1),
            },
          });
        },
      );

      const result = await handler.listUserMediaGrouped(
        "user-123",
        "month",
        { type: "video" },
        mockEnv,
      );

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].media).toHaveLength(1);
      expect(result.groups[0].media[0].mimeType).toMatch(/^video\//);
    });

    it("should handle limit truncation warning", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([{ mediaId: "media-1" }]),
              },
            });
          }
          if (callCount === 3) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "media-1",
                    contentHash: "hash1",
                    mimeType: "image/jpeg",
                    size: 100,
                    createdAt: new Date("2025-01-15T10:00:00Z"),
                    hidden: false,
                  },
                ]),
              },
            });
          }
          return await queryFn({
            ...mockDb,
            postMedia: {
              count: vi.fn().mockResolvedValue(1),
            },
          });
        },
      );

      const result = await handler.listUserMediaGrouped(
        "user-123",
        "month",
        { limit: 20000 }, // Exceeds max limit of 10000
        mockEnv,
      );

      expect(result.truncated).toBe(true);
      expect(result.warning).toContain("Limit was capped");
    });

    it("should handle limit truncation warning", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([{ mediaId: "media-1" }]),
              },
            });
          }
          if (callCount === 3) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "media-1",
                    contentHash: "hash1",
                    mimeType: "image/jpeg",
                    size: 100,
                    createdAt: new Date("2025-01-15T10:00:00Z"),
                    hidden: false,
                  },
                ]),
              },
            });
          }
          return await queryFn({
            ...mockDb,
            postMedia: {
              count: vi.fn().mockResolvedValue(1),
            },
          });
        },
      );

      const result = await handler.listUserMediaGrouped(
        "user-123",
        "month",
        { limit: 20000 }, // Exceeds max limit of 10000
        mockEnv,
      );

      expect(result.truncated).toBe(true);
      expect(result.warning).toContain("Limit was capped");
    });
  });

  describe("getUserMediaStats", () => {
    it("should return zero stats when user has no posts", async () => {
      mockDb.post.findMany.mockResolvedValue([]);

      const result = await handler.getUserMediaStats("user-123", {}, mockEnv);

      expect(result.totalCount).toBe(0);
      expect(result.photoCount).toBe(0);
      expect(result.videoCount).toBe(0);
      expect(result.hiddenCount).toBe(0);
      expect(result.totalSize).toBe(0);
      expect(result.oldestMedia).toBeNull();
      expect(result.newestMedia).toBeNull();
      expect(result.byMonth).toEqual([]);
    });

    it("should calculate correct statistics", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi
                  .fn()
                  .mockResolvedValue([
                    { mediaId: "media-1" },
                    { mediaId: "media-2" },
                  ]),
              },
            });
          }
          // callCount === 3 is userEntities (entity.findMany), handled by mockDb default
          if (callCount === 4) {
            // When includeHidden=false (default), the where clause filters out hidden media
            // So only non-hidden media is returned
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "media-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    hidden: false,
                    createdAt: new Date("2025-01-15T10:00:00Z"),
                  },
                  // media-2 is hidden, so it's excluded when includeHidden=false
                ]),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      const result = await handler.getUserMediaStats("user-123", {}, mockEnv);

      // When includeHidden=false (default), hidden media is excluded from the query
      expect(result.totalCount).toBe(1); // Only non-hidden media
      expect(result.photoCount).toBe(1);
      expect(result.videoCount).toBe(0); // Video is hidden, so not in results
      expect(result.hiddenCount).toBe(0); // No hidden media in the results
      expect(result.totalSize).toBe(1024); // Only non-hidden media size
      expect(result.newestMedia).toBeTruthy();
      expect(result.oldestMedia).toBeTruthy();
      expect(result.byMonth.length).toBeGreaterThan(0);
    });

    it("should filter by type when specified", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([{ mediaId: "media-1" }]),
              },
            });
          }
          // callCount === 3 is userEntities (entity.findMany), handled by mockDb default
          if (callCount === 4) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "media-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    hidden: false,
                    createdAt: new Date("2025-01-15T10:00:00Z"),
                  },
                ]),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      const result = await handler.getUserMediaStats(
        "user-123",
        { type: "photo" },
        mockEnv,
      );

      expect(result.photoCount).toBe(1);
      expect(result.videoCount).toBe(0);
    });

    it("should include hidden media when includeHidden is true", async () => {
      let callCount = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          callCount++;
          if (callCount === 1) {
            return await queryFn({
              ...mockDb,
              post: {
                findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]),
              },
            });
          }
          if (callCount === 2) {
            return await queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi.fn().mockResolvedValue([{ mediaId: "media-1" }]),
              },
            });
          }
          // callCount === 3 is userEntities (entity.findMany), handled by mockDb default
          if (callCount === 4) {
            return await queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "media-1",
                    mimeType: "image/jpeg",
                    size: 1024,
                    hidden: true,
                    createdAt: new Date("2025-01-15T10:00:00Z"),
                  },
                ]),
              },
            });
          }
          return await queryFn(mockDb);
        },
      );

      const result = await handler.getUserMediaStats(
        "user-123",
        { includeHidden: true },
        mockEnv,
      );

      expect(result.totalCount).toBe(1);
      expect(result.hiddenCount).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Targeted branch-coverage additions (appended)
  // ─────────────────────────────────────────────────────────────────────────

  describe("constructor / DEFAULT_REGION fallback (branch coverage)", () => {
    it("constructs without env (logger stub branch)", () => {
      // env undefined -> logger = {} as Logger (line 16 false side)
      const h = new MediaHandler();
      expect(h).toBeInstanceOf(MediaHandler);
    });

    it("falls back to 'EU' when DEFAULT_REGION is falsy (no request)", async () => {
      // env.DEFAULT_REGION = "" exercises the `|| "EU"` right side of the
      // region ternary in every method (binary-expr[1] at 98/393/779/...).
      const envNoRegion = { ...mockEnv, DEFAULT_REGION: "" } as Env;
      const h = new MediaHandler(envNoRegion);
      mockDb.post.findMany.mockResolvedValue([]);

      const result = await h.getUserMediaStats("user-123", {}, envNoRegion);
      expect(result.totalCount).toBe(0);
      // region used should be the EU fallback
      const regionArg = mockWithQueryTimeoutAndRetry.mock.calls[0][1];
      expect(regionArg).toBe("EU");
    });
  });

  // ── getUserMediaStats: avatar-URL classification (lines 489-526) ──────────
  describe("getUserMediaStats avatar classification (branch coverage)", () => {
    // Wires: 1=userPosts, 2=postMedia, 3=userEntities, then conditionally
    // 4=avatarMedia (only if a contentHash was extracted), then mediaRows.
    function wireStats(opts: {
      entities: any[];
      avatarMediaRows?: any[]; // returned by mediaFile.findMany when hashes>0
      mediaRows: any[]; // final mediaRows
      postMedia?: any[];
    }) {
      const hasHashCall = (opts.avatarMediaRows ?? null) !== null;
      let call = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          _m: any,
          _r: string,
          _e: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          call++;
          if (call === 1) {
            return queryFn({
              ...mockDb,
              post: { findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]) },
            });
          }
          if (call === 2) {
            return queryFn({
              ...mockDb,
              postMedia: {
                findMany: vi
                  .fn()
                  .mockResolvedValue(opts.postMedia ?? []),
              },
            });
          }
          if (call === 3) {
            return queryFn({
              ...mockDb,
              entity: { findMany: vi.fn().mockResolvedValue(opts.entities) },
            });
          }
          if (hasHashCall && call === 4) {
            return queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue(opts.avatarMediaRows),
              },
            });
          }
          // mediaRows fetch is call 4 (no hash call) or call 5 (with hash call)
          const mediaRowsCall = hasHashCall ? 5 : 4;
          if (call === mediaRowsCall) {
            return queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue(opts.mediaRows),
              },
            });
          }
          return queryFn(mockDb);
        },
      );
    }

    const baseMediaRow = {
      id: "cmrow00000000000000000000",
      mimeType: "image/jpeg",
      size: 1000,
      hidden: false,
      createdAt: new Date("2025-03-01T00:00:00Z"),
    };

    it("classifies a direct CUID media-id avatar (no extra DB call)", async () => {
      const cuid = "cmavatar00000000000000000";
      wireStats({
        entities: [{ metadata: { avatar: cuid } }],
        mediaRows: [{ ...baseMediaRow, id: cuid }],
      });
      const result = await handler.getUserMediaStats("user-123", {}, mockEnv);
      expect(result.totalCount).toBe(1);
      // 4 calls: posts, postMedia, entities, mediaRows (no avatar-hash lookup)
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(4);
    });

    it("classifies a bare contentHash avatar and resolves it via extra DB call", async () => {
      const hash = "a".repeat(64);
      const resolvedId = "cmresolved000000000000000";
      wireStats({
        entities: [{ metadata: { avatar: hash } }],
        avatarMediaRows: [{ id: resolvedId }],
        mediaRows: [{ ...baseMediaRow, id: resolvedId }],
      });
      const result = await handler.getUserMediaStats("user-123", {}, mockEnv);
      expect(result.totalCount).toBe(1);
      // 5 calls because the contentHash triggers the avatarMedia lookup
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(5);
    });

    it("extracts contentHash from a full /api/media/<hash> URL avatar", async () => {
      const hash = "b".repeat(40);
      const resolvedId = "cmurlhash0000000000000000";
      wireStats({
        entities: [
          {
            metadata: {
              avatar: `https://api.test.com/api/media/${hash}?variant=optimized`,
            },
          },
        ],
        avatarMediaRows: [{ id: resolvedId }],
        mediaRows: [{ ...baseMediaRow, id: resolvedId }],
      });
      const result = await handler.getUserMediaStats("user-123", {}, mockEnv);
      expect(result.totalCount).toBe(1);
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(5);
    });

    it("extracts a CUID media-id from a /api/media/<cuid> URL avatar", async () => {
      // Not a hex hash, but the path segment is a CUID -> avatarMediaIdsDirect
      const cuid = "cmpathid00000000000000000";
      wireStats({
        entities: [{ metadata: { avatar: `/api/media/${cuid}` } }],
        mediaRows: [{ ...baseMediaRow, id: cuid }],
      });
      const result = await handler.getUserMediaStats("user-123", {}, mockEnv);
      expect(result.totalCount).toBe(1);
      // direct id, no hash lookup -> 4 calls
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(4);
    });

    it("ignores a garbage avatar string (no match) and yields zero stats", async () => {
      wireStats({
        entities: [{ metadata: { avatar: "not-a-media-reference!!" } }],
        mediaRows: [],
      });
      const result = await handler.getUserMediaStats("user-123", {}, mockEnv);
      expect(result.totalCount).toBe(0);
      // no avatar contributed, no posts media -> allMediaIds empty short-circuit
      // (3 calls: posts, postMedia, entities; mediaRows never queried)
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(3);
    });

    it("ignores a null avatar value", async () => {
      wireStats({
        entities: [{ metadata: { avatar: null } }],
        mediaRows: [],
      });
      const result = await handler.getUserMediaStats("user-123", {}, mockEnv);
      expect(result.totalCount).toBe(0);
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(3);
    });

    it("ignores a non-string avatar value (number)", async () => {
      wireStats({
        entities: [{ metadata: { avatar: 12345 } }],
        mediaRows: [],
      });
      const result = await handler.getUserMediaStats("user-123", {}, mockEnv);
      expect(result.totalCount).toBe(0);
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(3);
    });

    it("ignores an empty-string avatar value", async () => {
      wireStats({
        entities: [{ metadata: { avatar: "" } }],
        mediaRows: [],
      });
      const result = await handler.getUserMediaStats("user-123", {}, mockEnv);
      expect(result.totalCount).toBe(0);
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(3);
    });

    it("ignores entity metadata that is null", async () => {
      wireStats({
        entities: [{ metadata: null }],
        mediaRows: [],
      });
      const result = await handler.getUserMediaStats("user-123", {}, mockEnv);
      expect(result.totalCount).toBe(0);
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(3);
    });

    it("ignores entity metadata that is not an object (string)", async () => {
      wireStats({
        entities: [{ metadata: "just-a-string" }],
        mediaRows: [],
      });
      const result = await handler.getUserMediaStats("user-123", {}, mockEnv);
      expect(result.totalCount).toBe(0);
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(3);
    });

    it("ignores entity metadata without an avatar key", async () => {
      wireStats({
        entities: [{ metadata: { somethingElse: "x" } }],
        mediaRows: [],
      });
      const result = await handler.getUserMediaStats("user-123", {}, mockEnv);
      expect(result.totalCount).toBe(0);
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledTimes(3);
    });
  });

  // ── getUserMediaStats: aggregation + early-exit branches ──────────────────
  describe("getUserMediaStats aggregation branches (branch coverage)", () => {
    function wireStatsSimple(mediaRows: any[], postMedia: any[] = [{ mediaId: "cmrow00000000000000000000" }]) {
      let call = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (_m: any, _r: string, _e: any, queryFn: (db: any) => Promise<any>) => {
          call++;
          if (call === 1)
            return queryFn({ ...mockDb, post: { findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]) } });
          if (call === 2)
            return queryFn({ ...mockDb, postMedia: { findMany: vi.fn().mockResolvedValue(postMedia) } });
          // call 3 = entities (default [])
          if (call === 4)
            return queryFn({ ...mockDb, mediaFile: { findMany: vi.fn().mockResolvedValue(mediaRows) } });
          return queryFn(mockDb);
        },
      );
    }

    it("returns zero stats when mediaRows is empty (post media id present but row filtered)", async () => {
      // allMediaIds non-empty (from postMedia) but mediaFile.findMany returns []
      // -> hits the `mediaRows.length === 0` early-return at line 627.
      wireStatsSimple([]);
      const result = await handler.getUserMediaStats("user-123", {}, mockEnv);
      expect(result.totalCount).toBe(0);
      expect(result.oldestMedia).toBeNull();
      expect(result.newestMedia).toBeNull();
    });

    it("counts videos and applies the video type filter branch", async () => {
      wireStatsSimple([
        {
          id: "cmrow00000000000000000000",
          mimeType: "video/mp4",
          size: 5000,
          hidden: false,
          createdAt: new Date("2025-02-10T00:00:00Z"),
        },
      ]);
      const result = await handler.getUserMediaStats(
        "user-123",
        { type: "video" },
        mockEnv,
      );
      expect(result.videoCount).toBe(1);
      expect(result.photoCount).toBe(0);
      expect(result.totalSize).toBe(5000);
    });

    it("aggregates oldest/newest across multiple rows and handles size undefined + string dates", async () => {
      wireStatsSimple([
        {
          id: "cmrowa0000000000000000000",
          mimeType: "image/png",
          size: undefined, // exercises `row.size || 0`
          hidden: true,
          createdAt: new Date("2025-01-01T00:00:00Z"), // oldest
        },
        {
          id: "cmrowb0000000000000000000",
          mimeType: "image/jpeg",
          size: 200,
          hidden: false,
          createdAt: "2025-06-01T00:00:00Z", // string -> new Date(...) branch; newest
        },
        {
          id: "cmrowc0000000000000000000",
          mimeType: "image/gif",
          size: 100,
          hidden: false,
          createdAt: new Date("2025-03-01T00:00:00Z"), // middle (neither newest nor oldest)
        },
      ]);
      const result = await handler.getUserMediaStats(
        "user-123",
        { includeHidden: true },
        mockEnv,
      );
      expect(result.totalCount).toBe(3);
      expect(result.totalSize).toBe(300); // undefined size counted as 0
      expect(result.hiddenCount).toBe(1);
      expect(result.oldestMedia).toBe("2025-01-01T00:00:00.000Z");
      expect(result.newestMedia).toBe("2025-06-01T00:00:00.000Z");
      // three distinct months
      expect(result.byMonth.length).toBe(3);
    });

    it("rethrows and logs when a query rejects (error with name)", async () => {
      const err = new Error("boom");
      err.name = "TimeoutError";
      mockWithQueryTimeoutAndRetry.mockRejectedValueOnce(err);
      await expect(
        handler.getUserMediaStats("user-123", { type: "photo" }, mockEnv),
      ).rejects.toThrow("boom");
    });

    it("rethrows when a query rejects with an error lacking a name (UnknownError branch)", async () => {
      // throw a plain object without `.name` to hit the `|| "UnknownError"` side
      mockWithQueryTimeoutAndRetry.mockImplementationOnce(async () => {
        throw { message: "no name here" };
      });
      await expect(
        handler.getUserMediaStats("user-123", {}, mockEnv),
      ).rejects.toBeTruthy();
    });
  });

  // ── listUserMedia: avatar classification + pagination + URL generation ────
  describe("listUserMedia avatar + pagination branches (branch coverage)", () => {
    function wireList(opts: {
      entities?: any[];
      postMedia?: any[];
      avatarMediaRows?: any[] | null;
      media: any[]; // returned by mediaFile.findMany (the page query)
      postCount?: number;
      totalCount?: number | null;
    }) {
      const hasHashCall = (opts.avatarMediaRows ?? null) !== null;
      let call = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (_m: any, _r: string, _e: any, queryFn: (db: any) => Promise<any>) => {
          call++;
          if (call === 1)
            return queryFn({ ...mockDb, post: { findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]) } });
          if (call === 2)
            return queryFn({ ...mockDb, postMedia: { findMany: vi.fn().mockResolvedValue(opts.postMedia ?? []) } });
          if (call === 3)
            return queryFn({ ...mockDb, entity: { findMany: vi.fn().mockResolvedValue(opts.entities ?? []) } });
          if (hasHashCall && call === 4)
            return queryFn({ ...mockDb, mediaFile: { findMany: vi.fn().mockResolvedValue(opts.avatarMediaRows) } });
          const mediaCall = hasHashCall ? 5 : 4;
          if (call === mediaCall)
            return queryFn({ ...mockDb, mediaFile: { findMany: vi.fn().mockResolvedValue(opts.media) } });
          // subsequent calls: postMedia.count (per item) then optional mediaFile.count
          return queryFn({
            ...mockDb,
            postMedia: { count: vi.fn().mockResolvedValue(opts.postCount ?? 0) },
            mediaFile: { count: vi.fn().mockResolvedValue(opts.totalCount ?? 0) },
          });
        },
      );
    }

    const mkMedia = (id: string, hash: string, createdAt: Date, extra: any = {}) => ({
      id,
      contentHash: hash,
      mimeType: "image/jpeg",
      size: 1234,
      hidden: false,
      createdAt,
      ...extra,
    });

    it("returns hasMore=false and null cursor when page not full", async () => {
      wireList({
        postMedia: [{ mediaId: "cmrow00000000000000000000" }],
        media: [mkMedia("cmrow00000000000000000000", "f".repeat(64), new Date("2025-01-01T00:00:00Z"))],
        postCount: 2,
      });
      const result = await handler.listUserMedia("user-123", { limit: 50 }, mockEnv);
      expect(result.media).toHaveLength(1);
      expect(result.cursor).toBeNull();
      expect(result.media[0].postCount).toBe(2);
      // URL generation exercised via real getApiDomain
      expect(result.media[0].thumbnailUrl).toContain("/api/media/");
    });

    it("returns a next cursor when there are more results than the limit", async () => {
      // limit=1 but two rows returned -> hasMore true, slice to 1, cursor set
      const d1 = new Date("2025-05-02T00:00:00Z");
      const d2 = new Date("2025-05-01T00:00:00Z");
      wireList({
        postMedia: [{ mediaId: "cmrowa0000000000000000000" }],
        media: [
          mkMedia("cmrowa0000000000000000000", "a".repeat(64), d1),
          mkMedia("cmrowb0000000000000000000", "b".repeat(64), d2),
        ],
        postCount: 1,
      });
      const result = await handler.listUserMedia("user-123", { limit: 1 }, mockEnv);
      expect(result.media).toHaveLength(1);
      expect(result.cursor).toBe(d1.toISOString());
    });

    it("resolves an avatar contentHash and merges it into the media id set", async () => {
      const resolved = "cmavm00000000000000000000";
      wireList({
        entities: [{ metadata: { avatar: "c".repeat(64) } }],
        avatarMediaRows: [{ id: resolved }],
        media: [mkMedia(resolved, "c".repeat(64), new Date("2025-04-01T00:00:00Z"))],
        postCount: 0,
      });
      const result = await handler.listUserMedia("user-123", {}, mockEnv);
      expect(result.media).toHaveLength(1);
      // avatar media has postCount 0 (its contentHash is in avatarContentHashes)
      expect(result.media[0].postCount).toBe(0);
    });

    it("returns totalCount when includeTotalCount=true (with avatar-direct id, no hash call)", async () => {
      const cuid = "cmdir000000000000000000000".slice(0, 25);
      wireList({
        entities: [{ metadata: { avatar: cuid } }],
        media: [mkMedia(cuid, "d".repeat(64), new Date("2025-04-01T00:00:00Z"))],
        postCount: 3,
        totalCount: 7,
      });
      const result = await handler.listUserMedia(
        "user-123",
        { includeTotalCount: true },
        mockEnv,
      );
      expect(result.totalCount).toBe(7);
    });

    it("returns empty media list when there are no posts and no avatar media", async () => {
      // postMedia [] + entities [] -> allMediaIds empty -> early return line 962
      wireList({ media: [] });
      const result = await handler.listUserMedia("user-123", {}, mockEnv);
      expect(result.media).toEqual([]);
      expect(result.cursor).toBeNull();
    });

    it("applies cursor with oldest sort (gt) branch", async () => {
      wireList({
        postMedia: [{ mediaId: "cmrow00000000000000000000" }],
        media: [mkMedia("cmrow00000000000000000000", "e".repeat(64), new Date("2025-07-01T00:00:00Z"))],
        postCount: 0,
      });
      const result = await handler.listUserMedia(
        "user-123",
        { cursor: "2025-06-01T00:00:00Z", sort: "oldest" },
        mockEnv,
      );
      expect(result.media).toHaveLength(1);
    });

    it("rethrows and logs on listUserMedia query failure (error without name)", async () => {
      mockWithQueryTimeoutAndRetry.mockImplementationOnce(async () => {
        throw "string-error";
      });
      await expect(
        handler.listUserMedia("user-123", { sort: "oldest", type: "video" }, mockEnv),
      ).rejects.toBeTruthy();
    });
  });

  // ── getMediaDetails: avatar ownership detection + metadata/canDelete ──────
  describe("getMediaDetails ownership + metadata branches (branch coverage)", () => {
    // Ownership via avatar only (no posts): postIds empty -> findFirst &
    // postsWithMedia are skipped. Sequence: findUnique, post.findMany([]),
    // entity.findMany, postMedia.findMany (checkShared).
    function wireAvatarOnly(media: any, entities: any[], shared: any[] = []) {
      let call = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (_m: any, _r: string, _e: any, queryFn: (db: any) => Promise<any>) => {
          call++;
          if (call === 1)
            return queryFn({ ...mockDb, mediaFile: { findUnique: vi.fn().mockResolvedValue(media) } });
          if (call === 2)
            return queryFn({ ...mockDb, post: { findMany: vi.fn().mockResolvedValue([]) } });
          if (call === 3)
            return queryFn({ ...mockDb, entity: { findMany: vi.fn().mockResolvedValue(entities) } });
          if (call === 4)
            return queryFn({ ...mockDb, postMedia: { findMany: vi.fn().mockResolvedValue(shared) } });
          return queryFn(mockDb);
        },
      );
    }

    const baseMedia = {
      id: "cmgmdid000000000000000000",
      contentHash: "ab".repeat(20), // 40-char hex
      cid: null,
      mimeType: "image/jpeg",
      size: 1024,
      width: null,
      height: null,
      duration: null,
      exifData: null,
      iptcData: null,
      dateTaken: null,
      videoMetadata: null,
      metadataVisible: false,
      locationVisible: false,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      updatedAt: new Date("2025-01-02T00:00:00Z"),
      hidden: false,
      hiddenAt: null,
      deletedAt: null,
    };

    it("detects avatar ownership when avatarUrl === media.id", async () => {
      wireAvatarOnly(baseMedia, [{ metadata: { avatar: baseMedia.id } }]);
      const result = await handler.getMediaDetails(baseMedia.id, "user-123", mockEnv);
      expect(result.id).toBe(baseMedia.id);
      expect(result.posts).toEqual([]);
    });

    it("detects avatar ownership when avatarUrl === media.contentHash", async () => {
      wireAvatarOnly(baseMedia, [{ metadata: { avatar: baseMedia.contentHash } }]);
      const result = await handler.getMediaDetails(baseMedia.id, "user-123", mockEnv);
      expect(result.contentHash).toBe(baseMedia.contentHash);
    });

    it("detects avatar ownership via URL-extracted contentHash === media.contentHash", async () => {
      wireAvatarOnly(baseMedia, [
        { metadata: { avatar: `https://api.test.com/api/media/${baseMedia.contentHash}?variant=optimized` } },
      ]);
      const result = await handler.getMediaDetails(baseMedia.id, "user-123", mockEnv);
      expect(result.id).toBe(baseMedia.id);
    });

    it("detects avatar ownership via URL-extracted media id === media.id", async () => {
      // contentHash must NOT be hex-extractable so the second regex matches the id
      const media = { ...baseMedia, contentHash: "zz-not-hex" };
      wireAvatarOnly(media, [{ metadata: { avatar: `/api/media/${media.id}` } }]);
      const result = await handler.getMediaDetails(media.id, "user-123", mockEnv);
      expect(result.id).toBe(media.id);
    });

    it("throws 'Media not found' when not in posts and no avatar match", async () => {
      wireAvatarOnly(baseMedia, [{ metadata: { avatar: "unrelated-value" } }]);
      await expect(
        handler.getMediaDetails(baseMedia.id, "user-123", mockEnv),
      ).rejects.toThrow("Media not found");
    });

    it("skips non-string/null avatar entities while scanning for ownership", async () => {
      wireAvatarOnly(baseMedia, [
        { metadata: null },
        { metadata: "string-meta" },
        { metadata: { avatar: 999 } },
        { metadata: { avatar: null } },
        { metadata: { avatar: baseMedia.id } }, // finally a match
      ]);
      const result = await handler.getMediaDetails(baseMedia.id, "user-123", mockEnv);
      expect(result.id).toBe(baseMedia.id);
    });
  });

  // ── getMediaDetails: metadata field gating + canDelete/canHide ────────────
  describe("getMediaDetails field-gating branches (branch coverage)", () => {
    // Ownership via posts. Sequence: 1 findUnique, 2 post.findMany([post-1]),
    // 3 postMedia.findFirst (in posts), 4 entity.findMany([]), 5 postsWithMedia,
    // 6 checkShared.
    function wireInPosts(media: any, opts: { postsWithMedia?: any[]; shared?: any[] } = {}) {
      let call = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (_m: any, _r: string, _e: any, queryFn: (db: any) => Promise<any>) => {
          call++;
          if (call === 1)
            return queryFn({ ...mockDb, mediaFile: { findUnique: vi.fn().mockResolvedValue(media) } });
          if (call === 2)
            return queryFn({ ...mockDb, post: { findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]) } });
          if (call === 3)
            return queryFn({ ...mockDb, postMedia: { findFirst: vi.fn().mockResolvedValue({ mediaId: media.id, postId: "post-1" }) } });
          // call 4 = entities (default [])
          if (call === 5)
            return queryFn({ ...mockDb, post: { findMany: vi.fn().mockResolvedValue(opts.postsWithMedia ?? []) } });
          if (call === 6)
            return queryFn({ ...mockDb, postMedia: { findMany: vi.fn().mockResolvedValue(opts.shared ?? [{ post: { authorId: "user-123" } }]) } });
          return queryFn(mockDb);
        },
      );
    }

    const m = (over: any = {}) => ({
      id: "cmgmdid000000000000000000",
      contentHash: "cd".repeat(20),
      cid: null,
      mimeType: "image/jpeg",
      size: 2048,
      width: null,
      height: null,
      duration: null,
      exifData: null,
      iptcData: null,
      dateTaken: null,
      videoMetadata: null,
      metadataVisible: false,
      locationVisible: false,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      updatedAt: new Date("2025-01-02T00:00:00Z"),
      hidden: false,
      hiddenAt: null,
      deletedAt: null,
      ...over,
    });

    it("includes width/height/duration when present", async () => {
      wireInPosts(m({ width: 800, height: 600, duration: 12 }));
      const result = await handler.getMediaDetails("cmgmdid000000000000000000", "user-123", mockEnv);
      expect(result.width).toBe(800);
      expect(result.height).toBe(600);
      expect(result.duration).toBe(12);
    });

    it("maps width/height/duration to undefined when absent", async () => {
      wireInPosts(m({ width: null, height: null, duration: null }));
      const result = await handler.getMediaDetails("cmgmdid000000000000000000", "user-123", mockEnv);
      expect(result.width).toBeUndefined();
      expect(result.height).toBeUndefined();
      expect(result.duration).toBeUndefined();
    });

    it("includes videoMetadata when present (separate gate from exif)", async () => {
      wireInPosts(m({ mimeType: "video/mp4", videoMetadata: { codec: "h264" }, metadataVisible: false }));
      const result = await handler.getMediaDetails("cmgmdid000000000000000000", "user-123", mockEnv);
      // videoMetadata is NOT behind metadataVisible
      expect(result.videoMetadata).toEqual({ codec: "h264" });
      // exif still withheld
      expect(result.exifData).toBeUndefined();
    });

    it("includes exif/iptc but coerces null fields to undefined when metadataVisible=true", async () => {
      // metadataVisible true, but exifData/iptcData/dateTaken all null -> `?? undefined`
      wireInPosts(m({ metadataVisible: true, exifData: null, iptcData: null, dateTaken: null }));
      const result = await handler.getMediaDetails("cmgmdid000000000000000000", "user-123", mockEnv);
      expect(result.metadataVisible).toBe(true);
      expect(result.exifData).toBeUndefined();
      expect(result.iptcData).toBeUndefined();
      expect(result.dateTaken).toBeUndefined();
    });

    it("sets hiddenAt/deletedAt timestamps and canHide=false when hidden", async () => {
      wireInPosts(
        m({
          hidden: true,
          hiddenAt: new Date("2025-01-03T00:00:00Z"),
          deletedAt: null,
        }),
      );
      const result = await handler.getMediaDetails("cmgmdid000000000000000000", "user-123", mockEnv);
      expect(result.hidden).toBe(true);
      expect(result.hiddenAt).toBe("2025-01-03T00:00:00.000Z");
      expect(result.deletedAt).toBeNull();
      expect(result.canHide).toBe(false); // hidden -> cannot hide again
      expect(result.canDelete).toBe(true); // not shared, not deleted
    });

    it("canDelete=false when media is shared with other users", async () => {
      wireInPosts(m(), { shared: [{ post: { authorId: "someone-else" } }] });
      const result = await handler.getMediaDetails("cmgmdid000000000000000000", "user-123", mockEnv);
      expect(result.canDelete).toBe(false); // shared
      expect(result.canHide).toBe(true);
    });

    it("canDelete=false and canHide=false when media already deleted", async () => {
      wireInPosts(m({ deletedAt: new Date("2025-01-05T00:00:00Z") }));
      const result = await handler.getMediaDetails("cmgmdid000000000000000000", "user-123", mockEnv);
      expect(result.deletedAt).toBe("2025-01-05T00:00:00.000Z");
      expect(result.canDelete).toBe(false);
      expect(result.canHide).toBe(false);
    });

    it("maps posts with falsy text to empty string", async () => {
      wireInPosts(m(), {
        postsWithMedia: [
          {
            id: "post-1",
            text: null, // -> "" branch at line 1493
            createdAt: new Date("2025-01-01T00:00:00Z"),
            visibility: "PUBLIC",
          },
        ],
      });
      const result = await handler.getMediaDetails("cmgmdid000000000000000000", "user-123", mockEnv);
      expect(result.posts).toHaveLength(1);
      expect(result.posts[0].text).toBe("");
      expect(result.posts[0].url).toBe("/posts/post-1");
    });

    it("rethrows on getMediaDetails query failure (UnknownError branch)", async () => {
      mockWithQueryTimeoutAndRetry.mockImplementationOnce(async () => {
        throw { message: "nameless" };
      });
      await expect(
        handler.getMediaDetails("cmgmdid000000000000000000", "user-123", mockEnv),
      ).rejects.toBeTruthy();
    });
  });

  // ── getApiDomain conversion exercised through a method that emits URLs ─────
  describe("getApiDomain hostname conversion (branch coverage)", () => {
    // listUserMedia generates URLs via getApiDomain only when there is media,
    // so we must return an actual media row.
    function wireOneMedia(env: Env) {
      let call = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (_m: any, _r: string, _e: any, queryFn: (db: any) => Promise<any>) => {
          call++;
          if (call === 1)
            return queryFn({ ...mockDb, post: { findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]) } });
          if (call === 2)
            return queryFn({ ...mockDb, postMedia: { findMany: vi.fn().mockResolvedValue([{ mediaId: "cmrow00000000000000000000" }]) } });
          // call 3 entities default []
          if (call === 4)
            return queryFn({
              ...mockDb,
              mediaFile: {
                findMany: vi.fn().mockResolvedValue([
                  {
                    id: "cmrow00000000000000000000",
                    contentHash: "f".repeat(64),
                    mimeType: "image/jpeg",
                    size: 10,
                    hidden: false,
                    createdAt: new Date("2025-01-01T00:00:00Z"),
                  },
                ]),
              },
            });
          return queryFn({ ...mockDb, postMedia: { count: vi.fn().mockResolvedValue(0) } });
        },
      );
    }

    it("converts www. host to api. host in emitted media URLs", async () => {
      const env = { ...mockEnv, APP_DOMAIN: "https://www.example.com" } as Env;
      const h = new MediaHandler(env);
      wireOneMedia(env);
      const result = await h.listUserMedia("user-123", {}, env);
      expect(result.media[0].thumbnailUrl.startsWith("https://api.example.com/")).toBe(true);
    });

    it("adds api. subdomain when host has none (example.com)", async () => {
      const env = { ...mockEnv, APP_DOMAIN: "https://example.com" } as Env;
      const h = new MediaHandler(env);
      wireOneMedia(env);
      const result = await h.listUserMedia("user-123", {}, env);
      expect(result.media[0].optimizedUrl.startsWith("https://api.example.com/")).toBe(true);
    });

    it("falls back to default domain for a single-label host (parts.length < 2)", async () => {
      const env = { ...mockEnv, APP_DOMAIN: "https://localhost" } as Env;
      const h = new MediaHandler(env);
      wireOneMedia(env);
      const result = await h.listUserMedia("user-123", {}, env);
      // single label: no api. added, returns protocol//localhost
      expect(result.media[0].thumbnailUrl.startsWith("https://localhost/")).toBe(true);
    });
  });

  // ── listUserMedia: URL-form avatar extraction (lines 905-921) ─────────────
  describe("listUserMedia URL-form avatar extraction (branch coverage)", () => {
    function wire(opts: { entities: any[]; avatarMediaRows?: any[] | null; media: any[] }) {
      const hasHashCall = (opts.avatarMediaRows ?? null) !== null;
      let call = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (_m: any, _r: string, _e: any, queryFn: (db: any) => Promise<any>) => {
          call++;
          if (call === 1)
            return queryFn({ ...mockDb, post: { findMany: vi.fn().mockResolvedValue([]) } });
          if (call === 2)
            return queryFn({ ...mockDb, postMedia: { findMany: vi.fn().mockResolvedValue([]) } });
          if (call === 3)
            return queryFn({ ...mockDb, entity: { findMany: vi.fn().mockResolvedValue(opts.entities) } });
          if (hasHashCall && call === 4)
            return queryFn({ ...mockDb, mediaFile: { findMany: vi.fn().mockResolvedValue(opts.avatarMediaRows) } });
          const mediaCall = hasHashCall ? 5 : 4;
          if (call === mediaCall)
            return queryFn({ ...mockDb, mediaFile: { findMany: vi.fn().mockResolvedValue(opts.media) } });
          return queryFn({ ...mockDb, postMedia: { count: vi.fn().mockResolvedValue(0) } });
        },
      );
    }

    it("extracts contentHash from a /api/media/<hash> URL avatar (line 906)", async () => {
      const hash = "9".repeat(48);
      const resolved = "cmurlc0000000000000000000";
      wire({
        entities: [{ metadata: { avatar: `https://api.test.com/api/media/${hash}?variant=thumbnail` } }],
        avatarMediaRows: [{ id: resolved }],
        media: [
          {
            id: resolved,
            contentHash: hash,
            mimeType: "image/jpeg",
            size: 10,
            hidden: false,
            createdAt: new Date("2025-01-01T00:00:00Z"),
          },
        ],
      });
      const result = await handler.listUserMedia("user-123", {}, mockEnv);
      expect(result.media).toHaveLength(1);
      expect(result.media[0].id).toBe(resolved);
    });

    it("extracts a CUID media id from a /api/media/<cuid> URL avatar (lines 916-921)", async () => {
      const cuid = "cmurld0000000000000000000";
      wire({
        // avatar has no hex hash but the path is a CUID -> avatarMediaIdsDirect
        entities: [{ metadata: { avatar: `/api/media/${cuid}` } }],
        media: [
          {
            id: cuid,
            contentHash: "gg-not-hex",
            mimeType: "image/jpeg",
            size: 10,
            hidden: false,
            createdAt: new Date("2025-01-01T00:00:00Z"),
          },
        ],
      });
      const result = await handler.listUserMedia("user-123", {}, mockEnv);
      expect(result.media).toHaveLength(1);
      expect(result.media[0].id).toBe(cuid);
    });

    it("uses EU fallback region when DEFAULT_REGION is falsy (line 779)", async () => {
      const env = { ...mockEnv, DEFAULT_REGION: "" } as Env;
      const h = new MediaHandler(env);
      // no posts, no avatars -> early empty return, but region resolved first
      let call = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (_m: any, _r: string, _e: any, queryFn: (db: any) => Promise<any>) => {
          call++;
          if (call === 1)
            return queryFn({ ...mockDb, post: { findMany: vi.fn().mockResolvedValue([]) } });
          if (call === 2)
            return queryFn({ ...mockDb, postMedia: { findMany: vi.fn().mockResolvedValue([]) } });
          return queryFn({ ...mockDb, entity: { findMany: vi.fn().mockResolvedValue([]) } });
        },
      );
      const result = await h.listUserMedia("user-123", {}, env);
      expect(result.media).toEqual([]);
      expect(mockWithQueryTimeoutAndRetry.mock.calls[0][1]).toBe("EU");
    });
  });

  // ── listUserMediaGrouped: empty-media + error branches ────────────────────
  describe("listUserMediaGrouped extra branches (branch coverage)", () => {
    it("returns empty groups when posts exist but distinct media ids are empty (line 171)", async () => {
      let call = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (_m: any, _r: string, _e: any, queryFn: (db: any) => Promise<any>) => {
          call++;
          if (call === 1)
            return queryFn({ ...mockDb, post: { findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]) } });
          if (call === 2)
            // postMedia returns no rows -> mediaIds empty
            return queryFn({ ...mockDb, postMedia: { findMany: vi.fn().mockResolvedValue([]) } });
          return queryFn(mockDb);
        },
      );
      const result = await handler.listUserMediaGrouped("user-123", "month", {}, mockEnv);
      expect(result.groups).toEqual([]);
    });

    it("rethrows and logs with options metadata on failure (error with name)", async () => {
      const err = new Error("grouped boom");
      err.name = "QueryError";
      mockWithQueryTimeoutAndRetry.mockRejectedValueOnce(err);
      await expect(
        handler.listUserMediaGrouped(
          "user-123",
          "year",
          { includeHidden: true, type: "photo" },
          mockEnv,
        ),
      ).rejects.toThrow("grouped boom");
    });

    it("rethrows on failure with a nameless error (UnknownError branch)", async () => {
      mockWithQueryTimeoutAndRetry.mockImplementationOnce(async () => {
        throw { message: "no name" };
      });
      await expect(
        handler.listUserMediaGrouped("user-123", "month", {}, mockEnv),
      ).rejects.toBeTruthy();
    });

    it("uses EU fallback region when DEFAULT_REGION is falsy (line 98)", async () => {
      const env = { ...mockEnv, DEFAULT_REGION: "" } as Env;
      const h = new MediaHandler(env);
      mockWithQueryTimeoutAndRetry.mockImplementationOnce(
        async (_m: any, _r: string, _e: any, queryFn: (db: any) => Promise<any>) =>
          queryFn({ ...mockDb, post: { findMany: vi.fn().mockResolvedValue([]) } }),
      );
      const result = await h.listUserMediaGrouped("user-123", "month", {}, env);
      expect(result.groups).toEqual([]);
      expect(mockWithQueryTimeoutAndRetry.mock.calls[0][1]).toBe("EU");
    });
  });

  // ── hide/unhide/delete: EU region fallback + nameless-error catch ─────────
  describe("hide/unhide/delete region + error branches (branch coverage)", () => {
    // Wire getMediaDetails (6 calls) for an owned, in-posts media, then a 7th
    // call for the mutation. `mediaOver` customizes the media row.
    function wireDetailsThenMutation(mediaOver: any, mutationResult: any) {
      let call = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (_m: any, _r: string, _e: any, queryFn: (db: any) => Promise<any>) => {
          call++;
          if (call === 1)
            return queryFn({
              ...mockDb,
              mediaFile: {
                findUnique: vi.fn().mockResolvedValue({
                  id: "cmhidea000000000000000000",
                  contentHash: "ee".repeat(20),
                  mimeType: "image/jpeg",
                  size: 100,
                  width: null,
                  height: null,
                  duration: null,
                  cid: null,
                  exifData: null,
                  iptcData: null,
                  dateTaken: null,
                  videoMetadata: null,
                  metadataVisible: false,
                  locationVisible: false,
                  createdAt: new Date("2025-01-01T00:00:00Z"),
                  updatedAt: new Date("2025-01-01T00:00:00Z"),
                  hidden: false,
                  hiddenAt: null,
                  deletedAt: null,
                  ...mediaOver,
                }),
              },
            });
          if (call === 2)
            return queryFn({ ...mockDb, post: { findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]) } });
          if (call === 3)
            return queryFn({ ...mockDb, postMedia: { findFirst: vi.fn().mockResolvedValue({}) } });
          // call 4 entities default []
          if (call === 5)
            return queryFn({ ...mockDb, post: { findMany: vi.fn().mockResolvedValue([]) } });
          if (call === 6)
            return queryFn({ ...mockDb, postMedia: { findMany: vi.fn().mockResolvedValue([{ post: { authorId: "user-123" } }]) } });
          if (call === 7)
            return queryFn({ ...mockDb, mediaFile: { update: vi.fn().mockResolvedValue(mutationResult) } });
          return queryFn(mockDb);
        },
      );
    }

    it("hideMedia uses EU fallback region when DEFAULT_REGION is falsy", async () => {
      const env = { ...mockEnv, DEFAULT_REGION: "" } as Env;
      const h = new MediaHandler(env);
      wireDetailsThenMutation(
        { hidden: false },
        { id: "cmhidea000000000000000000", hidden: true, hiddenAt: new Date("2025-01-02T00:00:00Z") },
      );
      const result = await h.hideMedia("cmhidea000000000000000000", "user-123", env);
      expect(result.hidden).toBe(true);
      // region passed to the DB layer should be the EU fallback
      expect(mockWithQueryTimeoutAndRetry.mock.calls[0][1]).toBe("EU");
    });

    it("hideMedia rethrows with UnknownError when getMediaDetails throws nameless", async () => {
      mockWithQueryTimeoutAndRetry.mockImplementationOnce(async () => {
        throw { message: "nameless hide" };
      });
      await expect(
        handler.hideMedia("cmhidea000000000000000000", "user-123", mockEnv),
      ).rejects.toBeTruthy();
    });

    it("unhideMedia uses EU fallback region and unhides a hidden item", async () => {
      const env = { ...mockEnv, DEFAULT_REGION: "" } as Env;
      const h = new MediaHandler(env);
      wireDetailsThenMutation(
        { hidden: true, hiddenAt: new Date("2025-01-01T00:00:00Z") },
        { id: "cmhidea000000000000000000", hidden: false, hiddenAt: null },
      );
      const result = await h.unhideMedia("cmhidea000000000000000000", "user-123", env);
      expect(result.hidden).toBe(false);
      expect(result.hiddenAt).toBeNull();
      expect(mockWithQueryTimeoutAndRetry.mock.calls[0][1]).toBe("EU");
    });

    it("unhideMedia rethrows with UnknownError when getMediaDetails throws nameless", async () => {
      mockWithQueryTimeoutAndRetry.mockImplementationOnce(async () => {
        throw { message: "nameless unhide" };
      });
      await expect(
        handler.unhideMedia("cmhidea000000000000000000", "user-123", mockEnv),
      ).rejects.toBeTruthy();
    });

    it("unhideMedia handles audit logging failure gracefully", async () => {
      mockAuditLoggerLog.mockRejectedValueOnce(new Error("audit down"));
      wireDetailsThenMutation(
        { hidden: true, hiddenAt: new Date("2025-01-01T00:00:00Z") },
        { id: "cmhidea000000000000000000", hidden: false, hiddenAt: null },
      );
      const result = await handler.unhideMedia("cmhidea000000000000000000", "user-123", mockEnv);
      expect(result.hidden).toBe(false);
      expect(mockAuditLoggerLog).toHaveBeenCalled();
    });

    it("deleteMedia rethrows with UnknownError when getMediaDetails throws nameless", async () => {
      mockWithQueryTimeoutAndRetry.mockImplementationOnce(async () => {
        throw { message: "nameless delete" };
      });
      await expect(
        handler.deleteMedia("cmdelid000000000000000000", "user-123", mockEnv),
      ).rejects.toBeTruthy();
    });

    it("deleteMedia uses EU fallback region for an owned, unshared item", async () => {
      const env = { ...mockEnv, DEFAULT_REGION: "" } as Env;
      const h = new MediaHandler(env);
      // deleteMedia: 6 (getMediaDetails) + 1 (checkShared) + 1 (soft delete update)
      let call = 0;
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (_m: any, _r: string, _e: any, queryFn: (db: any) => Promise<any>) => {
          call++;
          if (call === 1)
            return queryFn({
              ...mockDb,
              mediaFile: {
                findUnique: vi.fn().mockResolvedValue({
                  id: "cmdelid000000000000000000",
                  contentHash: "dd".repeat(20),
                  mimeType: "image/jpeg",
                  size: 100,
                  width: null,
                  height: null,
                  duration: null,
                  cid: null,
                  exifData: null,
                  iptcData: null,
                  dateTaken: null,
                  videoMetadata: null,
                  metadataVisible: false,
                  locationVisible: false,
                  createdAt: new Date("2025-01-01T00:00:00Z"),
                  updatedAt: new Date("2025-01-01T00:00:00Z"),
                  hidden: false,
                  hiddenAt: null,
                  deletedAt: null,
                }),
              },
            });
          if (call === 2)
            return queryFn({ ...mockDb, post: { findMany: vi.fn().mockResolvedValue([{ id: "post-1" }]) } });
          if (call === 3)
            return queryFn({ ...mockDb, postMedia: { findFirst: vi.fn().mockResolvedValue({}) } });
          if (call === 5)
            return queryFn({ ...mockDb, post: { findMany: vi.fn().mockResolvedValue([]) } });
          if (call === 6)
            return queryFn({ ...mockDb, postMedia: { findMany: vi.fn().mockResolvedValue([{ post: { authorId: "user-123" } }]) } });
          if (call === 7)
            // deleteMedia checkShared: only this user's posts -> not shared
            return queryFn({ ...mockDb, postMedia: { findMany: vi.fn().mockResolvedValue([{ post: { authorId: "user-123" } }]) } });
          if (call === 8)
            return queryFn({ ...mockDb, mediaFile: { update: vi.fn().mockResolvedValue({ id: "cmdelid000000000000000000", deletedAt: new Date() }) } });
          return queryFn(mockDb);
        },
      );
      await expect(
        h.deleteMedia("cmdelid000000000000000000", "user-123", env),
      ).resolves.toBeUndefined();
      expect(mockWithQueryTimeoutAndRetry.mock.calls[0][1]).toBe("EU");
    });
  });
});
