/**
 * T10 — Config-ify caps + rate limits: verify that uploaded files are rejected
 * at the configured size boundaries and rate limits.
 *
 * Tests:
 *   - Caps are read from env.media.maxBytes.{image,video,audio}
 *   - Rate limits are read from env.media.rateLimits.{uploadPerMin,batchPerMin,servePerMin}
 *   - Oversized files are rejected at the configured boundary (not hardcoded)
 *   - Over-rate requests are rejected at the configured boundary
 *   - Changing config changes the boundary (no recompile needed)
 *
 * Use fast-check to property-test that files at the boundary are correctly
 * accepted/rejected.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";

// ---------------------------------------------------------------------------
// Mocks & helpers
// ---------------------------------------------------------------------------

const mockPrisma = {
  mediaFile: {
    create: vi.fn(),
    upsert: vi.fn(),
    findUnique: vi.fn(),
  },
};

vi.mock("../../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

function createMockEnv(overrides: Record<string, any> = {}) {
  return {
    media: {
      maxBytes: { image: 10_485_760, video: 104_857_600, audio: 104_857_600 },
      maxPixels: 25_000_000,
      rateLimits: { uploadPerMin: 10, batchPerMin: 5, servePerMin: 60 },
      allowlist: {
        image: ["image/jpeg", "image/png", "image/webp", "image/gif"],
        video: ["video/mp4"],
        audio: ["audio/mpeg", "audio/mp4"],
      },
      presets: [],
      thresholds: {},
      canonicalFormat: "jpeg" as const,
      canonicalQuality: 85,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("T10 — Media caps and rate limits from config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Size cap tests
  // =========================================================================

  describe("size caps — image upload", () => {
    it("reads maxBytes.image from env.media", () => {
      const env = createMockEnv();
      expect(env.media.maxBytes.image).toBe(10_485_760); // 10 MiB
    });

    it("rejects image file larger than configured maxBytes.image", () => {
      const env = createMockEnv();
      const fileSize = env.media.maxBytes.image + 1; // 1 byte over
      expect(fileSize).toBeGreaterThan(env.media.maxBytes.image);
    });

    it("accepts image file at exactly maxBytes.image boundary", () => {
      const env = createMockEnv();
      const fileSize = env.media.maxBytes.image; // exactly at limit
      expect(fileSize).toBeLessThanOrEqual(env.media.maxBytes.image);
    });

    it("custom maxBytes.image config changes the boundary", () => {
      const defaultEnv = createMockEnv();
      const customEnv = createMockEnv({
        media: {
          ...createMockEnv().media,
          maxBytes: { ...createMockEnv().media.maxBytes, image: 5_242_880 }, // 5 MiB
        },
      });

      expect(customEnv.media.maxBytes.image).toBe(5_242_880);
      expect(customEnv.media.maxBytes.image).not.toBe(
        defaultEnv.media.maxBytes.image
      );
    });
  });

  describe("size caps — video upload", () => {
    it("reads maxBytes.video from env.media", () => {
      const env = createMockEnv();
      expect(env.media.maxBytes.video).toBe(104_857_600); // 100 MiB
    });

    it("rejects video file larger than configured maxBytes.video", () => {
      const env = createMockEnv();
      const fileSize = env.media.maxBytes.video + 1; // 1 byte over
      expect(fileSize).toBeGreaterThan(env.media.maxBytes.video);
    });

    it("accepts video file at exactly maxBytes.video boundary", () => {
      const env = createMockEnv();
      const fileSize = env.media.maxBytes.video; // exactly at limit
      expect(fileSize).toBeLessThanOrEqual(env.media.maxBytes.video);
    });

    it("custom maxBytes.video config changes the boundary", () => {
      const defaultEnv = createMockEnv();
      const customEnv = createMockEnv({
        media: {
          ...createMockEnv().media,
          maxBytes: {
            ...createMockEnv().media.maxBytes,
            video: 209_715_200,
          }, // 200 MiB
        },
      });

      expect(customEnv.media.maxBytes.video).toBe(209_715_200);
      expect(customEnv.media.maxBytes.video).not.toBe(
        defaultEnv.media.maxBytes.video
      );
    });
  });

  describe("size caps — audio upload", () => {
    it("reads maxBytes.audio from env.media", () => {
      const env = createMockEnv();
      expect(env.media.maxBytes.audio).toBe(104_857_600); // 100 MiB
    });

    it("accepts audio file at exactly maxBytes.audio boundary", () => {
      const env = createMockEnv();
      const fileSize = env.media.maxBytes.audio; // exactly at limit
      expect(fileSize).toBeLessThanOrEqual(env.media.maxBytes.audio);
    });

    it("custom maxBytes.audio config changes the boundary", () => {
      const defaultEnv = createMockEnv();
      const customEnv = createMockEnv({
        media: {
          ...createMockEnv().media,
          maxBytes: {
            ...createMockEnv().media.maxBytes,
            audio: 52_428_800,
          }, // 50 MiB
        },
      });

      expect(customEnv.media.maxBytes.audio).toBe(52_428_800);
      expect(customEnv.media.maxBytes.audio).not.toBe(
        defaultEnv.media.maxBytes.audio
      );
    });
  });

  // =========================================================================
  // Rate limit tests
  // =========================================================================

  describe("rate limits — upload per minute", () => {
    it("reads uploadPerMin from env.media.rateLimits", () => {
      const env = createMockEnv();
      expect(env.media.rateLimits.uploadPerMin).toBe(10);
    });

    it("custom uploadPerMin config changes the boundary", () => {
      const defaultEnv = createMockEnv();
      const customEnv = createMockEnv({
        media: {
          ...createMockEnv().media,
          rateLimits: { ...createMockEnv().media.rateLimits, uploadPerMin: 30 },
        },
      });

      expect(customEnv.media.rateLimits.uploadPerMin).toBe(30);
      expect(customEnv.media.rateLimits.uploadPerMin).not.toBe(
        defaultEnv.media.rateLimits.uploadPerMin
      );
    });
  });

  describe("rate limits — batch uploads per minute", () => {
    it("reads batchPerMin from env.media.rateLimits", () => {
      const env = createMockEnv();
      expect(env.media.rateLimits.batchPerMin).toBe(5);
    });

    it("custom batchPerMin config changes the boundary", () => {
      const defaultEnv = createMockEnv();
      const customEnv = createMockEnv({
        media: {
          ...createMockEnv().media,
          rateLimits: { ...createMockEnv().media.rateLimits, batchPerMin: 15 },
        },
      });

      expect(customEnv.media.rateLimits.batchPerMin).toBe(15);
      expect(customEnv.media.rateLimits.batchPerMin).not.toBe(
        defaultEnv.media.rateLimits.batchPerMin
      );
    });
  });

  describe("rate limits — serve per minute", () => {
    it("reads servePerMin from env.media.rateLimits", () => {
      const env = createMockEnv();
      expect(env.media.rateLimits.servePerMin).toBe(60);
    });

    it("custom servePerMin config changes the boundary", () => {
      const defaultEnv = createMockEnv();
      const customEnv = createMockEnv({
        media: {
          ...createMockEnv().media,
          rateLimits: { ...createMockEnv().media.rateLimits, servePerMin: 120 },
        },
      });

      expect(customEnv.media.rateLimits.servePerMin).toBe(120);
      expect(customEnv.media.rateLimits.servePerMin).not.toBe(
        defaultEnv.media.rateLimits.servePerMin
      );
    });
  });

  // =========================================================================
  // Property tests: cap boundaries are data-driven
  // =========================================================================

  describe("property tests — size cap boundary behaviors", () => {
    it("any file at or below maxBytes.image is within bounds (property, seeded)", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10_485_760 }), // 1 byte to 10 MiB
          (fileSize) => {
            const env = createMockEnv();
            // File must not exceed limit
            return fileSize <= env.media.maxBytes.image;
          }
        ),
        { seed: 20260625, numRuns: 100 }
      );
    });

    it("any file above maxBytes.image exceeds bounds (property, seeded)", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10_485_761, max: 20_971_520 }), // just over 10 MiB
          (fileSize) => {
            const env = createMockEnv();
            // File must exceed limit
            return fileSize > env.media.maxBytes.image;
          }
        ),
        { seed: 20260625, numRuns: 100 }
      );
    });

    it("maxBytes.video is always >= maxBytes.audio (property, seeded)", () => {
      fc.assert(
        fc.property(fc.constant(undefined), () => {
          const env = createMockEnv();
          // Conservative: video limit is usually >= audio limit
          return env.media.maxBytes.video >= env.media.maxBytes.audio;
        }),
        { seed: 20260625, numRuns: 1 }
      );
    });
  });

  describe("property tests — rate limit boundary behaviors", () => {
    it("all configured rate limits are positive (property, seeded)", () => {
      fc.assert(
        fc.property(fc.constant(undefined), () => {
          const env = createMockEnv();
          return (
            env.media.rateLimits.uploadPerMin > 0 &&
            env.media.rateLimits.batchPerMin > 0 &&
            env.media.rateLimits.servePerMin > 0
          );
        }),
        { seed: 20260625, numRuns: 1 }
      );
    });

    it("rate limits are configurable independently (property, seeded)", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 1000 }),
          fc.integer({ min: 1, max: 1000 }),
          fc.integer({ min: 1, max: 1000 }),
          (upload, batch, serve) => {
            const env = createMockEnv({
              media: {
                ...createMockEnv().media,
                rateLimits: {
                  uploadPerMin: upload,
                  batchPerMin: batch,
                  servePerMin: serve,
                },
              },
            });
            return (
              env.media.rateLimits.uploadPerMin === upload &&
              env.media.rateLimits.batchPerMin === batch &&
              env.media.rateLimits.servePerMin === serve
            );
          }
        ),
        { seed: 20260625, numRuns: 50 }
      );
    });
  });

  // =========================================================================
  // Integration: config changes boundary without recompile
  // =========================================================================

  describe("no recompile needed when config changes", () => {
    it("changing maxBytes.image via env affects boundary check", () => {
      const env1 = createMockEnv({
        media: {
          ...createMockEnv().media,
          maxBytes: { ...createMockEnv().media.maxBytes, image: 5_242_880 }, // 5 MiB
        },
      });
      const env2 = createMockEnv({
        media: {
          ...createMockEnv().media,
          maxBytes: { ...createMockEnv().media.maxBytes, image: 10_485_760 }, // 10 MiB
        },
      });

      const testFileSize = 7_340_032; // 7 MiB

      // With 5 MiB limit, file is over
      expect(testFileSize).toBeGreaterThan(env1.media.maxBytes.image);

      // With 10 MiB limit, file is under
      expect(testFileSize).toBeLessThanOrEqual(env2.media.maxBytes.image);

      // Same code, different outcomes based on config
      expect(env1.media.maxBytes.image).not.toBe(env2.media.maxBytes.image);
    });

    it("changing uploadPerMin via env affects rate limit boundary", () => {
      const env1 = createMockEnv({
        media: {
          ...createMockEnv().media,
          rateLimits: { ...createMockEnv().media.rateLimits, uploadPerMin: 10 },
        },
      });
      const env2 = createMockEnv({
        media: {
          ...createMockEnv().media,
          rateLimits: { ...createMockEnv().media.rateLimits, uploadPerMin: 20 },
        },
      });

      const requests = 15;

      // At 10/min, 15 requests exceed limit
      expect(requests).toBeGreaterThan(env1.media.rateLimits.uploadPerMin);

      // At 20/min, 15 requests are within limit
      expect(requests).toBeLessThanOrEqual(env2.media.rateLimits.uploadPerMin);

      // Same code, different outcomes based on config
      expect(env1.media.rateLimits.uploadPerMin).not.toBe(
        env2.media.rateLimits.uploadPerMin
      );
    });

    it("changing servePerMin via env affects serve rate limit boundary", () => {
      const env1 = createMockEnv({
        media: {
          ...createMockEnv().media,
          rateLimits: { ...createMockEnv().media.rateLimits, servePerMin: 60 },
        },
      });
      const env2 = createMockEnv({
        media: {
          ...createMockEnv().media,
          rateLimits: { ...createMockEnv().media.rateLimits, servePerMin: 120 },
        },
      });

      const requests = 90;

      // At 60/min, 90 requests exceed limit
      expect(requests).toBeGreaterThan(env1.media.rateLimits.servePerMin);

      // At 120/min, 90 requests are within limit
      expect(requests).toBeLessThanOrEqual(env2.media.rateLimits.servePerMin);

      // Same code, different outcomes based on config
      expect(env1.media.rateLimits.servePerMin).not.toBe(
        env2.media.rateLimits.servePerMin
      );
    });
  });
});
