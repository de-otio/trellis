/**
 * Unit Tests: Moderation Handler
 *
 * Tests moderation handler with mocked OpenAI Moderation API.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { ModerationHandler } from "../../src/lib/moderation-handler.js";
import { MockKV, createMockEnv } from "../utils/mock-env.js";

describe("ModerationHandler", () => {
  let handler: ModerationHandler;
  let mockEnv: any;
  let mockKV: MockKV;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    handler = new ModerationHandler();
    mockKV = new MockKV();
    mockEnv = createMockEnv({
      OPENAI_API_KEY: "test-api-key",
      MODERATION_CACHE_KV: mockKV as any,
    });
    // Save original fetch
    originalFetch = global.fetch;
  });

  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch;
  });

  describe("moderateText", () => {
    it("should approve clean text", async () => {
      // Mock OpenAI Moderation API response
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              flagged: false,
              categories: {
                hate: false,
                "hate/threatening": false,
                harassment: false,
                "harassment/threatening": false,
                "self-harm": false,
                "self-harm/intent": false,
                "self-harm/instructions": false,
                sexual: false,
                "sexual/minors": false,
                violence: false,
                "violence/graphic": false,
              },
              category_scores: {
                hate: 0.001,
                "hate/threatening": 0.0001,
                harassment: 0.01,
                "harassment/threatening": 0.0001,
                "self-harm": 0.0,
                "self-harm/intent": 0.0,
                "self-harm/instructions": 0.0,
                sexual: 0.0,
                "sexual/minors": 0.0,
                violence: 0.0,
                "violence/graphic": 0.0,
              },
            },
          ],
        }),
      });

      const result = await handler.moderateText(
        "This is a nice post!",
        mockEnv,
      );

      expect(result.approved).toBe(true);
      expect(
        Math.max(...Object.values(result.details!.categoryScores)),
      ).toBeLessThan(0.7);
      expect(result.details?.categories.harassment).toBe(false);
    });

    it("should reject toxic text", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              flagged: true,
              categories: {
                hate: false,
                "hate/threatening": false,
                harassment: true,
                "harassment/threatening": false,
                "self-harm": false,
                "self-harm/intent": false,
                "self-harm/instructions": false,
                sexual: false,
                "sexual/minors": false,
                violence: true,
                "violence/graphic": false,
              },
              category_scores: {
                hate: 0.05,
                "hate/threatening": 0.01,
                harassment: 0.95,
                "harassment/threatening": 0.1,
                "self-harm": 0.0,
                "self-harm/intent": 0.0,
                "self-harm/instructions": 0.0,
                sexual: 0.0,
                "sexual/minors": 0.0,
                violence: 0.89,
                "violence/graphic": 0.0,
              },
            },
          ],
        }),
      });

      const result = await handler.moderateText("You are terrible!", mockEnv);

      expect(result.approved).toBe(false);
      expect(
        Math.max(...Object.values(result.details!.categoryScores)),
      ).toBeGreaterThan(0.7);
      expect(result.details?.categories.harassment).toBe(true);
    });

    it("should cache results", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              flagged: false,
              categories: {
                hate: false,
                "hate/threatening": false,
                harassment: false,
                "harassment/threatening": false,
                "self-harm": false,
                "self-harm/intent": false,
                "self-harm/instructions": false,
                sexual: false,
                "sexual/minors": false,
                violence: false,
                "violence/graphic": false,
              },
              category_scores: {
                hate: 0.001,
                "hate/threatening": 0.0001,
                harassment: 0.01,
                "harassment/threatening": 0.0001,
                "self-harm": 0.0,
                "self-harm/intent": 0.0,
                "self-harm/instructions": 0.0,
                sexual: 0.0,
                "sexual/minors": 0.0,
                violence: 0.0,
                "violence/graphic": 0.0,
              },
            },
          ],
        }),
      });

      const text = "This is a test post";

      // First call
      const result1 = await handler.moderateText(text, mockEnv);

      // Second call should use cache
      const result2 = await handler.moderateText(text, mockEnv);

      expect(result1.approved).toBe(true);
      expect(result2.approved).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1); // Only called once due to caching
    });

    it("should fail open if API is unavailable", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const result = await handler.moderateText("Test text", mockEnv);

      expect(result.approved).toBe(true);
      expect(result.error).toBeDefined();
    });

    it("should skip moderation if API key is not set", async () => {
      // Mock fetch to verify it's not called
      const mockFetch = vi.fn();
      global.fetch = mockFetch;

      const envWithoutKey = createMockEnv({
        MODERATION_CACHE_KV: mockKV as any,
        OPENAI_API_KEY: undefined,
      });

      const result = await handler.moderateText("Test text", envWithoutKey);

      expect(result.approved).toBe(true);
      expect(result.error).toBeUndefined();
      // Should not have called fetch when API key is missing
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should handle API error responses gracefully", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () =>
          JSON.stringify({
            error: {
              code: 403,
              message: "API not enabled",
            },
          }),
      });

      const result = await handler.moderateText("Test text", mockEnv);

      // Should fail open and approve content
      expect(result.approved).toBe(true);
      expect(result.error).toBeDefined();
    });
  });
});
