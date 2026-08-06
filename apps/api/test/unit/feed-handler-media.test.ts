/**
 * Unit Tests: Feed Handler Media Support
 *
 * Tests for media inclusion in feed queries.
 */

import { PostRadius } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";
import { FeedHandler } from "../../src/lib/feed-handler.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";
import type { Session } from "../../src/lib/session-cookie.js";

// Mock DataRouter
const mockGetDatabaseForRegion = vi.fn();
vi.mock("../../src/lib/data-router", () => ({
  DataRouter: {
    getDatabaseForRegion: (...args: any[]) => mockGetDatabaseForRegion(...args),
  },
}));

// Mock DatabaseConnectionManager
const mockExecuteWithRetry = vi.fn();
const mockSharedInstance = {
  createClient: vi.fn(),
  clearPools: vi.fn(),
  getPoolStatus: vi.fn().mockReturnValue([]),
  executeWithRetry: mockExecuteWithRetry,
};
vi.mock("../../src/lib/database-connection-manager", () => ({
  DatabaseConnectionManager: class {
    createClient = mockSharedInstance.createClient;
    clearPools = mockSharedInstance.clearPools;
    getPoolStatus = mockSharedInstance.getPoolStatus;
    executeWithRetry = mockSharedInstance.executeWithRetry;
  },
  sharedDatabaseConnectionManager: mockSharedInstance,
}));

// Mock region detection
vi.mock("../../src/lib/region-detection", () => {
  const mockDetectRegionSync = vi.fn().mockReturnValue("US");
  const mockIsValidRegion = vi
    .fn()
    .mockImplementation((region: string) =>
      ["US", "EU", "CN"].includes(region),
    );
  return {
    detectRegionSync: mockDetectRegionSync,
    isValidRegion: mockIsValidRegion,
    RegionDetector: class RegionDetector {
      detectRegionSync = mockDetectRegionSync;
      isValidRegion = mockIsValidRegion;
    },
  };
});

// Mock friend-set resolution (relationship edges — see lib/friend-ids.ts)
const mockGetFriendUserIds = vi.fn();
vi.mock("../../src/lib/friend-ids", () => {
  return {
    FRIEND_TIER_MAX: 1,
    getFriendUserIds: (...args: unknown[]) => mockGetFriendUserIds(...args),
  };
});

const TEST_TENANT_ID = "tenant-test-123";

describe("FeedHandler - Media Support", () => {
  let handler: FeedHandler;
  let mockEnv: any;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new FeedHandler();

    mockDb = {
      post: {
        findMany: vi.fn(),
      },
      postSentiment: {
        groupBy: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      postComment: {
        groupBy: vi.fn().mockResolvedValue([]),
      },
      linkCheck: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    mockGetDatabaseForRegion.mockReturnValue(mockDb);

    mockEnv = {
      DATABASE_URL: "postgres://test",
      US_DATABASE_URL: "postgres://us-test",
      FEED_CACHE_KV: {
        get: vi.fn().mockImplementation((key: string) => {
          if (key === "feed:cache:version") {
            return Promise.resolve("1");
          }
          return Promise.resolve(null);
        }),
        put: vi.fn().mockResolvedValue(undefined),
      } as any,
      DEFAULT_REGION: "US",
    };

    mockSession = {
      userId: "user-123",
      email: "test@example.com",
      expiresAt: Date.now() + 3600000,
      dataRegion: "US" as const,
      profileContext: "primary" as const,
    };

    mockRequestContext = {
      region: "US" as const,
      config: {
        region: "US" as const,
        features: {
          authentication: {
            emailPassword: true,
            magicLink: false,
            phoneAuth: false,
            weChatAuth: false,
            qqAuth: false,
            microsoftSSO: false,
          },
          features: {
            offlineMode: false,
            realTimeUpdates: false,
            pushNotifications: false,
          },
          performance: {
            aggressiveCaching: false,
            extendedTimeouts: false,
            requestBatching: false,
          },
          security: {
            encryption: true,
            rateLimiting: true,
            auditLogging: true,
            regionValidation: true,
          },
        },
        endpoints: {
          api: "https://api.example.com",
          frontend: "https://app.example.com",
          cdn: "https://cdn.example.com",
        },
        timeouts: {
          database: 5000,
          api: 10000,
          storage: 5000,
        },
      },
      session: mockSession,
    };

    mockGetFriendUserIds.mockResolvedValue([]);

    // Mock executeWithRetry to call the query function with mockDb
    mockExecuteWithRetry.mockImplementation(
      async (region, env, queryFn, options) => {
        return await queryFn(mockDb);
      },
    );
  });

  describe("Media Query Inclusion", () => {
    it("should include media in query with correct structure", async () => {
      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post with media",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: {
            id: "user-123",
            email: "test@example.com",
          },
          media: [
            {
              id: "pm-1",
              mediaId: "media-1",
              alt: "Test image",
              order: 0,
              media: {
                id: "media-1",
                contentHash: "abc123",
                mimeType: "image/jpeg",
                originalKey: "media/abc123.jpg",
                thumbnailKey: "media/abc123_thumb.webp",
                optimizedKey: "media/abc123_opt.webp",
                width: 1920,
                height: 1080,
              },
            },
          ],
        },
      ]);

      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      // Verify query includes media
      const findManyCall = mockDb.post.findMany.mock.calls[0][0];
      expect(findManyCall.include.media).toBeDefined();
      expect(findManyCall.include.media.where).toBeDefined();
      expect(findManyCall.include.media.where.media.hidden).toBe(false);
      expect(findManyCall.include.media.where.media.deletedAt).toBe(null);
      expect(findManyCall.include.media.orderBy).toEqual({ order: "asc" });
      expect(findManyCall.include.media.include.media.select).toBeDefined();
    });

    it("should include media data in enriched response", async () => {
      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post with media",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: {
            id: "user-123",
            email: "test@example.com",
          },
          media: [
            {
              id: "pm-1",
              mediaId: "media-1",
              alt: "Test image",
              order: 0,
              media: {
                id: "media-1",
                contentHash: "abc123",
                mimeType: "image/jpeg",
                originalKey: "media/abc123.jpg",
                thumbnailKey: "media/abc123_thumb.webp",
                optimizedKey: "media/abc123_opt.webp",
                width: 1920,
                height: 1080,
              },
            },
          ],
        },
      ]);

      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.posts[0].media).toBeDefined();
      expect(data.posts[0].media).toHaveLength(1);
      expect(data.posts[0].media[0]).toEqual({
        id: "pm-1",
        mediaId: "media-1",
        alt: "Test image",
        order: 0,
        file: {
          id: "media-1",
          contentHash: "abc123",
          mimeType: "image/jpeg",
          originalKey: "https://api.rkm1.de/api/media/abc123?variant=original",
          thumbnailKey:
            "https://api.rkm1.de/api/media/abc123?variant=thumbnail",
          optimizedKey:
            "https://api.rkm1.de/api/media/abc123?variant=optimized",
          width: 1920,
          height: 1080,
        },
        // AI Act Art. 50 provenance is emitted on EVERY attachment, always
        // present and never omitted. This fixture's media row carries no
        // provenance columns, so it correctly resolves to UNKNOWN — which the
        // client must render as NOTHING, never as "human-created".
        provenance: {
          sourceType: "UNKNOWN",
          basis: null,
          disclosureRequired: false,
          labelKey: "provenance.unknown",
          labelDetailKey: "provenance.unknown.detail",
        },
      });
    });

    it("should handle posts without media", async () => {
      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post without media",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: {
            id: "user-123",
            email: "test@example.com",
          },
          media: [],
        },
      ]);

      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.posts[0].media).toEqual([]);
    });

    it("should handle multiple media items with correct ordering", async () => {
      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post with multiple media",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: {
            id: "user-123",
            email: "test@example.com",
          },
          media: [
            {
              id: "pm-1",
              mediaId: "media-1",
              alt: "First image",
              order: 0,
              media: {
                id: "media-1",
                contentHash: "abc123",
                mimeType: "image/jpeg",
                originalKey: "media/abc123.jpg",
                thumbnailKey: "media/abc123_thumb.webp",
                optimizedKey: "media/abc123_opt.webp",
                width: 1920,
                height: 1080,
              },
            },
            {
              id: "pm-2",
              mediaId: "media-2",
              alt: "Second image",
              order: 1,
              media: {
                id: "media-2",
                contentHash: "def456",
                mimeType: "image/jpeg",
                originalKey: "media/def456.jpg",
                thumbnailKey: "media/def456_thumb.webp",
                optimizedKey: "media/def456_opt.webp",
                width: 1920,
                height: 1080,
              },
            },
          ],
        },
      ]);

      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.posts[0].media).toHaveLength(2);
      expect(data.posts[0].media[0].order).toBe(0);
      expect(data.posts[0].media[1].order).toBe(1);
      expect(data.posts[0].media[0].alt).toBe("First image");
      expect(data.posts[0].media[1].alt).toBe("Second image");
    });

    it("should select only required MediaFile fields", async () => {
      mockDb.post.findMany.mockResolvedValue([]);
      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const findManyCall = mockDb.post.findMany.mock.calls[0][0];
      const mediaSelect = findManyCall.include.media.include.media.select;

      // Verify only required fields are selected
      expect(mediaSelect.id).toBe(true);
      expect(mediaSelect.contentHash).toBe(true);
      expect(mediaSelect.mimeType).toBe(true);
      expect(mediaSelect.originalKey).toBe(true);
      expect(mediaSelect.thumbnailKey).toBe(true);
      expect(mediaSelect.optimizedKey).toBe(true);
      expect(mediaSelect.width).toBe(true);
      expect(mediaSelect.height).toBe(true);

      // Verify other fields are not selected
      expect(mediaSelect.size).toBeUndefined();
      expect(mediaSelect.exifData).toBeUndefined();
      expect(mediaSelect.iptcData).toBeUndefined();
    });
  });

  describe("Empty Media Handling", () => {
    it("should handle posts with null media gracefully", async () => {
      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post with null media",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: {
            id: "user-123",
            email: "test@example.com",
          },
          media: null, // Explicitly null
        },
      ]);

      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.posts[0].media).toBeUndefined();
    });

    it("should handle posts with undefined media gracefully", async () => {
      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post with undefined media",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: {
            id: "user-123",
            email: "test@example.com",
          },
          // media field not present
        },
      ]);

      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.posts[0].media).toBeUndefined();
    });

    it("should handle posts with empty media array", async () => {
      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post with empty media array",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: {
            id: "user-123",
            email: "test@example.com",
          },
          media: [],
        },
      ]);

      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.posts[0].media).toEqual([]);
    });
  });

  describe("Property-Based Tests", () => {
    /**
     * Feature: feed-image-display, Property 3: Enriched posts include media data
     *
     * **Validates: Requirements 1.3**
     *
     * Property: For any post with media, when processed by enrichPosts(),
     * the output should include a media array with all PostMedia and MediaFile
     * data properly structured.
     */
    it("Property 3: Enriched posts include media data", async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random number of media items (1-10)
          fc.integer({ min: 1, max: 10 }),
          // Generate random media properties
          fc.record({
            hasAlt: fc.boolean(),
            hasThumbnail: fc.boolean(),
            hasOptimized: fc.boolean(),
            width: fc.integer({ min: 100, max: 4000 }),
            height: fc.integer({ min: 100, max: 4000 }),
          }),
          async (mediaCount, mediaProps) => {
            // Create media items with random properties
            const mediaItems = Array.from({ length: mediaCount }, (_, i) => ({
              id: `pm-${i}`,
              mediaId: `media-${i}`,
              alt: mediaProps.hasAlt ? `Alt text ${i}` : null,
              order: i,
              media: {
                id: `media-${i}`,
                contentHash: `hash-${i}-${Math.random().toString(36).substring(7)}`,
                mimeType: "image/jpeg",
                originalKey: `media/hash-${i}.jpg`,
                thumbnailKey: mediaProps.hasThumbnail
                  ? `media/hash-${i}_thumb.webp`
                  : null,
                optimizedKey: mediaProps.hasOptimized
                  ? `media/hash-${i}_opt.webp`
                  : null,
                width: mediaProps.width,
                height: mediaProps.height,
              },
            }));

            // Mock database to return post with media
            mockDb.post.findMany.mockResolvedValue([
              {
                id: "post-1",
                authorId: "user-123",
                text: "Test post with media",
                radius: PostRadius.SHOUT,
                createdAt: new Date("2024-01-01T10:00:00Z"),
                author: {
                  id: "user-123",
                  email: "test@example.com",
                },
                media: mediaItems,
              },
            ]);

            mockDb.postSentiment.groupBy.mockResolvedValue([]);
            mockDb.postSentiment.findMany.mockResolvedValue([]);
            mockDb.postComment.groupBy.mockResolvedValue([]);

            const request = new Request("http://test.com/feeds/home");
            const response = await handler.getHomeFeed(
              mockSession,
              request,
              mockEnv,
              { limit: 20 },
              mockRequestContext,
              TEST_TENANT_ID,
            );

            const data = await response.json();

            // Property 1: Verify enriched post includes media array
            expect(data.posts[0].media).toBeDefined();
            expect(Array.isArray(data.posts[0].media)).toBe(true);
            expect(data.posts[0].media.length).toBe(mediaCount);

            // Property 2: Verify media structure is properly transformed
            data.posts[0].media.forEach((mediaItem: any, index: number) => {
              // Verify PostMedia fields are preserved
              expect(mediaItem.id).toBe(`pm-${index}`);
              expect(mediaItem.mediaId).toBe(`media-${index}`);
              expect(mediaItem.order).toBe(index);

              // Verify alt text handling
              if (mediaProps.hasAlt) {
                expect(mediaItem.alt).toBe(`Alt text ${index}`);
              } else {
                expect(mediaItem.alt).toBeNull();
              }

              // Verify nested file structure
              expect(mediaItem.file).toBeDefined();
              expect(typeof mediaItem.file).toBe("object");

              // Verify MediaFile fields are properly nested
              expect(mediaItem.file.id).toBe(`media-${index}`);
              expect(mediaItem.file.contentHash).toBeDefined();
              expect(typeof mediaItem.file.contentHash).toBe("string");
              expect(mediaItem.file.mimeType).toBe("image/jpeg");

              // URLs should be full media endpoint URLs, not R2 storage keys
              const contentHash = mediaItem.file.contentHash;
              expect(mediaItem.file.originalKey).toBe(
                `https://api.rkm1.de/api/media/${contentHash}?variant=original`,
              );

              // Verify optional keys
              if (mediaProps.hasThumbnail) {
                expect(mediaItem.file.thumbnailKey).toBe(
                  `https://api.rkm1.de/api/media/${contentHash}?variant=thumbnail`,
                );
              } else {
                expect(mediaItem.file.thumbnailKey).toBeNull();
              }

              if (mediaProps.hasOptimized) {
                expect(mediaItem.file.optimizedKey).toBe(
                  `https://api.rkm1.de/api/media/${contentHash}?variant=optimized`,
                );
              } else {
                expect(mediaItem.file.optimizedKey).toBeNull();
              }

              // Verify dimensions
              expect(mediaItem.file.width).toBe(mediaProps.width);
              expect(mediaItem.file.height).toBe(mediaProps.height);
            });

            // Property 3: Verify enrichPosts maintains order
            const returnedOrders = data.posts[0].media.map((m: any) => m.order);
            expect(returnedOrders).toEqual(
              Array.from({ length: mediaCount }, (_, i) => i),
            );

            // Property 4: Verify no data loss during enrichment
            const returnedMediaIds = data.posts[0].media.map(
              (m: any) => m.mediaId,
            );
            const expectedMediaIds = mediaItems.map((m) => m.mediaId);
            expect(returnedMediaIds).toEqual(expectedMediaIds);
          },
        ),
        { numRuns: 100 }, // Run 100 iterations as specified in design doc
      );
    });

    /**
     * Feature: feed-image-display, Property 2: MediaFile data is nested in PostMedia
     *
     * **Validates: Requirements 1.2**
     *
     * Property: For any post with media, when queried through the feed system,
     * each PostMedia relationship should include its associated MediaFile data
     * with all required fields (id, contentHash, mimeType, keys, dimensions).
     */
    it("Property 2: MediaFile data is nested in PostMedia", async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random number of media items (1-10)
          fc.integer({ min: 1, max: 10 }),
          // Generate random dimensions
          fc.record({
            width: fc.integer({ min: 100, max: 4000 }),
            height: fc.integer({ min: 100, max: 4000 }),
          }),
          // Generate random key presence (some media may not have thumbnail/optimized keys)
          fc.record({
            hasThumbnail: fc.boolean(),
            hasOptimized: fc.boolean(),
          }),
          async (mediaCount, dimensions, keyPresence) => {
            // Create media items with nested MediaFile data
            const mediaItems = Array.from({ length: mediaCount }, (_, i) => ({
              id: `pm-${i}`,
              mediaId: `media-${i}`,
              alt: `Image ${i}`,
              order: i,
              media: {
                id: `media-${i}`,
                contentHash: `hash-${i}-${Math.random().toString(36).substring(7)}`,
                mimeType: "image/jpeg",
                originalKey: `media/hash-${i}.jpg`,
                thumbnailKey: keyPresence.hasThumbnail
                  ? `media/hash-${i}_thumb.webp`
                  : null,
                optimizedKey: keyPresence.hasOptimized
                  ? `media/hash-${i}_opt.webp`
                  : null,
                width: dimensions.width,
                height: dimensions.height,
              },
            }));

            // Mock database to return post with media
            mockDb.post.findMany.mockResolvedValue([
              {
                id: "post-1",
                authorId: "user-123",
                text: "Test post with media",
                radius: PostRadius.SHOUT,
                createdAt: new Date("2024-01-01T10:00:00Z"),
                author: {
                  id: "user-123",
                  email: "test@example.com",
                },
                media: mediaItems,
              },
            ]);

            mockDb.postSentiment.groupBy.mockResolvedValue([]);
            mockDb.postSentiment.findMany.mockResolvedValue([]);
            mockDb.postComment.groupBy.mockResolvedValue([]);

            const request = new Request("http://test.com/feeds/home");
            const response = await handler.getHomeFeed(
              mockSession,
              request,
              mockEnv,
              { limit: 20 },
              mockRequestContext,
              TEST_TENANT_ID,
            );

            const data = await response.json();

            // Property: Verify each PostMedia includes nested MediaFile data
            expect(data.posts[0].media).toBeDefined();
            expect(data.posts[0].media.length).toBe(mediaCount);

            // Verify each media item has the nested file structure
            data.posts[0].media.forEach((mediaItem: any, index: number) => {
              // Verify PostMedia fields
              expect(mediaItem.id).toBe(`pm-${index}`);
              expect(mediaItem.mediaId).toBe(`media-${index}`);
              expect(mediaItem.alt).toBe(`Image ${index}`);
              expect(mediaItem.order).toBe(index);

              // Verify nested MediaFile data exists
              expect(mediaItem.file).toBeDefined();

              // Verify all required MediaFile fields are present
              expect(mediaItem.file.id).toBe(`media-${index}`);
              expect(mediaItem.file.contentHash).toBeDefined();
              expect(typeof mediaItem.file.contentHash).toBe("string");
              expect(mediaItem.file.mimeType).toBe("image/jpeg");

              // URLs should be full media endpoint URLs, not R2 storage keys
              const contentHash = mediaItem.file.contentHash;
              expect(mediaItem.file.originalKey).toBe(
                `https://api.rkm1.de/api/media/${contentHash}?variant=original`,
              );

              // Verify optional keys match expected presence
              if (keyPresence.hasThumbnail) {
                expect(mediaItem.file.thumbnailKey).toBe(
                  `https://api.rkm1.de/api/media/${contentHash}?variant=thumbnail`,
                );
              } else {
                expect(mediaItem.file.thumbnailKey).toBeNull();
              }

              if (keyPresence.hasOptimized) {
                expect(mediaItem.file.optimizedKey).toBe(
                  `https://api.rkm1.de/api/media/${contentHash}?variant=optimized`,
                );
              } else {
                expect(mediaItem.file.optimizedKey).toBeNull();
              }

              // Verify dimensions
              expect(mediaItem.file.width).toBe(dimensions.width);
              expect(mediaItem.file.height).toBe(dimensions.height);
            });

            // Verify query includes nested media select
            const findManyCall =
              mockDb.post.findMany.mock.calls[
                mockDb.post.findMany.mock.calls.length - 1
              ][0];
            expect(
              findManyCall.include.media.include.media.select,
            ).toBeDefined();

            // Verify all required fields are selected
            const mediaSelect = findManyCall.include.media.include.media.select;
            expect(mediaSelect.id).toBe(true);
            expect(mediaSelect.contentHash).toBe(true);
            expect(mediaSelect.mimeType).toBe(true);
            expect(mediaSelect.originalKey).toBe(true);
            expect(mediaSelect.thumbnailKey).toBe(true);
            expect(mediaSelect.optimizedKey).toBe(true);
            expect(mediaSelect.width).toBe(true);
            expect(mediaSelect.height).toBe(true);
          },
        ),
        { numRuns: 100 }, // Run 100 iterations as specified in design doc
      );
    });

    /**
     * Feature: feed-image-display, Property 4: Hidden and deleted media are filtered
     *
     * **Validates: Requirements 1.5, 7.1, 7.2**
     *
     * Property: For any post with a mix of visible and hidden/deleted media,
     * when queried through the feed system, only media where hidden=false
     * and deletedAt=null should be included in the results.
     */
    it("Property 4: Hidden and deleted media are filtered", async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random number of visible media items (0-5)
          fc.integer({ min: 0, max: 5 }),
          // Generate random number of hidden media items (0-5)
          fc.integer({ min: 0, max: 5 }),
          // Generate random number of deleted media items (0-5)
          fc.integer({ min: 0, max: 5 }),
          async (visibleCount, hiddenCount, deletedCount) => {
            // Create visible media items (hidden=false, deletedAt=null)
            const visibleMedia = Array.from(
              { length: visibleCount },
              (_, i) => ({
                id: `pm-visible-${i}`,
                mediaId: `media-visible-${i}`,
                alt: `Visible image ${i}`,
                order: i,
                media: {
                  id: `media-visible-${i}`,
                  contentHash: `hash-visible-${i}`,
                  mimeType: "image/jpeg",
                  originalKey: `media/hash-visible-${i}.jpg`,
                  thumbnailKey: `media/hash-visible-${i}_thumb.webp`,
                  optimizedKey: `media/hash-visible-${i}_opt.webp`,
                  width: 1920,
                  height: 1080,
                  hidden: false,
                  deletedAt: null,
                },
              }),
            );

            // Create hidden media items (hidden=true, deletedAt=null)
            const hiddenMedia = Array.from({ length: hiddenCount }, (_, i) => ({
              id: `pm-hidden-${i}`,
              mediaId: `media-hidden-${i}`,
              alt: `Hidden image ${i}`,
              order: visibleCount + i,
              media: {
                id: `media-hidden-${i}`,
                contentHash: `hash-hidden-${i}`,
                mimeType: "image/jpeg",
                originalKey: `media/hash-hidden-${i}.jpg`,
                thumbnailKey: `media/hash-hidden-${i}_thumb.webp`,
                optimizedKey: `media/hash-hidden-${i}_opt.webp`,
                width: 1920,
                height: 1080,
                hidden: true,
                deletedAt: null,
              },
            }));

            // Create deleted media items (hidden=false, deletedAt=<date>)
            const deletedMedia = Array.from(
              { length: deletedCount },
              (_, i) => ({
                id: `pm-deleted-${i}`,
                mediaId: `media-deleted-${i}`,
                alt: `Deleted image ${i}`,
                order: visibleCount + hiddenCount + i,
                media: {
                  id: `media-deleted-${i}`,
                  contentHash: `hash-deleted-${i}`,
                  mimeType: "image/jpeg",
                  originalKey: `media/hash-deleted-${i}.jpg`,
                  thumbnailKey: `media/hash-deleted-${i}_thumb.webp`,
                  optimizedKey: `media/hash-deleted-${i}_opt.webp`,
                  width: 1920,
                  height: 1080,
                  hidden: false,
                  deletedAt: new Date("2024-01-01T00:00:00Z"),
                },
              }),
            );

            // Mock database to return only visible media (simulating WHERE filter)
            // In real database, the WHERE clause filters out hidden and deleted media
            mockDb.post.findMany.mockResolvedValue([
              {
                id: "post-1",
                authorId: "user-123",
                text: "Test post with mixed media",
                radius: PostRadius.SHOUT,
                createdAt: new Date("2024-01-01T10:00:00Z"),
                author: {
                  id: "user-123",
                  email: "test@example.com",
                },
                // Only visible media is returned by the query
                media: visibleMedia,
              },
            ]);

            mockDb.postSentiment.groupBy.mockResolvedValue([]);
            mockDb.postSentiment.findMany.mockResolvedValue([]);
            mockDb.postComment.groupBy.mockResolvedValue([]);

            const request = new Request("http://test.com/feeds/home");
            const response = await handler.getHomeFeed(
              mockSession,
              request,
              mockEnv,
              { limit: 20 },
              mockRequestContext,
              TEST_TENANT_ID,
            );

            const data = await response.json();

            // Property 1: Verify query includes correct WHERE filters
            const findManyCall =
              mockDb.post.findMany.mock.calls[
                mockDb.post.findMany.mock.calls.length - 1
              ][0];
            expect(findManyCall.include.media).toBeDefined();
            expect(findManyCall.include.media.where).toBeDefined();
            expect(findManyCall.include.media.where.media.hidden).toBe(false);
            expect(findManyCall.include.media.where.media.deletedAt).toBe(null);

            // Property 2: Verify only visible media is returned
            expect(data.posts[0].media).toBeDefined();
            expect(data.posts[0].media.length).toBe(visibleCount);

            // Property 3: Verify no hidden media is in the results
            const returnedMediaIds = data.posts[0].media.map(
              (m: any) => m.mediaId,
            );
            const hiddenMediaIds = hiddenMedia.map((m) => m.mediaId);
            const deletedMediaIds = deletedMedia.map((m) => m.mediaId);

            hiddenMediaIds.forEach((hiddenId) => {
              expect(returnedMediaIds).not.toContain(hiddenId);
            });

            // Property 4: Verify no deleted media is in the results
            deletedMediaIds.forEach((deletedId) => {
              expect(returnedMediaIds).not.toContain(deletedId);
            });

            // Property 5: Verify all visible media is in the results
            const visibleMediaIds = visibleMedia.map((m) => m.mediaId);
            visibleMediaIds.forEach((visibleId) => {
              expect(returnedMediaIds).toContain(visibleId);
            });

            // Property 6: If no visible media, media array should be empty
            if (visibleCount === 0) {
              expect(data.posts[0].media).toEqual([]);
            }
          },
        ),
        { numRuns: 100 }, // Run 100 iterations as specified in design doc
      );
    });

    /**
     * Feature: feed-image-display, Property 1: Media relationships are included with correct ordering
     *
     * **Validates: Requirements 1.1, 1.4**
     *
     * Property: For any post with media, when queried through the feed system,
     * the returned post should include all PostMedia relationships ordered by
     * the order field in ascending order.
     */
    it("Property 1: Media relationships are included with correct ordering", async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random number of media items (1-10)
          fc.integer({ min: 1, max: 10 }),
          // Generate random order values (may be out of order initially)
          fc.array(fc.integer({ min: 0, max: 100 }), {
            minLength: 1,
            maxLength: 10,
          }),
          async (mediaCount, orderValues) => {
            // Create media items with potentially unordered values
            const mediaItems = Array.from({ length: mediaCount }, (_, i) => ({
              id: `pm-${i}`,
              mediaId: `media-${i}`,
              alt: `Image ${i}`,
              order: orderValues[i] || i,
              media: {
                id: `media-${i}`,
                contentHash: `hash-${i}`,
                mimeType: "image/jpeg",
                originalKey: `media/hash-${i}.jpg`,
                thumbnailKey: `media/hash-${i}_thumb.webp`,
                optimizedKey: `media/hash-${i}_opt.webp`,
                width: 1920,
                height: 1080,
              },
            }));

            // Sort media items by order field (simulating database orderBy behavior)
            const sortedMediaItems = [...mediaItems].sort(
              (a, b) => a.order - b.order,
            );

            // Mock database to return post with sorted media (as database would)
            mockDb.post.findMany.mockResolvedValue([
              {
                id: "post-1",
                authorId: "user-123",
                text: "Test post with media",
                radius: PostRadius.SHOUT,
                createdAt: new Date("2024-01-01T10:00:00Z"),
                author: {
                  id: "user-123",
                  email: "test@example.com",
                },
                media: sortedMediaItems,
              },
            ]);

            mockDb.postSentiment.groupBy.mockResolvedValue([]);
            mockDb.postSentiment.findMany.mockResolvedValue([]);
            mockDb.postComment.groupBy.mockResolvedValue([]);

            const request = new Request("http://test.com/feeds/home");
            const response = await handler.getHomeFeed(
              mockSession,
              request,
              mockEnv,
              { limit: 20 },
              mockRequestContext,
              TEST_TENANT_ID,
            );

            const data = await response.json();

            // Property 1: Verify media is included
            expect(data.posts[0].media).toBeDefined();
            expect(data.posts[0].media.length).toBe(mediaCount);

            // Property 2: Verify ordering is correct (ascending by order field)
            const returnedOrders = data.posts[0].media.map((m: any) => m.order);
            const sortedOrders = [...returnedOrders].sort((a, b) => a - b);
            expect(returnedOrders).toEqual(sortedOrders);

            // Property 3: Verify all media items are present
            const returnedMediaIds = data.posts[0].media.map(
              (m: any) => m.mediaId,
            );
            const expectedMediaIds = mediaItems.map((m) => m.mediaId);
            expect(returnedMediaIds.sort()).toEqual(expectedMediaIds.sort());

            // Property 4: Verify query structure includes correct filters
            const findManyCall =
              mockDb.post.findMany.mock.calls[
                mockDb.post.findMany.mock.calls.length - 1
              ][0];
            expect(findManyCall.include.media).toBeDefined();
            expect(findManyCall.include.media.where.media.hidden).toBe(false);
            expect(findManyCall.include.media.where.media.deletedAt).toBe(null);
            expect(findManyCall.include.media.orderBy).toEqual({
              order: "asc",
            });
          },
        ),
        { numRuns: 100 }, // Run 100 iterations as specified in design doc
      );
    });
  });

  describe("Cache Compatibility", () => {
    /**
     * Feature: feed-image-display, Property 5: Cached responses include media data
     *
     * **Validates: Requirements 2.3, 8.1, 8.5**
     *
     * Property: For any feed query result with media, when cached and retrieved
     * from cache, the cached response should contain the same media data as the
     * original query result.
     */
    it("Property 5: Cached responses include media data", async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random number of posts (1-5)
          fc.integer({ min: 1, max: 5 }),
          // Generate random number of media items per post (0-5)
          fc.integer({ min: 0, max: 5 }),
          // Generate random media properties
          fc.record({
            hasAlt: fc.boolean(),
            hasThumbnail: fc.boolean(),
            hasOptimized: fc.boolean(),
            width: fc.integer({ min: 100, max: 4000 }),
            height: fc.integer({ min: 100, max: 4000 }),
          }),
          async (postCount, mediaPerPost, mediaProps) => {
            // Create posts with media
            const posts = Array.from({ length: postCount }, (_, postIdx) => {
              const mediaItems = Array.from(
                { length: mediaPerPost },
                (_, mediaIdx) => ({
                  id: `pm-${postIdx}-${mediaIdx}`,
                  mediaId: `media-${postIdx}-${mediaIdx}`,
                  alt: mediaProps.hasAlt
                    ? `Alt text ${postIdx}-${mediaIdx}`
                    : null,
                  order: mediaIdx,
                  media: {
                    id: `media-${postIdx}-${mediaIdx}`,
                    contentHash: `hash-${postIdx}-${mediaIdx}-${Math.random().toString(36).substring(7)}`,
                    mimeType: "image/jpeg",
                    originalKey: `media/hash-${postIdx}-${mediaIdx}.jpg`,
                    thumbnailKey: mediaProps.hasThumbnail
                      ? `media/hash-${postIdx}-${mediaIdx}_thumb.webp`
                      : null,
                    optimizedKey: mediaProps.hasOptimized
                      ? `media/hash-${postIdx}-${mediaIdx}_opt.webp`
                      : null,
                    width: mediaProps.width,
                    height: mediaProps.height,
                  },
                }),
              );

              return {
                id: `post-${postIdx}`,
                authorId: "user-123",
                text: `Test post ${postIdx}`,
                radius: PostRadius.SHOUT,
                createdAt: new Date(`2024-01-0${postIdx + 1}T10:00:00Z`),
                author: {
                  id: "user-123",
                  email: "test@example.com",
                },
                media: mediaItems,
              };
            });

            // First request: Cache miss - query database
            mockDb.post.findMany.mockResolvedValue(posts);
            mockDb.postSentiment.groupBy.mockResolvedValue([]);
            mockDb.postSentiment.findMany.mockResolvedValue([]);
            mockDb.postComment.groupBy.mockResolvedValue([]);

            // Mock cache to return null (cache miss)
            let cachedData: any = null;
            mockEnv.FEED_CACHE_KV.get = vi
              .fn()
              .mockImplementation((key: string) => {
                if (key === "feed:cache:version") {
                  return Promise.resolve("1");
                }
                return Promise.resolve(cachedData);
              });

            // Mock cache put to capture cached data
            mockEnv.FEED_CACHE_KV.put = vi
              .fn()
              .mockImplementation((key: string, value: string) => {
                if (!key.includes("version")) {
                  cachedData = JSON.parse(value);
                }
                return Promise.resolve(undefined);
              });

            const request1 = new Request("http://test.com/feeds/home");
            const response1 = await handler.getHomeFeed(
              mockSession,
              request1,
              mockEnv,
              { limit: 20 },
              mockRequestContext,
              TEST_TENANT_ID,
            );

            const data1 = await response1.json();

            // Property 1: Verify data was cached
            expect(mockEnv.FEED_CACHE_KV.put).toHaveBeenCalled();
            expect(cachedData).toBeDefined();

            // Property 2: Verify cached data includes media
            expect(cachedData.posts).toBeDefined();
            expect(cachedData.posts.length).toBe(postCount);

            cachedData.posts.forEach((post: any, postIdx: number) => {
              if (mediaPerPost > 0) {
                expect(post.media).toBeDefined();
                expect(post.media.length).toBe(mediaPerPost);

                post.media.forEach((mediaItem: any, mediaIdx: number) => {
                  // Verify PostMedia fields
                  expect(mediaItem.id).toBe(`pm-${postIdx}-${mediaIdx}`);
                  expect(mediaItem.mediaId).toBe(
                    `media-${postIdx}-${mediaIdx}`,
                  );
                  expect(mediaItem.order).toBe(mediaIdx);

                  // Verify alt text
                  if (mediaProps.hasAlt) {
                    expect(mediaItem.alt).toBe(
                      `Alt text ${postIdx}-${mediaIdx}`,
                    );
                  } else {
                    expect(mediaItem.alt).toBeNull();
                  }

                  // Verify nested file structure
                  expect(mediaItem.file).toBeDefined();
                  expect(mediaItem.file.id).toBe(
                    `media-${postIdx}-${mediaIdx}`,
                  );
                  expect(mediaItem.file.contentHash).toBeDefined();
                  expect(mediaItem.file.mimeType).toBe("image/jpeg");

                  // URLs should be full media endpoint URLs, not R2 storage keys
                  const contentHash = mediaItem.file.contentHash;
                  expect(mediaItem.file.originalKey).toBe(
                    `https://api.rkm1.de/api/media/${contentHash}?variant=original`,
                  );

                  // Verify optional keys
                  if (mediaProps.hasThumbnail) {
                    expect(mediaItem.file.thumbnailKey).toBe(
                      `https://api.rkm1.de/api/media/${contentHash}?variant=thumbnail`,
                    );
                  } else {
                    expect(mediaItem.file.thumbnailKey).toBeNull();
                  }

                  if (mediaProps.hasOptimized) {
                    expect(mediaItem.file.optimizedKey).toBe(
                      `https://api.rkm1.de/api/media/${contentHash}?variant=optimized`,
                    );
                  } else {
                    expect(mediaItem.file.optimizedKey).toBeNull();
                  }

                  // Verify dimensions
                  expect(mediaItem.file.width).toBe(mediaProps.width);
                  expect(mediaItem.file.height).toBe(mediaProps.height);
                });
              } else {
                // Empty media array should be cached as empty array or undefined
                expect(
                  post.media === undefined || post.media.length === 0,
                ).toBe(true);
              }
            });

            // Second request: Cache hit - should return cached data
            vi.clearAllMocks();
            mockDb.post.findMany.mockClear();

            // Mock cache to return cached data (cache hit)
            mockEnv.FEED_CACHE_KV.get = vi
              .fn()
              .mockImplementation((key: string) => {
                if (key === "feed:cache:version") {
                  return Promise.resolve("1");
                }
                return Promise.resolve(cachedData);
              });

            const request2 = new Request("http://test.com/feeds/home");
            const response2 = await handler.getHomeFeed(
              mockSession,
              request2,
              mockEnv,
              { limit: 20 },
              mockRequestContext,
              TEST_TENANT_ID,
            );

            const data2 = await response2.json();

            // Property 3: Verify database was not queried (cache hit)
            expect(mockDb.post.findMany).not.toHaveBeenCalled();

            // Property 4: Verify cached response includes media data
            expect(data2.posts).toBeDefined();
            expect(data2.posts.length).toBe(postCount);

            data2.posts.forEach((post: any, postIdx: number) => {
              if (mediaPerPost > 0) {
                expect(post.media).toBeDefined();
                expect(post.media.length).toBe(mediaPerPost);

                post.media.forEach((mediaItem: any, mediaIdx: number) => {
                  // Verify all media data is present in cached response
                  expect(mediaItem.id).toBe(`pm-${postIdx}-${mediaIdx}`);
                  expect(mediaItem.mediaId).toBe(
                    `media-${postIdx}-${mediaIdx}`,
                  );
                  expect(mediaItem.order).toBe(mediaIdx);
                  expect(mediaItem.file).toBeDefined();
                  expect(mediaItem.file.id).toBe(
                    `media-${postIdx}-${mediaIdx}`,
                  );
                  expect(mediaItem.file.contentHash).toBeDefined();
                  expect(mediaItem.file.mimeType).toBe("image/jpeg");

                  // URLs should be full media endpoint URLs, not R2 storage keys
                  const contentHash = mediaItem.file.contentHash;
                  expect(mediaItem.file.originalKey).toBe(
                    `https://api.rkm1.de/api/media/${contentHash}?variant=original`,
                  );
                  expect(mediaItem.file.width).toBe(mediaProps.width);
                  expect(mediaItem.file.height).toBe(mediaProps.height);
                });
              }
            });

            // Property 5: Verify cached data matches original data
            expect(JSON.stringify(data2.posts)).toBe(
              JSON.stringify(data1.posts),
            );
          },
        ),
        { numRuns: 100 }, // Run 100 iterations as specified in design doc
      );
    });

    it("should cache feed responses with media data", async () => {
      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post with media",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: {
            id: "user-123",
            email: "test@example.com",
          },
          media: [
            {
              id: "pm-1",
              mediaId: "media-1",
              alt: "Test image",
              order: 0,
              media: {
                id: "media-1",
                contentHash: "abc123",
                mimeType: "image/jpeg",
                originalKey: "media/abc123.jpg",
                thumbnailKey: "media/abc123_thumb.webp",
                optimizedKey: "media/abc123_opt.webp",
                width: 1920,
                height: 1080,
              },
            },
          ],
        },
      ]);

      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      // Verify cache was called with media data
      expect(mockEnv.FEED_CACHE_KV.put).toHaveBeenCalled();
      const cacheCall = mockEnv.FEED_CACHE_KV.put.mock.calls[0];
      const cachedData = JSON.parse(cacheCall[1]);

      // Verify cached data includes media
      expect(cachedData.posts[0].media).toBeDefined();
      expect(cachedData.posts[0].media).toHaveLength(1);
      expect(cachedData.posts[0].media[0]).toEqual({
        id: "pm-1",
        mediaId: "media-1",
        alt: "Test image",
        order: 0,
        file: {
          id: "media-1",
          contentHash: "abc123",
          mimeType: "image/jpeg",
          originalKey: "https://api.rkm1.de/api/media/abc123?variant=original",
          thumbnailKey:
            "https://api.rkm1.de/api/media/abc123?variant=thumbnail",
          optimizedKey:
            "https://api.rkm1.de/api/media/abc123?variant=optimized",
          width: 1920,
          height: 1080,
        },
        // AI Act Art. 50 provenance is emitted on EVERY attachment, always
        // present and never omitted. This fixture's media row carries no
        // provenance columns, so it correctly resolves to UNKNOWN — which the
        // client must render as NOTHING, never as "human-created".
        provenance: {
          sourceType: "UNKNOWN",
          basis: null,
          disclosureRequired: false,
          labelKey: "provenance.unknown",
          labelDetailKey: "provenance.unknown.detail",
        },
      });
    });

    it("should return cached feed with media data on cache hit", async () => {
      const cachedFeed = {
        posts: [
          {
            id: "post-1",
            uri: "",
            text: "Cached post with media",
            author: {
              id: "user-123",
              email: "test@example.com",
              actorUri: "user-123",
              handle: "test",
            },
            createdAt: "2024-01-01T10:00:00.000Z",
            visibility: "public" as const,
            contentWarnings: [],
            sentimentCounts: {},
            commentCount: 0,
            isOwner: true,
            media: [
              {
                id: "pm-1",
                mediaId: "media-1",
                alt: "Cached image",
                order: 0,
                file: {
                  id: "media-1",
                  contentHash: "cached123",
                  mimeType: "image/jpeg",
                  originalKey: "media/cached123.jpg",
                  thumbnailKey: "media/cached123_thumb.webp",
                  optimizedKey: "media/cached123_opt.webp",
                  width: 1920,
                  height: 1080,
                },
              },
            ],
          },
        ],
        cursor: undefined,
        hasMore: false,
      };

      // Mock cache hit
      mockEnv.FEED_CACHE_KV.get = vi.fn().mockImplementation((key: string) => {
        if (key === "feed:cache:version") {
          return Promise.resolve("1");
        }
        return Promise.resolve(cachedFeed);
      });

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      // Verify database was not queried
      expect(mockDb.post.findMany).not.toHaveBeenCalled();

      // Verify cached media data is returned
      expect(data.posts[0].media).toBeDefined();
      expect(data.posts[0].media).toHaveLength(1);
      expect(data.posts[0].media[0]).toEqual({
        id: "pm-1",
        mediaId: "media-1",
        alt: "Cached image",
        order: 0,
        file: {
          id: "media-1",
          contentHash: "cached123",
          mimeType: "image/jpeg",
          originalKey: "media/cached123.jpg",
          thumbnailKey: "media/cached123_thumb.webp",
          optimizedKey: "media/cached123_opt.webp",
          width: 1920,
          height: 1080,
        },
        // NO `provenance` here, deliberately — and this asymmetry is the point.
        //
        // A cache hit returns the stored payload verbatim (feed-handler.ts:245)
        // and never runs enrichPosts, so a cache entry written by a build that
        // predates Art. 50 provenance has no provenance field and will be served
        // without one. This test pins that passthrough behaviour.
        //
        // OPERATIONAL CONSEQUENCE: on deploy, bump the KV-stored feed cache
        // version (`feed:cache:version`, see getCacheVersion) or accept a
        // TTL-length window in which warm-cache responses lack the field. There
        // is no code constant to change — the version is runtime state.
      });
    });

    it("should maintain cache key format with version", async () => {
      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: {
            id: "user-123",
            email: "test@example.com",
          },
          media: [],
        },
      ]);

      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      // Verify cache key format includes version
      expect(mockEnv.FEED_CACHE_KV.put).toHaveBeenCalled();
      const cacheKey = mockEnv.FEED_CACHE_KV.put.mock.calls[0][0];

      // Cache key format: feed:home:{region}:{tenantId}:v{version}:{userId}:{entityRefs}:{cursor}:{limit}
      //
      // The tenant segment is load-bearing, not cosmetic. A cache hit returns
      // before the post query's tenant AND is ever applied, so a key without the
      // tenant serves one tenant's feed to a viewer reading as another.
      expect(cacheKey).toMatch(
        new RegExp(`^feed:home:US:${TEST_TENANT_ID}:v\\d+:user-123:.*:initial:20$`),
      );
    });

    it("should handle cache miss and query database with media", async () => {
      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post with media",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: {
            id: "user-123",
            email: "test@example.com",
          },
          media: [
            {
              id: "pm-1",
              mediaId: "media-1",
              alt: "Test image",
              order: 0,
              media: {
                id: "media-1",
                contentHash: "abc123",
                mimeType: "image/jpeg",
                originalKey: "media/abc123.jpg",
                thumbnailKey: "media/abc123_thumb.webp",
                optimizedKey: "media/abc123_opt.webp",
                width: 1920,
                height: 1080,
              },
            },
          ],
        },
      ]);

      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      // Mock cache miss
      mockEnv.FEED_CACHE_KV.get = vi.fn().mockImplementation((key: string) => {
        if (key === "feed:cache:version") {
          return Promise.resolve("1");
        }
        return Promise.resolve(null);
      });

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      // Verify database was queried
      expect(mockDb.post.findMany).toHaveBeenCalled();

      // Verify media data is returned
      expect(data.posts[0].media).toBeDefined();
      expect(data.posts[0].media).toHaveLength(1);

      // Verify result was cached
      expect(mockEnv.FEED_CACHE_KV.put).toHaveBeenCalled();
    });

    it("should handle cache with empty media arrays", async () => {
      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post-1",
          authorId: "user-123",
          text: "Test post without media",
          radius: PostRadius.SHOUT,
          createdAt: new Date("2024-01-01T10:00:00Z"),
          author: {
            id: "user-123",
            email: "test@example.com",
          },
          media: [],
        },
      ]);

      mockDb.postSentiment.groupBy.mockResolvedValue([]);
      mockDb.postSentiment.findMany.mockResolvedValue([]);
      mockDb.postComment.groupBy.mockResolvedValue([]);

      const request = new Request("http://test.com/feeds/home");
      const response = await handler.getHomeFeed(
        mockSession,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
        TEST_TENANT_ID,
      );

      const data = await response.json();

      // Verify cache was called
      expect(mockEnv.FEED_CACHE_KV.put).toHaveBeenCalled();
      const cacheCall = mockEnv.FEED_CACHE_KV.put.mock.calls[0];
      const cachedData = JSON.parse(cacheCall[1]);

      // Verify empty media array is cached correctly
      expect(cachedData.posts[0].media).toEqual([]);
    });
  });
});
