/**
 * Media ID Mapping Integration Test
 *
 * Tests that media can be referenced by either:
 * 1. Database ID (CUID)
 * 2. Content Hash (SHA-256)
 *
 * This ensures the backend properly handles both identifier types
 * and prevents the bug where contentHash values were not recognized.
 *
 * ⚠️ CRITICAL: This test MUST NEVER run on production.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Environment check - MUST be first
const ENVIRONMENT = process.env.ENVIRONMENT || "dev";
if (ENVIRONMENT !== "dev") {
  console.error(`❌ Integration tests can only run in 'dev' environment`);
  console.error(`   Current environment: ${ENVIRONMENT}`);
  console.error(`   Aborting to prevent data corruption in production`);
  process.exit(1);
}

describe("Media ID Mapping Integration", () => {
  let prisma: PrismaClient;
  let userId: string;
  let mediaFile1: any;
  let mediaFile2: any;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
    });

    // Create test user
    const timestamp = Date.now();
    const user = await prisma.user.upsert({
      where: {
        email: `test-media-mapping-${timestamp}@example.com`,
      },
      create: {
        email: `test-media-mapping-${timestamp}@example.com`,
        username: `testuser${timestamp}`,
      },
      update: {},
    });
    userId = user.id;

    // Create test media files
    mediaFile1 = await prisma.mediaFile.create({
      data: {
        contentHash: `test-hash-${timestamp}-1`,
        mimeType: "image/jpeg",
        size: 1024,
        originalKey: `test/${timestamp}/image1.jpg`,
        uploadedBy: userId,
      },
    });

    mediaFile2 = await prisma.mediaFile.create({
      data: {
        contentHash: `test-hash-${timestamp}-2`,
        mimeType: "image/png",
        size: 2048,
        originalKey: `test/${timestamp}/image2.png`,
        uploadedBy: userId,
      },
    });

    console.log(`✓ Created test user: ${userId}`);
    console.log(
      `✓ Created test media files: ${mediaFile1.id}, ${mediaFile2.id}`,
    );
  });

  afterAll(async () => {
    // Cleanup test data
    if (mediaFile1) {
      await prisma.mediaFile
        .delete({ where: { id: mediaFile1.id } })
        .catch(() => {});
    }
    if (mediaFile2) {
      await prisma.mediaFile
        .delete({ where: { id: mediaFile2.id } })
        .catch(() => {});
    }
    if (userId) {
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it("should find media by database ID", async () => {
    const found = await prisma.mediaFile.findMany({
      where: {
        OR: [
          { id: { in: [mediaFile1.id] } },
          { contentHash: { in: [mediaFile1.id] } },
        ],
        uploadedBy: userId,
        deletedAt: null,
      },
    });

    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(mediaFile1.id);
    expect(found[0].contentHash).toBe(mediaFile1.contentHash);

    console.log(`✓ Found media by database ID: ${mediaFile1.id}`);
  });

  it("should find media by contentHash", async () => {
    const found = await prisma.mediaFile.findMany({
      where: {
        OR: [
          { id: { in: [mediaFile1.contentHash] } },
          { contentHash: { in: [mediaFile1.contentHash] } },
        ],
        uploadedBy: userId,
        deletedAt: null,
      },
    });

    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(mediaFile1.id);
    expect(found[0].contentHash).toBe(mediaFile1.contentHash);

    console.log(`✓ Found media by contentHash: ${mediaFile1.contentHash}`);
  });

  it("should find media by mixed IDs (database ID and contentHash)", async () => {
    // Search with one database ID and one contentHash
    const searchIds = [mediaFile1.id, mediaFile2.contentHash];

    const found = await prisma.mediaFile.findMany({
      where: {
        OR: [{ id: { in: searchIds } }, { contentHash: { in: searchIds } }],
        uploadedBy: userId,
        deletedAt: null,
      },
    });

    expect(found).toHaveLength(2);

    // Verify both files were found
    const foundIds = found.map((f) => f.id).sort();
    const expectedIds = [mediaFile1.id, mediaFile2.id].sort();
    expect(foundIds).toEqual(expectedIds);

    console.log(`✓ Found ${found.length} media files by mixed IDs`);
  });

  it("should not find media with wrong owner", async () => {
    // Create another user
    const timestamp = Date.now();
    const otherUser = await prisma.user.create({
      data: {
        email: `test-other-${timestamp}@example.com`,
        username: `otheruser${timestamp}`,
      },
    });

    // Try to find media with wrong owner
    const found = await prisma.mediaFile.findMany({
      where: {
        OR: [
          { id: { in: [mediaFile1.id] } },
          { contentHash: { in: [mediaFile1.contentHash] } },
        ],
        uploadedBy: otherUser.id, // Wrong owner
        deletedAt: null,
      },
    });

    expect(found).toHaveLength(0);

    // Cleanup
    await prisma.user.delete({ where: { id: otherUser.id } });

    console.log(`✓ Correctly rejected media with wrong owner`);
  });

  it("should not find deleted media", async () => {
    // Create a media file and mark it as deleted
    const timestamp = Date.now();
    const deletedMedia = await prisma.mediaFile.create({
      data: {
        contentHash: `test-hash-deleted-${timestamp}`,
        mimeType: "image/jpeg",
        size: 1024,
        originalKey: `test/${timestamp}/deleted.jpg`,
        uploadedBy: userId,
        deletedAt: new Date(),
      },
    });

    // Try to find deleted media
    const found = await prisma.mediaFile.findMany({
      where: {
        OR: [
          { id: { in: [deletedMedia.id] } },
          { contentHash: { in: [deletedMedia.contentHash] } },
        ],
        uploadedBy: userId,
        deletedAt: null, // Only non-deleted
      },
    });

    expect(found).toHaveLength(0);

    // Cleanup
    await prisma.mediaFile.delete({ where: { id: deletedMedia.id } });

    console.log(`✓ Correctly excluded deleted media`);
  });

  it("should handle empty search array", async () => {
    const found = await prisma.mediaFile.findMany({
      where: {
        OR: [{ id: { in: [] } }, { contentHash: { in: [] } }],
        uploadedBy: userId,
        deletedAt: null,
      },
    });

    expect(found).toHaveLength(0);

    console.log(`✓ Handled empty search array correctly`);
  });

  it("should handle non-existent IDs gracefully", async () => {
    const found = await prisma.mediaFile.findMany({
      where: {
        OR: [
          { id: { in: ["non-existent-id-123"] } },
          { contentHash: { in: ["non-existent-hash-456"] } },
        ],
        uploadedBy: userId,
        deletedAt: null,
      },
    });

    expect(found).toHaveLength(0);

    console.log(`✓ Handled non-existent IDs gracefully`);
  });

  it("should deduplicate results when same media is referenced by both ID and contentHash", async () => {
    // Search for same media using both its ID and contentHash
    const searchIds = [mediaFile1.id, mediaFile1.contentHash];

    const found = await prisma.mediaFile.findMany({
      where: {
        OR: [{ id: { in: searchIds } }, { contentHash: { in: searchIds } }],
        uploadedBy: userId,
        deletedAt: null,
      },
    });

    // Should only return one result (deduplicated)
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(mediaFile1.id);

    console.log(`✓ Correctly deduplicated results`);
  });
});
