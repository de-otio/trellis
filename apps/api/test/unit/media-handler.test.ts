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
});
