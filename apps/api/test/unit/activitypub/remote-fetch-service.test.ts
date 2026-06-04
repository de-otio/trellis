/**
 * Unit Tests: Remote Fetch Service
 *
 * Tests for ActivityPub remote actor and object fetching.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteFetchService } from "../../../src/lib/activitypub/remote-fetch-service.js";
import { getLogger } from "../../../src/lib/logger.js";
import type { Env } from "../../../src/env.js";
import { createFedifyTestEnv } from "../../utils/fedify-test-fixtures.js";

// Mock dependencies
vi.mock("../../../src/lib/activitypub/jsonld");
vi.mock("../../../src/lib/activitypub/standalone-mode", () => ({
  isStandaloneModeEnabled: vi.fn().mockResolvedValue(false),
  isRemoteUri: vi.fn((uri: string, env: Env) => {
    const baseUrl = env.ACTIVITYPUB_BASE_URL || "https://example.com";
    return !uri.startsWith(baseUrl);
  }),
}));

// Mock global fetch
global.fetch = vi.fn();

describe("RemoteFetchService", () => {
  let mockEnv: Env;

  beforeEach(async () => {
    mockEnv = createFedifyTestEnv();

    vi.clearAllMocks();
    RemoteFetchService.clearCache();

    // Reset standalone mode mocks
    const { isStandaloneModeEnabled, isRemoteUri } = await import(
      "../../../src/lib/activitypub/standalone-mode.js"
    );
    vi.mocked(isStandaloneModeEnabled).mockResolvedValue(false);
    vi.mocked(isRemoteUri).mockImplementation((uri: string, env: Env) => {
      const baseUrl = env.ACTIVITYPUB_BASE_URL || "https://example.com";
      return !uri.startsWith(baseUrl);
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    RemoteFetchService.clearCache();
  });

  describe("fetchActor", () => {
    it("should fetch remote actor successfully", async () => {
      const actorUri = "https://mastodon.social/users/alice";
      const mockActor = {
        id: actorUri,
        type: "Person",
        preferredUsername: "alice",
        inbox: `${actorUri}/inbox`,
        outbox: `${actorUri}/outbox`,
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockActor,
      });

      const result = await RemoteFetchService.fetchActor(
        actorUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toEqual(mockActor);
      expect(global.fetch).toHaveBeenCalledWith(
        actorUri,
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: expect.stringContaining("application/activity+json"),
            "User-Agent": "Trellis ActivityPub Client/1.0",
          }),
        }),
      );
          });

    it("should return null for invalid URI", async () => {
      const invalidUri = "not-a-valid-uri";

      const result = await RemoteFetchService.fetchActor(
        invalidUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
          });

    it("should return null for local actor", async () => {
      const localActorUri = "https://example.com/users/alice";

      const result = await RemoteFetchService.fetchActor(
        localActorUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
          });

    it("should return null when standalone mode is enabled", async () => {
      const actorUri = "https://mastodon.social/users/alice";
      const { isStandaloneModeEnabled } = await import(
        "../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(true);

      const result = await RemoteFetchService.fetchActor(
        actorUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
          });

    it("should return cached actor if available", async () => {
      const actorUri = "https://mastodon.social/users/alice";
      const mockActor = {
        id: actorUri,
        type: "Person",
        preferredUsername: "alice",
        inbox: `${actorUri}/inbox`,
      };

      const { isRemoteUri } = await import(
        "../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isRemoteUri).mockReturnValue(true);

      // First fetch - should call fetch
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockActor,
      });

      await RemoteFetchService.fetchActor(actorUri, mockEnv, getLogger());

      // Clear mocks but keep cache
      vi.clearAllMocks();
      vi.mocked(isRemoteUri).mockReturnValue(true);

      // Second fetch - should use cache (no fetch call)
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockActor,
      });

      const result = await RemoteFetchService.fetchActor(
        actorUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toEqual(mockActor);
      expect(global.fetch).not.toHaveBeenCalled();
          });

    it("should return null if fetch fails (non-ok response)", async () => {
      const actorUri = "https://mastodon.social/users/alice";

      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const result = await RemoteFetchService.fetchActor(
        actorUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBeNull();
          });

    it("should return null if actor document is invalid", async () => {
      const actorUri = "https://mastodon.social/users/alice";

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ invalid: "document" }), // Missing required fields
      });

      const result = await RemoteFetchService.fetchActor(
        actorUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBeNull();
          });

    it("should handle fetch errors gracefully", async () => {
      const actorUri = "https://mastodon.social/users/alice";

      (global.fetch as any).mockRejectedValue(new Error("Network error"));

      const result = await RemoteFetchService.fetchActor(
        actorUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBeNull();
          });

    it("should validate actor document structure", async () => {
      const actorUri = "https://mastodon.social/users/alice";

      // Missing type
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: actorUri, inbox: `${actorUri}/inbox` }),
      });

      const result1 = await RemoteFetchService.fetchActor(
        actorUri,
        mockEnv,
        getLogger(),
      );
      expect(result1).toBeNull();

      // Missing id
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ type: "Person", inbox: `${actorUri}/inbox` }),
      });

      const result2 = await RemoteFetchService.fetchActor(
        actorUri,
        mockEnv,
        getLogger(),
      );
      expect(result2).toBeNull();

      // Missing inbox
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: actorUri, type: "Person" }),
      });

      const result3 = await RemoteFetchService.fetchActor(
        actorUri,
        mockEnv,
        getLogger(),
      );
      expect(result3).toBeNull();

      // Invalid type
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: actorUri,
          type: "InvalidType",
          inbox: `${actorUri}/inbox`,
        }),
      });

      const result4 = await RemoteFetchService.fetchActor(
        actorUri,
        mockEnv,
        getLogger(),
      );
      expect(result4).toBeNull();
    });

    it("should accept valid actor types", async () => {
      const actorUri = "https://mastodon.social/users/alice";
      const validTypes = [
        "Person",
        "Group",
        "Organization",
        "Service",
        "Application",
      ];

      const { isRemoteUri } = await import(
        "../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isRemoteUri).mockReturnValue(true);

      for (const type of validTypes) {
        RemoteFetchService.clearCache(); // Clear cache between iterations
        const mockActor = {
          id: actorUri,
          type,
          inbox: `${actorUri}/inbox`,
        };

        (global.fetch as any).mockResolvedValueOnce({
          ok: true,
          json: async () => mockActor,
        });

        const result = await RemoteFetchService.fetchActor(
          actorUri,
          mockEnv,
          getLogger(),
        );
        expect(result).toEqual(mockActor);
      }
    });
  });

  describe("fetchObject", () => {
    it("should fetch remote object successfully", async () => {
      const objectUri = "https://mastodon.social/posts/123";
      const mockObject = {
        id: objectUri,
        type: "Note",
        content: "Test post",
        published: "2024-01-01T00:00:00Z",
      };

      const { isRemoteUri } = await import(
        "../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isRemoteUri).mockReturnValue(true);

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockObject,
      });

      const result = await RemoteFetchService.fetchObject(
        objectUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toEqual(mockObject);
      expect(global.fetch).toHaveBeenCalledWith(
        objectUri,
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: expect.stringContaining("application/activity+json"),
          }),
        }),
      );
          });

    it("should return null for invalid URI", async () => {
      const invalidUri = "not-a-valid-uri";

      const result = await RemoteFetchService.fetchObject(
        invalidUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
          });

    it("should return null for local object", async () => {
      const localObjectUri = "https://example.com/posts/123";

      const result = await RemoteFetchService.fetchObject(
        localObjectUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
          });

    it("should return null when standalone mode is enabled", async () => {
      const objectUri = "https://mastodon.social/posts/123";
      const { isStandaloneModeEnabled } = await import(
        "../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(true);

      const result = await RemoteFetchService.fetchObject(
        objectUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
          });

    it("should return cached object if available", async () => {
      const objectUri = "https://mastodon.social/posts/123";
      const mockObject = {
        id: objectUri,
        type: "Note",
        content: "Test post",
      };

      // First fetch
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockObject,
      });

      await RemoteFetchService.fetchObject(objectUri, mockEnv, getLogger());
      vi.clearAllMocks();

      // Second fetch - should use cache
      const result = await RemoteFetchService.fetchObject(
        objectUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toEqual(mockObject);
      expect(global.fetch).not.toHaveBeenCalled();
          });

    it("should return null if fetch fails", async () => {
      const objectUri = "https://mastodon.social/posts/123";

      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const result = await RemoteFetchService.fetchObject(
        objectUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBeNull();
          });

    it("should return null if object document is invalid", async () => {
      const objectUri = "https://mastodon.social/posts/123";

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ invalid: "document" }), // Missing id or type
      });

      const result = await RemoteFetchService.fetchObject(
        objectUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBeNull();
          });

    it("should handle fetch errors gracefully", async () => {
      const objectUri = "https://mastodon.social/posts/123";

      (global.fetch as any).mockRejectedValue(new Error("Network error"));

      const result = await RemoteFetchService.fetchObject(
        objectUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBeNull();
          });

    it("should validate object document structure", async () => {
      const objectUri = "https://mastodon.social/posts/123";

      // Missing id
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ type: "Note" }),
      });

      const result1 = await RemoteFetchService.fetchObject(
        objectUri,
        mockEnv,
        getLogger(),
      );
      expect(result1).toBeNull();

      // Missing type
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: objectUri }),
      });

      const result2 = await RemoteFetchService.fetchObject(
        objectUri,
        mockEnv,
        getLogger(),
      );
      expect(result2).toBeNull();

      // Invalid id type
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 123, type: "Note" }),
      });

      const result3 = await RemoteFetchService.fetchObject(
        objectUri,
        mockEnv,
        getLogger(),
      );
      expect(result3).toBeNull();
    });
  });

  describe("getActorInbox", () => {
    it("should get inbox URL from actor document", async () => {
      const actorUri = "https://mastodon.social/users/alice";
      const inboxUrl = `${actorUri}/inbox`;
      const mockActor = {
        id: actorUri,
        type: "Person",
        inbox: inboxUrl,
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockActor,
      });

      const result = await RemoteFetchService.getActorInbox(
        actorUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBe(inboxUrl);
    });

    it("should handle inbox as object with id", async () => {
      const actorUri = "https://mastodon.social/users/alice";
      const inboxUrl = `${actorUri}/inbox`;
      const mockActor = {
        id: actorUri,
        type: "Person",
        inbox: { id: inboxUrl },
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockActor,
      });

      const result = await RemoteFetchService.getActorInbox(
        actorUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBe(inboxUrl);
    });

    it("should return null if actor not found", async () => {
      const actorUri = "https://mastodon.social/users/alice";

      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 404,
      });

      const result = await RemoteFetchService.getActorInbox(
        actorUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBeNull();
    });

    it("should return null if inbox not present", async () => {
      const actorUri = "https://mastodon.social/users/alice";
      const mockActor = {
        id: actorUri,
        type: "Person",
        // No inbox
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockActor,
      });

      const result = await RemoteFetchService.getActorInbox(
        actorUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBeNull();
    });
  });

  describe("getActorPublicKey", () => {
    it("should get public key PEM from actor document", async () => {
      const actorUri = "https://mastodon.social/users/alice";
      const publicKeyPem =
        "-----BEGIN PUBLIC KEY-----\nMOCK_KEY\n-----END PUBLIC KEY-----";
      const mockActor = {
        id: actorUri,
        type: "Person",
        inbox: `${actorUri}/inbox`,
        publicKey: {
          id: `${actorUri}#main-key`,
          owner: actorUri,
          publicKeyPem,
        },
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockActor,
      });

      const result = await RemoteFetchService.getActorPublicKey(
        actorUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBe(publicKeyPem);
    });

    it("should handle public key as string", async () => {
      const actorUri = "https://mastodon.social/users/alice";
      const publicKeyPem =
        "-----BEGIN PUBLIC KEY-----\nMOCK_KEY\n-----END PUBLIC KEY-----";
      const mockActor = {
        id: actorUri,
        type: "Person",
        inbox: `${actorUri}/inbox`,
        publicKey: publicKeyPem,
      };

      const { isRemoteUri } = await import(
        "../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isRemoteUri).mockReturnValue(true);

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockActor,
      });

      const result = await RemoteFetchService.getActorPublicKey(
        actorUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBe(publicKeyPem);
    });

    it("should return null if actor not found", async () => {
      const actorUri = "https://mastodon.social/users/alice";

      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 404,
      });

      const result = await RemoteFetchService.getActorPublicKey(
        actorUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBeNull();
    });

    it("should return null if public key not present", async () => {
      const actorUri = "https://mastodon.social/users/alice";
      const mockActor = {
        id: actorUri,
        type: "Person",
        inbox: `${actorUri}/inbox`,
        // No publicKey
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockActor,
      });

      const result = await RemoteFetchService.getActorPublicKey(
        actorUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBeNull();
    });

    it("should return null if public key object missing publicKeyPem", async () => {
      const actorUri = "https://mastodon.social/users/alice";
      const mockActor = {
        id: actorUri,
        type: "Person",
        inbox: `${actorUri}/inbox`,
        publicKey: {
          id: `${actorUri}#main-key`,
          // Missing publicKeyPem
        },
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockActor,
      });

      const result = await RemoteFetchService.getActorPublicKey(
        actorUri,
        mockEnv,
        getLogger(),
      );

      expect(result).toBeNull();
    });
  });

  describe("isRemoteUri", () => {
    it("should return true for remote URI", () => {
      const remoteUri = "https://mastodon.social/users/alice";
      const result = RemoteFetchService.isRemoteUri(remoteUri, mockEnv);
      expect(result).toBe(true);
    });

    it("should return false for local URI", () => {
      const localUri = "https://example.com/users/alice";
      const result = RemoteFetchService.isRemoteUri(localUri, mockEnv);
      expect(result).toBe(false);
    });

    it("should use custom base URL from env", () => {
      const customEnv = createFedifyTestEnv({
        ACTIVITYPUB_BASE_URL: "https://custom.com",
      });
      const remoteUri = "https://mastodon.social/users/alice";
      const localUri = "https://custom.com/users/alice";

      expect(RemoteFetchService.isRemoteUri(remoteUri, customEnv)).toBe(true);
      expect(RemoteFetchService.isRemoteUri(localUri, customEnv)).toBe(false);
    });
  });

  describe("extractDomain", () => {
    it("should extract domain from valid URI", () => {
      const uri = "https://mastodon.social/users/alice";
      const result = RemoteFetchService.extractDomain(uri);
      expect(result).toBe("mastodon.social");
    });

    it("should return null for invalid URI", () => {
      const invalidUri = "not-a-valid-uri";
      const result = RemoteFetchService.extractDomain(invalidUri);
      expect(result).toBeNull();
    });

    it("should handle different protocols", () => {
      expect(RemoteFetchService.extractDomain("https://example.com/path")).toBe(
        "example.com",
      );
      expect(RemoteFetchService.extractDomain("http://example.com/path")).toBe(
        "example.com",
      );
    });
  });

  describe("cache management", () => {
    it("should cache documents", async () => {
      const actorUri = "https://mastodon.social/users/alice";
      const mockActor = {
        id: actorUri,
        type: "Person",
        inbox: `${actorUri}/inbox`,
      };

      const { isRemoteUri } = await import(
        "../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isRemoteUri).mockReturnValue(true);

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockActor,
      });

      await RemoteFetchService.fetchActor(actorUri, mockEnv, getLogger());

      // Clear mocks but keep cache
      vi.clearAllMocks();
      vi.mocked(isRemoteUri).mockReturnValue(true);

      // Second call should use cache
      const result = await RemoteFetchService.fetchActor(
        actorUri,
        mockEnv,
        getLogger(),
      );
      expect(result).toEqual(mockActor);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should invalidate cache entry", async () => {
      const actorUri = "https://mastodon.social/users/alice";
      const mockActor = {
        id: actorUri,
        type: "Person",
        inbox: `${actorUri}/inbox`,
      };

      const { isRemoteUri } = await import(
        "../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isRemoteUri).mockReturnValue(true);

      (global.fetch as any)
        .mockResolvedValueOnce({ ok: true, json: async () => mockActor })
        .mockResolvedValueOnce({ ok: true, json: async () => mockActor });

      await RemoteFetchService.fetchActor(actorUri, mockEnv, getLogger());
      RemoteFetchService.invalidateCache(actorUri);

      // Should fetch again after invalidation
      const result = await RemoteFetchService.fetchActor(
        actorUri,
        mockEnv,
        getLogger(),
      );
      expect(result).toEqual(mockActor);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("should clear all cache entries", async () => {
      const actorUri1 = "https://mastodon.social/users/alice";
      const actorUri2 = "https://mastodon.social/users/bob";
      const mockActor1 = {
        id: actorUri1,
        type: "Person",
        inbox: `${actorUri1}/inbox`,
      };
      const mockActor2 = {
        id: actorUri2,
        type: "Person",
        inbox: `${actorUri2}/inbox`,
      };

      const { isRemoteUri } = await import(
        "../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isRemoteUri).mockReturnValue(true);

      (global.fetch as any)
        .mockResolvedValueOnce({ ok: true, json: async () => mockActor1 })
        .mockResolvedValueOnce({ ok: true, json: async () => mockActor2 })
        .mockResolvedValueOnce({ ok: true, json: async () => mockActor1 })
        .mockResolvedValueOnce({ ok: true, json: async () => mockActor2 });

      await RemoteFetchService.fetchActor(actorUri1, mockEnv, getLogger());
      await RemoteFetchService.fetchActor(actorUri2, mockEnv, getLogger());
      RemoteFetchService.clearCache();

      // Both should fetch again after clear
      await RemoteFetchService.fetchActor(actorUri1, mockEnv, getLogger());
      await RemoteFetchService.fetchActor(actorUri2, mockEnv, getLogger());

      expect(global.fetch).toHaveBeenCalledTimes(4);
    });
  });
});
