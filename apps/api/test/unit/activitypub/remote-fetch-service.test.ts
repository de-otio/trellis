/**
 * Unit Tests: Remote Fetch Service
 *
 * Tests for ActivityPub remote actor and object fetching.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteFetchService } from "../../../src/lib/activitypub/remote-fetch-service.js";
import type {
  DnsResolver,
  Transport,
} from "../../../src/lib/net/safe-fetch.js";
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

/**
 * The service now fetches through the SSRF-safe helper rather than global
 * `fetch`. To keep these tests' existing arrangements (`mockResolvedValue({
 * ok, json })`) meaningful, we install a transport that DELEGATES to the
 * mocked `global.fetch` and adapts its result into the helper's raw-response
 * shape. The request therefore still travels through `assertUrlSafe` — scheme
 * check, host classification, DNS, redirect policy, body cap — which is
 * exactly what we want these tests to exercise.
 */
const publicResolver: DnsResolver = async () => ["93.184.216.34"];

const fetchBackedTransport: Transport = async (req) => {
  const mock: any = await (global.fetch as any)(req.target.url.href, {
    method: req.method,
    headers: req.headers,
  });
  const status =
    typeof mock?.status === "number" ? mock.status : mock?.ok ? 200 : 500;
  const payload =
    typeof mock?.json === "function" ? await mock.json() : undefined;
  const encoded =
    payload === undefined ? "" : JSON.stringify(payload);
  async function* body(): AsyncIterable<Uint8Array> {
    if (encoded) yield Buffer.from(encoded, "utf8");
  }
  return {
    status,
    headers: (mock?.headers as Record<string, string>) ?? {},
    body: body(),
  };
};

describe("RemoteFetchService", () => {
  let mockEnv: Env;

  beforeEach(async () => {
    mockEnv = createFedifyTestEnv();

    vi.clearAllMocks();
    RemoteFetchService.clearCache();
    RemoteFetchService.defaultFetchOptions = {
      resolver: publicResolver,
      transport: fetchBackedTransport,
    };

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
    RemoteFetchService.defaultFetchOptions = {};
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
            // Lowercase: the SSRF-safe helper normalises header names.
            accept: expect.stringContaining("application/activity+json"),
            "user-agent": "Trellis ActivityPub Client/1.0",
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

      // A refused document is negatively cached; clear it so this attempt fetches.
      RemoteFetchService.clearCache();
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

      // A refused document is negatively cached; clear it so this attempt fetches.
      RemoteFetchService.clearCache();
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

      // A refused document is negatively cached; clear it so this attempt fetches.
      RemoteFetchService.clearCache();
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

      // A refused document is negatively cached; clear it so this attempt fetches.
      RemoteFetchService.clearCache();
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

  describe("document location — a document is authoritative only for the URL it came from", () => {
    it("checkDocumentLocation accepts id == requested URL (fragment and trailing slash ignored)", () => {
      const ok = RemoteFetchService.checkDocumentLocation(
        "https://remote.example/users/alice",
        "https://remote.example/users/alice",
        "https://remote.example/users/alice/",
      );
      expect(ok).toEqual({ ok: true });
    });

    it("checkDocumentLocation accepts id == final URL after a same-origin redirect", () => {
      const ok = RemoteFetchService.checkDocumentLocation(
        "https://remote.example/@alice",
        "https://remote.example/users/alice",
        "https://remote.example/users/alice",
      );
      expect(ok).toEqual({ ok: true });
    });

    it("checkDocumentLocation rejects an off-origin redirect even when the id matches it", () => {
      const r = RemoteFetchService.checkDocumentLocation(
        "https://remote.example/users/alice",
        "https://other.example/users/alice",
        "https://other.example/users/alice",
      );
      expect(r.ok).toBe(false);
    });

    it("checkDocumentLocation rejects an id on another host, and a missing id", () => {
      expect(
        RemoteFetchService.checkDocumentLocation(
          "https://attacker.example/users/evil",
          "https://attacker.example/users/evil",
          "https://victim.example/users/admin",
        ).ok,
      ).toBe(false);
      expect(
        RemoteFetchService.checkDocumentLocation(
          "https://attacker.example/users/evil",
          "https://attacker.example/users/evil",
          undefined,
        ).ok,
      ).toBe(false);
    });

    it("fetchActor refuses — and does not cache — a document claiming another actor's id", async () => {
      const actorUri = "https://attacker.example/users/evil";
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          id: "https://victim.example/users/admin",
          type: "Person",
          inbox: `${actorUri}/inbox`,
        }),
      });

      const result = await RemoteFetchService.fetchActor(actorUri, mockEnv, getLogger());
      expect(result).toBeNull();
      expect(RemoteFetchService.getCacheBytes()).toBe(0);
    });

    it("fetchObject refuses a document claiming another origin's id", async () => {
      const objectUri = "https://attacker.example/posts/1";
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ id: "https://victim.example/posts/1", type: "Note" }),
      });

      const result = await RemoteFetchService.fetchObject(objectUri, mockEnv, getLogger());
      expect(result).toBeNull();
      expect(RemoteFetchService.getCacheBytes()).toBe(0);
    });
  });

  describe("negative cache — a failed dereference is not repeatable for free", () => {
    it("does not re-fetch a URI that just failed, until invalidated", async () => {
      const actorUri = "https://down.example/users/alice";
      (global.fetch as any).mockResolvedValue({ ok: false, status: 502 });

      expect(await RemoteFetchService.fetchActor(actorUri, mockEnv, getLogger())).toBeNull();
      expect(await RemoteFetchService.fetchActor(actorUri, mockEnv, getLogger())).toBeNull();
      expect(global.fetch).toHaveBeenCalledTimes(1);

      RemoteFetchService.invalidateCache(actorUri);
      expect(await RemoteFetchService.fetchActor(actorUri, mockEnv, getLogger())).toBeNull();
      expect(global.fetch).toHaveBeenCalledTimes(2);
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
            // Lowercase: the SSRF-safe helper normalises header names.
            accept: expect.stringContaining("application/activity+json"),
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

      RemoteFetchService.clearCache(); // negative cache from the previous refusal
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

      RemoteFetchService.clearCache(); // negative cache from the previous refusal
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

      RemoteFetchService.clearCache(); // negative cache from the previous refusal
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

  describe("SSRF hardening (lane 8 HIGH / lane 9 F5)", () => {
    /** Transport that must never be reached. */
    const forbidden: Transport = async (req) => {
      throw new Error(`transport reached for ${req.target.url.href}`);
    };

    beforeEach(async () => {
      const { isRemoteUri } = await import(
        "../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isRemoteUri).mockReturnValue(true);
    });

    it.each([
      ["http://169.254.169.254/users/x", "AWS/GCP metadata over http"],
      ["https://169.254.169.254/users/x", "metadata over https"],
      ["https://169.254.42.42/users/x", "Scaleway metadata"],
      ["http://10.0.0.5:6379/users/x", "internal Redis"],
      ["https://127.0.0.1/users/x", "loopback"],
      ["https://[::1]/users/x", "IPv6 loopback"],
      ["https://2130706433/users/x", "decimal-encoded loopback"],
      ["https://[::ffff:169.254.169.254]/users/x", "metadata via IPv4-mapped"],
      ["https://localhost/users/x", "localhost"],
      ["https://100.100.100.200/users/x", "Alibaba metadata (CGNAT)"],
    ])("refuses to dereference actor %s (%s)", async (uri) => {
      const result = await RemoteFetchService.fetchActor(
        uri,
        mockEnv,
        getLogger(),
        { resolver: publicResolver, transport: forbidden },
      );
      expect(result).toBeNull();
    });

    it("refuses plaintext http even for a public host (F5: https-only)", async () => {
      // A cleartext actor document means a network attacker chooses the public
      // key we then trust for signature verification.
      const result = await RemoteFetchService.fetchActor(
        "http://mastodon.social/users/alice",
        mockEnv,
        getLogger(),
        { resolver: publicResolver, transport: forbidden },
      );
      expect(result).toBeNull();
    });

    it("refuses a public NAME whose DNS answer is internal", async () => {
      const result = await RemoteFetchService.fetchActor(
        "https://cdn.attacker.example/users/x",
        mockEnv,
        getLogger(),
        {
          resolver: async () => ["169.254.169.254"],
          transport: forbidden,
        },
      );
      expect(result).toBeNull();
    });

    it("refuses a redirect from a public host into internal space", async () => {
      let hops = 0;
      const redirecting: Transport = async (req) => {
        hops++;
        if (hops === 1) {
          async function* empty(): AsyncIterable<Uint8Array> {}
          return {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
            body: empty(),
          };
        }
        throw new Error("followed redirect into internal space");
      };

      const result = await RemoteFetchService.fetchActor(
        "https://mastodon.social/users/alice",
        mockEnv,
        getLogger(),
        { resolver: publicResolver, transport: redirecting },
      );
      expect(result).toBeNull();
      expect(hops).toBe(1);
    });

    it("caps an oversized actor document before parsing it", async () => {
      async function* flood(): AsyncIterable<Uint8Array> {
        // 4 MiB, far past the 256 KiB document ceiling.
        for (let i = 0; i < 16; i++) yield Buffer.alloc(256 * 1024, 0x41);
      }
      const bigTransport: Transport = async () => ({
        status: 200,
        headers: {},
        body: flood(),
      });

      const result = await RemoteFetchService.fetchActor(
        "https://mastodon.social/users/alice",
        mockEnv,
        getLogger(),
        { resolver: publicResolver, transport: bigTransport },
      );
      expect(result).toBeNull();
    });

    it("refuses object dereferencing into internal space too", async () => {
      const result = await RemoteFetchService.fetchObject(
        "https://169.254.169.254/objects/1",
        mockEnv,
        getLogger(),
        { resolver: publicResolver, transport: forbidden },
      );
      expect(result).toBeNull();
    });
  });

  describe("cache is bounded by bytes, not entry count", () => {
    it("keeps the cache under its byte ceiling as documents accumulate", async () => {
      const { isRemoteUri } = await import(
        "../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isRemoteUri).mockReturnValue(true);

      // ~128 KiB per actor; 200 of them would be ~25 MiB under the old
      // count-only cap of 1000 entries.
      const padding = "x".repeat(128 * 1024);
      for (let i = 0; i < 200; i++) {
        const uri = `https://mastodon.social/users/u${i}`;
        (global.fetch as any).mockResolvedValue({
          ok: true,
          json: async () => ({
            id: uri,
            type: "Person",
            inbox: `${uri}/inbox`,
            summary: padding,
          }),
        });
        await RemoteFetchService.fetchActor(uri, mockEnv, getLogger());
      }

      expect(RemoteFetchService.getCacheBytes()).toBeLessThanOrEqual(
        8 * 1024 * 1024,
      );
      expect(RemoteFetchService.getCacheBytes()).toBeGreaterThan(0);
    });

    it("resets the byte total on clearCache", () => {
      RemoteFetchService.clearCache();
      expect(RemoteFetchService.getCacheBytes()).toBe(0);
    });
  });
});
