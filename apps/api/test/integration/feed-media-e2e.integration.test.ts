/**
 * Integration Test: Feed Media End-to-End Flow
 *
 * Tests the complete end-to-end flow for feed image display:
 * 1. Create a post with media
 * 2. Query the feed
 * 3. Verify media is included in the response
 *
 * This test validates Requirements 1.1, 1.2, 1.3, 1.4, 1.5 from the feed-image-display spec.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTestUser,
  createTestUserWithSession,
  getDatabaseUrlWithFallback,
  type TestUser,
} from "../utils/test-auth.js";
import { PrismaClient } from "@prisma/client";
import { FeedHandler } from "../../src/lib/feed-handler.js";
import type { Env } from "../../src/env.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";
import type { Session } from "../../src/lib/session-cookie.js";

describe("Feed Media E2E Integration Tests", () => {
  let testUser: TestUser;
  let prisma: PrismaClient;
  let feedHandler: FeedHandler;
  let mockEnv: Env;
  let mockRequestContext: TrellisRequestContext;
  let testPostIds: string[] = [];
  let testMediaIds: string[] = [];

  beforeEach(async () => {
    // Get database URL
    const databaseUrl = await getDatabaseUrlWithFallback(
      process.env.DATABASE_URL || "",
    );
    if (!databaseUrl) {
      console.warn(
        "[Feed Media E2E] No database URL available, skipping tests",
      );
      return;
    }

    // Initialize Prisma client
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: databaseUrl,
        },
      },
    });

    // Create test user
    const { testUser: user } = await createTestUserWithSession();
    testUser = user;

    // Initialize feed handler
    feedHandler = new FeedHandler();

    // Setup mock environment
    mockEnv = {
      DATABASE_URL: databaseUrl,
      DEFAULT_REGION: "US",
      SESSION_SECRET: process.env.SESSION_SECRET || "test-secret",
      ENVIRONMENT: "test",
      APP_DOMAIN: "https://api.test.example.com",
      FEED_CACHE_KV: {
        get: async () => null, // Disable cache for integration tests
        put: async () => undefined,
        delete: async () => undefined,
        list: async () => ({ keys: [], list_complete: true, cursor: "" }),
      } as any,
    } as Env;

    // Setup mock request context
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
      session: {
        userId: testUser.id,
        email: testUser.email,
        expiresAt: Date.now() + 3600000,
        dataRegion: "US" as const,
        profileContext: "primary" as const,
      } as Session,
    };

    testPostIds = [];
    testMediaIds = [];
  }, 60000); // 60 second timeout for setup

  afterEach(async () => {
    // Clean up test data
    if (prisma && testMediaIds.length > 0) {
      try {
        await prisma.postMedia.deleteMany({
          where: { mediaId: { in: testMediaIds } },
        });
        await (prisma as any).mediaFile.deleteMany({
          where: { id: { in: testMediaIds } },
        });
      } catch (error) {
        console.warn("[Feed Media E2E] Error cleaning up media:", error);
      }
    }

    if (prisma && testPostIds.length > 0) {
      try {
        await prisma.post.deleteMany({
          where: { id: { in: testPostIds } },
        });
      } catch (error) {
        console.warn("[Feed Media E2E] Error cleaning up posts:", error);
      }
    }

    // Clean up test user
    if (testUser?.id) {
      await cleanupTestUser(testUser.id);
    }

    // Disconnect Prisma
    if (prisma) {
      await prisma.$disconnect();
    }
  }, 30000); // 30 second timeout for cleanup

  describe("End-to-End Flow: Create Post with Media → Query Feed → Verify Media", () => {
    it("should include single media item in feed response", async () => {
      if (!prisma || !testUser) {
        console.warn("[Feed Media E2E] Skipping test - no database or user");
        return;
      }

      // Step 1: Create a post
      const post = await prisma.post.create({
        data: {
          authorId: testUser.id,
          text: "Test post with single image",
          visibility: "PUBLIC",
        },
      });
      testPostIds.push(post.id);

      // Step 2: Create a media file
      const mediaFile = await (prisma as any).mediaFile.create({
        data: {
          contentHash: "test-hash-single",
          mimeType: "image/jpeg",
          size: 1024000,
          originalKey: "media/test-hash-single.jpg",
          thumbnailKey: "media/test-hash-single_thumb.webp",
          optimizedKey: "media/test-hash-single_opt.webp",
          width: 1920,
          height: 1080,
          hidden: false,
          deletedAt: null,
        },
      });
      testMediaIds.push(mediaFile.id);

      // Step 3: Link media to post
      await prisma.postMedia.create({
        data: {
          postId: post.id,
          mediaId: mediaFile.id,
          alt: "A beautiful test image",
          order: 0,
        },
      });

      // Step 4: Query the feed
      const request = new Request("http://test.com/feeds/home");
      const response = await feedHandler.getHomeFeed(
        mockRequestContext.session as Session,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
      );

      // Step 5: Verify response
      expect(response.status).toBe(200);
      const data = await response.json();

      // Step 6: Verify post is in feed
      expect(data.posts).toBeDefined();
      expect(Array.isArray(data.posts)).toBe(true);
      const feedPost = data.posts.find((p: any) => p.id === post.id);
      expect(feedPost).toBeDefined();

      // Step 7: Verify media is included (Requirement 1.1, 1.2, 1.3)
      expect(feedPost.media).toBeDefined();
      expect(Array.isArray(feedPost.media)).toBe(true);
      expect(feedPost.media.length).toBe(1);

      // Step 8: Verify media structure
      const media = feedPost.media[0];
      expect(media.id).toBeDefined();
      expect(media.mediaId).toBe(mediaFile.id);
      expect(media.alt).toBe("A beautiful test image");
      expect(media.order).toBe(0);

      // Step 9: Verify nested file data (Requirement 1.2)
      expect(media.file).toBeDefined();
      expect(media.file.id).toBe(mediaFile.id);
      expect(media.file.contentHash).toBe("test-hash-single");
      expect(media.file.mimeType).toBe("image/jpeg");
      expect(media.file.originalKey).toBe("media/test-hash-single.jpg");
      expect(media.file.thumbnailKey).toBe("media/test-hash-single_thumb.webp");
      expect(media.file.optimizedKey).toBe("media/test-hash-single_opt.webp");
      expect(media.file.width).toBe(1920);
      expect(media.file.height).toBe(1080);
    }, 60000); // 60 second timeout for integration test

    it("should include multiple media items in correct order", async () => {
      if (!prisma || !testUser) {
        console.warn("[Feed Media E2E] Skipping test - no database or user");
        return;
      }

      // Step 1: Create a post
      const post = await prisma.post.create({
        data: {
          authorId: testUser.id,
          text: "Test post with multiple images",
          visibility: "PUBLIC",
        },
      });
      testPostIds.push(post.id);

      // Step 2: Create multiple media files
      const mediaFiles = [];
      for (let i = 0; i < 3; i++) {
        const mediaFile = await (prisma as any).mediaFile.create({
          data: {
            contentHash: `test-hash-multi-${i}`,
            mimeType: "image/jpeg",
            size: 1024000,
            originalKey: `media/test-hash-multi-${i}.jpg`,
            thumbnailKey: `media/test-hash-multi-${i}_thumb.webp`,
            optimizedKey: `media/test-hash-multi-${i}_opt.webp`,
            width: 1920,
            height: 1080,
            hidden: false,
            deletedAt: null,
          },
        });
        testMediaIds.push(mediaFile.id);
        mediaFiles.push(mediaFile);
      }

      // Step 3: Link media to post in specific order
      for (let i = 0; i < mediaFiles.length; i++) {
        await prisma.postMedia.create({
          data: {
            postId: post.id,
            mediaId: mediaFiles[i].id,
            alt: `Image ${i}`,
            order: i,
          },
        });
      }

      // Step 4: Query the feed
      const request = new Request("http://test.com/feeds/home");
      const response = await feedHandler.getHomeFeed(
        mockRequestContext.session as Session,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
      );

      // Step 5: Verify response
      expect(response.status).toBe(200);
      const data = await response.json();

      // Step 6: Verify post is in feed
      const feedPost = data.posts.find((p: any) => p.id === post.id);
      expect(feedPost).toBeDefined();

      // Step 7: Verify all media items are included (Requirement 1.1)
      expect(feedPost.media).toBeDefined();
      expect(feedPost.media.length).toBe(3);

      // Step 8: Verify media is ordered correctly (Requirement 1.4)
      expect(feedPost.media[0].order).toBe(0);
      expect(feedPost.media[1].order).toBe(1);
      expect(feedPost.media[2].order).toBe(2);
      expect(feedPost.media[0].alt).toBe("Image 0");
      expect(feedPost.media[1].alt).toBe("Image 1");
      expect(feedPost.media[2].alt).toBe("Image 2");

      // Step 9: Verify each media item has complete data
      feedPost.media.forEach((media: any, index: number) => {
        expect(media.file).toBeDefined();
        expect(media.file.contentHash).toBe(`test-hash-multi-${index}`);
        expect(media.file.originalKey).toBe(
          `media/test-hash-multi-${index}.jpg`,
        );
      });
    }, 60000); // 60 second timeout for integration test

    it("should exclude hidden media from feed response", async () => {
      if (!prisma || !testUser) {
        console.warn("[Feed Media E2E] Skipping test - no database or user");
        return;
      }

      // Step 1: Create a post
      const post = await prisma.post.create({
        data: {
          authorId: testUser.id,
          text: "Test post with hidden media",
          visibility: "PUBLIC",
        },
      });
      testPostIds.push(post.id);

      // Step 2: Create visible media
      const visibleMedia = await (prisma as any).mediaFile.create({
        data: {
          contentHash: "test-hash-visible",
          mimeType: "image/jpeg",
          size: 1024000,
          originalKey: "media/test-hash-visible.jpg",
          thumbnailKey: "media/test-hash-visible_thumb.webp",
          optimizedKey: "media/test-hash-visible_opt.webp",
          width: 1920,
          height: 1080,
          hidden: false,
          deletedAt: null,
        },
      });
      testMediaIds.push(visibleMedia.id);

      // Step 3: Create hidden media
      const hiddenMedia = await (prisma as any).mediaFile.create({
        data: {
          contentHash: "test-hash-hidden",
          mimeType: "image/jpeg",
          size: 1024000,
          originalKey: "media/test-hash-hidden.jpg",
          thumbnailKey: "media/test-hash-hidden_thumb.webp",
          optimizedKey: "media/test-hash-hidden_opt.webp",
          width: 1920,
          height: 1080,
          hidden: true, // Hidden media
          deletedAt: null,
        },
      });
      testMediaIds.push(hiddenMedia.id);

      // Step 4: Link both media to post
      await prisma.postMedia.create({
        data: {
          postId: post.id,
          mediaId: visibleMedia.id,
          alt: "Visible image",
          order: 0,
        },
      });

      await prisma.postMedia.create({
        data: {
          postId: post.id,
          mediaId: hiddenMedia.id,
          alt: "Hidden image",
          order: 1,
        },
      });

      // Step 5: Query the feed
      const request = new Request("http://test.com/feeds/home");
      const response = await feedHandler.getHomeFeed(
        mockRequestContext.session as Session,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
      );

      // Step 6: Verify response
      expect(response.status).toBe(200);
      const data = await response.json();

      // Step 7: Verify post is in feed
      const feedPost = data.posts.find((p: any) => p.id === post.id);
      expect(feedPost).toBeDefined();

      // Step 8: Verify only visible media is included (Requirement 1.5)
      expect(feedPost.media).toBeDefined();
      expect(feedPost.media.length).toBe(1);
      expect(feedPost.media[0].mediaId).toBe(visibleMedia.id);
      expect(feedPost.media[0].alt).toBe("Visible image");

      // Step 9: Verify hidden media is NOT included
      const hiddenMediaIds = feedPost.media.map((m: any) => m.mediaId);
      expect(hiddenMediaIds).not.toContain(hiddenMedia.id);
    }, 60000); // 60 second timeout for integration test

    it("should exclude deleted media from feed response", async () => {
      if (!prisma || !testUser) {
        console.warn("[Feed Media E2E] Skipping test - no database or user");
        return;
      }

      // Step 1: Create a post
      const post = await prisma.post.create({
        data: {
          authorId: testUser.id,
          text: "Test post with deleted media",
          visibility: "PUBLIC",
        },
      });
      testPostIds.push(post.id);

      // Step 2: Create active media
      const activeMedia = await (prisma as any).mediaFile.create({
        data: {
          contentHash: "test-hash-active",
          mimeType: "image/jpeg",
          size: 1024000,
          originalKey: "media/test-hash-active.jpg",
          thumbnailKey: "media/test-hash-active_thumb.webp",
          optimizedKey: "media/test-hash-active_opt.webp",
          width: 1920,
          height: 1080,
          hidden: false,
          deletedAt: null,
        },
      });
      testMediaIds.push(activeMedia.id);

      // Step 3: Create deleted media
      const deletedMedia = await (prisma as any).mediaFile.create({
        data: {
          contentHash: "test-hash-deleted",
          mimeType: "image/jpeg",
          size: 1024000,
          originalKey: "media/test-hash-deleted.jpg",
          thumbnailKey: "media/test-hash-deleted_thumb.webp",
          optimizedKey: "media/test-hash-deleted_opt.webp",
          width: 1920,
          height: 1080,
          hidden: false,
          deletedAt: new Date(), // Deleted media
        },
      });
      testMediaIds.push(deletedMedia.id);

      // Step 4: Link both media to post
      await prisma.postMedia.create({
        data: {
          postId: post.id,
          mediaId: activeMedia.id,
          alt: "Active image",
          order: 0,
        },
      });

      await prisma.postMedia.create({
        data: {
          postId: post.id,
          mediaId: deletedMedia.id,
          alt: "Deleted image",
          order: 1,
        },
      });

      // Step 5: Query the feed
      const request = new Request("http://test.com/feeds/home");
      const response = await feedHandler.getHomeFeed(
        mockRequestContext.session as Session,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
      );

      // Step 6: Verify response
      expect(response.status).toBe(200);
      const data = await response.json();

      // Step 7: Verify post is in feed
      const feedPost = data.posts.find((p: any) => p.id === post.id);
      expect(feedPost).toBeDefined();

      // Step 8: Verify only active media is included (Requirement 1.5)
      expect(feedPost.media).toBeDefined();
      expect(feedPost.media.length).toBe(1);
      expect(feedPost.media[0].mediaId).toBe(activeMedia.id);
      expect(feedPost.media[0].alt).toBe("Active image");

      // Step 9: Verify deleted media is NOT included
      const activeMediaIds = feedPost.media.map((m: any) => m.mediaId);
      expect(activeMediaIds).not.toContain(deletedMedia.id);
    }, 60000); // 60 second timeout for integration test

    it("should handle posts without media gracefully", async () => {
      if (!prisma || !testUser) {
        console.warn("[Feed Media E2E] Skipping test - no database or user");
        return;
      }

      // Step 1: Create a post without media
      const post = await prisma.post.create({
        data: {
          authorId: testUser.id,
          text: "Test post without any media",
          visibility: "PUBLIC",
        },
      });
      testPostIds.push(post.id);

      // Step 2: Query the feed
      const request = new Request("http://test.com/feeds/home");
      const response = await feedHandler.getHomeFeed(
        mockRequestContext.session as Session,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
      );

      // Step 3: Verify response
      expect(response.status).toBe(200);
      const data = await response.json();

      // Step 4: Verify post is in feed
      const feedPost = data.posts.find((p: any) => p.id === post.id);
      expect(feedPost).toBeDefined();

      // Step 5: Verify media field is empty or undefined
      expect(feedPost.media === undefined || feedPost.media.length === 0).toBe(
        true,
      );
    }, 60000); // 60 second timeout for integration test

    it("should handle media with null optional fields", async () => {
      if (!prisma || !testUser) {
        console.warn("[Feed Media E2E] Skipping test - no database or user");
        return;
      }

      // Step 1: Create a post
      const post = await prisma.post.create({
        data: {
          authorId: testUser.id,
          text: "Test post with minimal media",
          visibility: "PUBLIC",
        },
      });
      testPostIds.push(post.id);

      // Step 2: Create media with null optional fields
      const mediaFile = await (prisma as any).mediaFile.create({
        data: {
          contentHash: "test-hash-minimal",
          mimeType: "image/jpeg",
          size: 1024000,
          originalKey: "media/test-hash-minimal.jpg",
          thumbnailKey: null, // No thumbnail
          optimizedKey: null, // No optimized version
          width: null, // No dimensions
          height: null,
          hidden: false,
          deletedAt: null,
        },
      });
      testMediaIds.push(mediaFile.id);

      // Step 3: Link media to post with null alt text
      await prisma.postMedia.create({
        data: {
          postId: post.id,
          mediaId: mediaFile.id,
          alt: null, // No alt text
          order: 0,
        },
      });

      // Step 4: Query the feed
      const request = new Request("http://test.com/feeds/home");
      const response = await feedHandler.getHomeFeed(
        mockRequestContext.session as Session,
        request,
        mockEnv,
        { limit: 20 },
        mockRequestContext,
      );

      // Step 5: Verify response
      expect(response.status).toBe(200);
      const data = await response.json();

      // Step 6: Verify post is in feed
      const feedPost = data.posts.find((p: any) => p.id === post.id);
      expect(feedPost).toBeDefined();

      // Step 7: Verify media is included with null fields
      expect(feedPost.media).toBeDefined();
      expect(feedPost.media.length).toBe(1);

      const media = feedPost.media[0];
      expect(media.alt).toBeNull();
      expect(media.file.thumbnailKey).toBeNull();
      expect(media.file.optimizedKey).toBeNull();
      expect(media.file.width).toBeNull();
      expect(media.file.height).toBeNull();
      expect(media.file.originalKey).toBe("media/test-hash-minimal.jpg");
    }, 60000); // 60 second timeout for integration test
  });
});
