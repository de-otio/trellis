/**
 * Integration Tests: Media Handler
 *
 * Tests the full flow of media collection operations with real database interactions.
 * These tests verify:
 * - Large dataset grouping correctness
 * - Stats accuracy
 * - Hidden/deleted exclusion
 * - Type filters
 * - Cursor pagination
 */

import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  describe,
  expect,
  it,
} from "vitest";
import { MediaHandler } from "../../src/lib/media-handler.js";
import type { Env } from "../../src/env.js";
import {
  createTestUserWithSession,
  cleanupTestUser,
  getDatabaseUrlWithFallback,
} from "../utils/test-auth.js";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

describe("MediaHandler Integration Tests", () => {
  let handler: MediaHandler;
  let mockEnv: Env;
  let testUser: any;
  let prisma: PrismaClient;
  let testPostIds: string[] = [];
  let testMediaIds: string[] = [];

  beforeAll(async () => {
    // Get database URL
    const databaseUrl = await getDatabaseUrlWithFallback(
      process.env.DATABASE_URL || "",
    );
    if (!databaseUrl) {
      console.warn(
        "[MediaHandler Integration] No database URL available, skipping tests",
      );
      return;
    }

    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
  });

  beforeEach(async () => {
    handler = new MediaHandler();

    mockEnv = {
      DATABASE_URL: process.env.DATABASE_URL || "",
      DEFAULT_REGION: "US",
      SESSION_SECRET: process.env.SESSION_SECRET || "test-secret",
      ENVIRONMENT: "test",
      APP_DOMAIN: "https://api.test.example.com",
    } as Env;

    // Create test user
    const { testUser: user } = await createTestUserWithSession();
    testUser = user;
    testPostIds = [];
    testMediaIds = [];
  });

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
        console.warn(
          "[MediaHandler Integration] Error cleaning up media:",
          error,
        );
      }
    }

    if (prisma && testPostIds.length > 0) {
      try {
        await prisma.post.deleteMany({
          where: { id: { in: testPostIds } },
        });
      } catch (error) {
        console.warn(
          "[MediaHandler Integration] Error cleaning up posts:",
          error,
        );
      }
    }

    // Clean up test user
    if (testUser) {
      await cleanupTestUser(testUser.id);
    }
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  describe("listUserMedia - Cursor Pagination", () => {
    it("should paginate through media correctly", async () => {
      // Create test posts with media
      const post1 = await prisma.post.create({
        data: {
          authorId: testUser.id,
          text: "Test post 1",
          visibility: "PUBLIC",
        },
      });
      testPostIds.push(post1.id);

      const media1 = await (prisma as any).mediaFile.create({
        data: {
          contentHash: "hash1",
          mimeType: "image/jpeg",
          size: 1000,
          originalKey: "media/hash1.jpg",
          createdAt: new Date("2025-01-15T10:00:00Z"),
        },
      });
      testMediaIds.push(media1.id);

      await prisma.postMedia.create({
        data: {
          postId: post1.id,
          mediaId: media1.id,
        },
      });

      // First page
      const page1 = await handler.listUserMedia(
        testUser.id,
        { limit: 1, sort: "newest" },
        mockEnv,
      );

      expect(page1.media).toHaveLength(1);
      expect(page1.cursor).toBeTruthy();

      // Second page (should be empty since we only have 1 media)
      const page2 = await handler.listUserMedia(
        testUser.id,
        { limit: 1, cursor: page1.cursor!, sort: "newest" },
        mockEnv,
      );

      expect(page2.media).toHaveLength(0);
      expect(page2.cursor).toBeNull();
    });

    it("should handle totalCount option", async () => {
      // Create multiple media items
      const post = await prisma.post.create({
        data: {
          authorId: testUser.id,
          text: "Test post",
          visibility: "PUBLIC",
        },
      });
      testPostIds.push(post.id);

      for (let i = 0; i < 5; i++) {
        const media = await (prisma as any).mediaFile.create({
          data: {
            contentHash: `hash${i}`,
            mimeType: "image/jpeg",
            size: 1000,
            originalKey: `media/hash${i}.jpg`,
            createdAt: new Date(`2025-01-${15 + i}T10:00:00Z`),
          },
        });
        testMediaIds.push(media.id);

        await prisma.postMedia.create({
          data: {
            postId: post.id,
            mediaId: media.id,
          },
        });
      }

      const result = await handler.listUserMedia(
        testUser.id,
        { limit: 2, includeTotalCount: true },
        mockEnv,
      );

      expect(result.totalCount).toBe(5);
      expect(result.media).toHaveLength(2);
    });
  });

  describe("listUserMediaGrouped - Grouping Correctness", () => {
    it("should group media by month correctly", async () => {
      const post = await prisma.post.create({
        data: {
          authorId: testUser.id,
          text: "Test post",
          visibility: "PUBLIC",
        },
      });
      testPostIds.push(post.id);

      // Create media in different months
      const dates = [
        "2025-01-15T10:00:00Z",
        "2025-01-20T10:00:00Z",
        "2025-02-10T10:00:00Z",
        "2024-12-05T10:00:00Z",
      ];

      for (const date of dates) {
        const media = await (prisma as any).mediaFile.create({
          data: {
            contentHash: `hash-${date}`,
            mimeType: "image/jpeg",
            size: 1000,
            originalKey: `media/hash-${date}.jpg`,
            createdAt: new Date(date),
          },
        });
        testMediaIds.push(media.id);

        await prisma.postMedia.create({
          data: {
            postId: post.id,
            mediaId: media.id,
          },
        });
      }

      const result = await handler.listUserMediaGrouped(
        testUser.id,
        "month",
        {},
        mockEnv,
      );

      expect(result.groups.length).toBeGreaterThanOrEqual(3); // 2025-01, 2025-02, 2024-12
      const jan2025 = result.groups.find((g) => g.period === "2025-01");
      expect(jan2025).toBeDefined();
      expect(jan2025?.count).toBe(2);
    });

    it("should group media by year correctly", async () => {
      const post = await prisma.post.create({
        data: {
          authorId: testUser.id,
          text: "Test post",
          visibility: "PUBLIC",
        },
      });
      testPostIds.push(post.id);

      // Create media in different years
      const dates = [
        "2025-01-15T10:00:00Z",
        "2025-06-20T10:00:00Z",
        "2024-12-05T10:00:00Z",
      ];

      for (const date of dates) {
        const media = await (prisma as any).mediaFile.create({
          data: {
            contentHash: `hash-${date}`,
            mimeType: "image/jpeg",
            size: 1000,
            originalKey: `media/hash-${date}.jpg`,
            createdAt: new Date(date),
          },
        });
        testMediaIds.push(media.id);

        await prisma.postMedia.create({
          data: {
            postId: post.id,
            mediaId: media.id,
          },
        });
      }

      const result = await handler.listUserMediaGrouped(
        testUser.id,
        "year",
        {},
        mockEnv,
      );

      expect(result.groups.length).toBeGreaterThanOrEqual(2); // 2025, 2024
      const year2025 = result.groups.find((g) => g.period === "2025");
      expect(year2025).toBeDefined();
      expect(year2025?.count).toBe(2);
    });
  });

  describe("getUserMediaStats - Stats Accuracy", () => {
    it("should calculate stats correctly", async () => {
      const post = await prisma.post.create({
        data: {
          authorId: testUser.id,
          text: "Test post",
          visibility: "PUBLIC",
        },
      });
      testPostIds.push(post.id);

      // Create mix of photos and videos
      const mediaData = [
        { type: "image/jpeg", hash: "photo1" },
        { type: "image/png", hash: "photo2" },
        { type: "video/mp4", hash: "video1" },
        { type: "image/jpeg", hash: "photo3", hidden: true },
      ];

      for (const data of mediaData) {
        const media = await (prisma as any).mediaFile.create({
          data: {
            contentHash: data.hash,
            mimeType: data.type,
            size: 1000,
            originalKey: `media/${data.hash}.${data.type.includes("image") ? "jpg" : "mp4"}`,
            hidden: data.hidden || false,
            createdAt: new Date("2025-01-15T10:00:00Z"),
          },
        });
        testMediaIds.push(media.id);

        await prisma.postMedia.create({
          data: {
            postId: post.id,
            mediaId: media.id,
          },
        });
      }

      const stats = await handler.getUserMediaStats(testUser.id, {}, mockEnv);

      expect(stats.totalCount).toBe(3); // Hidden media excluded by default
      expect(stats.photoCount).toBe(2);
      expect(stats.videoCount).toBe(1);
      expect(stats.hiddenCount).toBe(1);
      expect(stats.totalSize).toBe(3000); // 3 visible media * 1000 bytes
    });

    it("should include hidden media when requested", async () => {
      const post = await prisma.post.create({
        data: {
          authorId: testUser.id,
          text: "Test post",
          visibility: "PUBLIC",
        },
      });
      testPostIds.push(post.id);

      const media = await (prisma as any).mediaFile.create({
        data: {
          contentHash: "hidden1",
          mimeType: "image/jpeg",
          size: 1000,
          originalKey: "media/hidden1.jpg",
          hidden: true,
          createdAt: new Date("2025-01-15T10:00:00Z"),
        },
      });
      testMediaIds.push(media.id);

      await prisma.postMedia.create({
        data: {
          postId: post.id,
          mediaId: media.id,
        },
      });

      const stats = await handler.getUserMediaStats(
        testUser.id,
        { includeHidden: true },
        mockEnv,
      );

      expect(stats.totalCount).toBe(1);
      expect(stats.hiddenCount).toBe(1);
    });
  });

  describe("Type Filters", () => {
    it("should filter by photo type", async () => {
      const post = await prisma.post.create({
        data: {
          authorId: testUser.id,
          text: "Test post",
          visibility: "PUBLIC",
        },
      });
      testPostIds.push(post.id);

      // Create photos and videos
      const photo = await (prisma as any).mediaFile.create({
        data: {
          contentHash: "photo1",
          mimeType: "image/jpeg",
          size: 1000,
          originalKey: "media/photo1.jpg",
          createdAt: new Date("2025-01-15T10:00:00Z"),
        },
      });
      testMediaIds.push(photo.id);

      const video = await (prisma as any).mediaFile.create({
        data: {
          contentHash: "video1",
          mimeType: "video/mp4",
          size: 2000,
          originalKey: "media/video1.mp4",
          createdAt: new Date("2025-01-15T10:00:00Z"),
        },
      });
      testMediaIds.push(video.id);

      await prisma.postMedia.createMany({
        data: [
          { postId: post.id, mediaId: photo.id },
          { postId: post.id, mediaId: video.id },
        ],
      });

      const photos = await handler.listUserMedia(
        testUser.id,
        { type: "photo" },
        mockEnv,
      );

      expect(photos.media).toHaveLength(1);
      expect(photos.media[0].mimeType).toMatch(/^image\//);
    });

    it("should filter by video type", async () => {
      const post = await prisma.post.create({
        data: {
          authorId: testUser.id,
          text: "Test post",
          visibility: "PUBLIC",
        },
      });
      testPostIds.push(post.id);

      const photo = await (prisma as any).mediaFile.create({
        data: {
          contentHash: "photo1",
          mimeType: "image/jpeg",
          size: 1000,
          originalKey: "media/photo1.jpg",
          createdAt: new Date("2025-01-15T10:00:00Z"),
        },
      });
      testMediaIds.push(photo.id);

      const video = await (prisma as any).mediaFile.create({
        data: {
          contentHash: "video1",
          mimeType: "video/mp4",
          size: 2000,
          originalKey: "media/video1.mp4",
          createdAt: new Date("2025-01-15T10:00:00Z"),
        },
      });
      testMediaIds.push(video.id);

      await prisma.postMedia.createMany({
        data: [
          { postId: post.id, mediaId: photo.id },
          { postId: post.id, mediaId: video.id },
        ],
      });

      const videos = await handler.listUserMedia(
        testUser.id,
        { type: "video" },
        mockEnv,
      );

      expect(videos.media).toHaveLength(1);
      expect(videos.media[0].mimeType).toMatch(/^video\//);
    });
  });

  describe("Hidden/Deleted Exclusion", () => {
    it("should exclude hidden media by default", async () => {
      const post = await prisma.post.create({
        data: {
          authorId: testUser.id,
          text: "Test post",
          visibility: "PUBLIC",
        },
      });
      testPostIds.push(post.id);

      const visible = await (prisma as any).mediaFile.create({
        data: {
          contentHash: "visible1",
          mimeType: "image/jpeg",
          size: 1000,
          originalKey: "media/visible1.jpg",
          hidden: false,
          createdAt: new Date("2025-01-15T10:00:00Z"),
        },
      });
      testMediaIds.push(visible.id);

      const hidden = await (prisma as any).mediaFile.create({
        data: {
          contentHash: "hidden1",
          mimeType: "image/jpeg",
          size: 1000,
          originalKey: "media/hidden1.jpg",
          hidden: true,
          createdAt: new Date("2025-01-15T10:00:00Z"),
        },
      });
      testMediaIds.push(hidden.id);

      await prisma.postMedia.createMany({
        data: [
          { postId: post.id, mediaId: visible.id },
          { postId: post.id, mediaId: hidden.id },
        ],
      });

      const result = await handler.listUserMedia(testUser.id, {}, mockEnv);

      expect(result.media).toHaveLength(1);
      expect(result.media[0].id).toBe(visible.id);
    });

    it("should exclude deleted media", async () => {
      const post = await prisma.post.create({
        data: {
          authorId: testUser.id,
          text: "Test post",
          visibility: "PUBLIC",
        },
      });
      testPostIds.push(post.id);

      const active = await (prisma as any).mediaFile.create({
        data: {
          contentHash: "active1",
          mimeType: "image/jpeg",
          size: 1000,
          originalKey: "media/active1.jpg",
          deletedAt: null,
          createdAt: new Date("2025-01-15T10:00:00Z"),
        },
      });
      testMediaIds.push(active.id);

      const deleted = await (prisma as any).mediaFile.create({
        data: {
          contentHash: "deleted1",
          mimeType: "image/jpeg",
          size: 1000,
          originalKey: "media/deleted1.jpg",
          deletedAt: new Date(),
          createdAt: new Date("2025-01-15T10:00:00Z"),
        },
      });
      testMediaIds.push(deleted.id);

      await prisma.postMedia.createMany({
        data: [
          { postId: post.id, mediaId: active.id },
          { postId: post.id, mediaId: deleted.id },
        ],
      });

      const result = await handler.listUserMedia(testUser.id, {}, mockEnv);

      expect(result.media).toHaveLength(1);
      expect(result.media[0].id).toBe(active.id);
    });
  });
});
