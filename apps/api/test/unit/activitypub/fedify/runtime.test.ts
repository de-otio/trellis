/**
 * Tests for Fedify Runtime Adapter
 *
 * Tests the Cloudflare Workers runtime adapter for Fedify.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFedifyContextData } from "../../../../src/lib/activitypub/fedify/runtime.js";
import type { Env } from "../../../../src/env.js";

describe("Fedify Runtime Adapter", () => {
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      LOG_LEVEL: "INFO",
      ACTIVITYPUB_BASE_URL: "https://example.com",
      DATABASE_URL: "postgresql://test",
    } as Env;
  });

  describe("getFedifyContextData", () => {
    it("should return empty context object", () => {
      const context = getFedifyContextData(mockEnv);

      expect(context).toEqual({});
      expect(typeof context).toBe("object");
    });

    it("should return empty object for different env configurations", () => {
      const env1 = { ...mockEnv, LOG_LEVEL: "DEBUG" } as Env;
      const env2 = {
        ...mockEnv,
        ACTIVITYPUB_BASE_URL: "https://custom.com",
      } as Env;

      const context1 = getFedifyContextData(env1);
      const context2 = getFedifyContextData(env2);

      expect(context1).toEqual({});
      expect(context2).toEqual({});
    });

    it("should handle missing env properties gracefully", () => {
      const minimalEnv = {
        LOG_LEVEL: "INFO",
      } as Env;

      const context = getFedifyContextData(minimalEnv);

      expect(context).toEqual({});
    });

    it("should return new object instance each call", () => {
      const context1 = getFedifyContextData(mockEnv);
      const context2 = getFedifyContextData(mockEnv);

      expect(context1).toEqual({});
      expect(context2).toEqual({});
      expect(context1).not.toBe(context2);
    });
  });
});
