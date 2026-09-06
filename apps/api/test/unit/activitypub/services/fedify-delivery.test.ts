/**
 * Tests for Fedify Activity Delivery
 *
 * Tests activity delivery with Fedify integration.
 */

import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";
import {
  deliverActivityWithFedify,
  deliverToRecipients,
  deliveryFetchOptions,
} from "../../../../src/lib/activitypub/services/fedify-delivery.js";
import type { Env } from "../../../../src/env.js";
import type {
  DnsResolver,
  Transport,
  TransportRequest,
} from "../../../../src/lib/net/safe-fetch.js";

// Mock dependencies
vi.mock("../../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {
    getConnection: vi.fn(),
  },
}));

vi.mock("../../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: vi.fn(),
  QueryTimeoutPresets: {
    STANDARD: {},
  },
}));

vi.mock("../../../../src/lib/region-detection", () => ({
  detectRegionSync: vi.fn(() => "EU"),
}));

vi.mock("../../../../src/lib/activitypub/activity-service", () => ({
  ActivityService: {
    storeInboxActivity: vi.fn(),
  },
}));

vi.mock("../../../../src/lib/activitypub/listeners/http-signatures", () => ({
  signRequest: vi.fn(),
}));

vi.mock("../../../../src/lib/activitypub/standalone-mode", () => ({
  isStandaloneModeEnabled: vi.fn().mockResolvedValue(false),
  isRemoteUri: vi.fn((uri, env) => {
    const baseUrl = env.ACTIVITYPUB_BASE_URL || "https://example.com";
    return !uri.startsWith(baseUrl);
  }),
}));

describe("Fedify Activity Delivery", () => {
  const mockEnv: Partial<Env> = {
    LOG_LEVEL: "INFO",
    ACTIVITYPUB_BASE_URL: "https://example.com",
    DATABASE_URL: "postgresql://test",
  };

  const mockActivity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "Create",
    actor: "https://example.com/users/alice",
    object: {
      type: "Note",
      content: "Hello, world!",
    },
  };

  /**
   * Remote delivery goes through the SSRF-safe fetcher, so tests inject a
   * resolver and a transport instead of mocking global `fetch`. The request
   * still travels through the whole guard (scheme, host classification, DNS,
   * redirect policy) — which is what these tests are meant to exercise.
   */
  const publicResolver: DnsResolver = async () => ["93.184.216.34"];
  let transportCalls: TransportRequest[];
  let transportStatus: number;
  const recordingTransport: Transport = async (req) => {
    transportCalls.push(req);
    async function* empty(): AsyncIterable<Uint8Array> {}
    return { status: transportStatus, headers: {}, body: empty() };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    transportCalls = [];
    transportStatus = 202;
    deliveryFetchOptions.resolver = publicResolver;
    deliveryFetchOptions.transport = recordingTransport;
    // A bare fetch must never be reached by delivery any more.
    global.fetch = vi.fn(() => {
      throw new Error("global fetch reached — delivery bypassed safeFetch");
    }) as any;
  });

  afterEach(() => {
    delete deliveryFetchOptions.resolver;
    delete deliveryFetchOptions.transport;
  });

  describe("deliverActivityWithFedify", () => {
    it("should deliver to local inbox successfully", async () => {
      const inboxUrl = "https://example.com/users/bob/inbox";
      const actorUri = "https://example.com/users/alice";

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            actorUri: "https://example.com/users/bob",
          }),
        },
        activity: {
          create: vi.fn().mockResolvedValue({}),
        },
      };

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const { ActivityService } = await import(
        "../../../../src/lib/activitypub/activity-service.js"
      );
      vi.mocked(ActivityService.storeInboxActivity).mockResolvedValue(
        undefined,
      );

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(true);
      expect(ActivityService.storeInboxActivity).toHaveBeenCalledWith(
        mockDb,
        "https://example.com/users/bob",
        mockActivity,
      );
    });

    it("should return false for invalid local inbox URL format", async () => {
      const inboxUrl = "https://example.com/invalid-url";
      const actorUri = "https://example.com/users/alice";

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(false);
    });

    it("should return false when local user not found", async () => {
      const inboxUrl = "https://example.com/users/bob/inbox";
      const actorUri = "https://example.com/users/alice";

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(false);
    });

    it("should return false when local user missing actorId", async () => {
      const inboxUrl = "https://example.com/users/bob/inbox";
      const actorUri = "https://example.com/users/alice";

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            actorUri: null,
          }),
        },
      };

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(false);
    });

    it("should deliver to remote inbox successfully", async () => {
      const inboxUrl = "https://remote.example.com/users/bob/inbox";
      const actorUri = "https://example.com/users/alice";

      const signedRequest = new Request(inboxUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/activity+json",
          Signature: "test-signature",
        },
        body: JSON.stringify(mockActivity),
      });

      const { signRequest } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(signRequest).mockResolvedValue(signedRequest);

      transportStatus = 200;

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(true);
      expect(signRequest).toHaveBeenCalled();
      expect(transportCalls).toHaveLength(1);
      expect(transportCalls[0].method).toBe("POST");
      expect(transportCalls[0].target.url.href).toBe(inboxUrl);
      // The signed headers travel with the POST.
      expect(transportCalls[0].headers.signature).toBe("test-signature");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("REFUSES an inbox URL that resolves to a private address, without opening a socket (DP-6)", async () => {
      const inboxUrl = "https://remote.example.com/users/bob/inbox";
      const actorUri = "https://example.com/users/alice";

      const { signRequest } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(signRequest).mockResolvedValue(
        new Request(inboxUrl, { method: "POST", body: "{}" }),
      );
      deliveryFetchOptions.resolver = async () => ["169.254.169.254"];

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(false);
      expect(transportCalls).toHaveLength(0);
    });

    it("REFUSES a plaintext http: inbox URL (DP-6)", async () => {
      const inboxUrl = "http://remote.example.com/users/bob/inbox";
      const actorUri = "https://example.com/users/alice";

      const { signRequest } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(signRequest).mockResolvedValue(
        new Request(inboxUrl, { method: "POST", body: "{}" }),
      );

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(false);
      expect(transportCalls).toHaveLength(0);
    });

    it("sends NOTHING when the actor cannot sign (DP-6)", async () => {
      const inboxUrl = "https://remote.example.com/users/bob/inbox";
      const actorUri = "https://example.com/users/alice";

      const { signRequest } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(signRequest).mockRejectedValue(new Error("no key pair"));

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(false);
      expect(transportCalls).toHaveLength(0);
    });

    it("should return false when remote delivery fails", async () => {
      const inboxUrl = "https://example.com/users/bob/inbox";
      const actorUri = "https://example.com/users/alice";

      const signedRequest = new Request(inboxUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/activity+json",
          Signature: "test-signature",
        },
        body: JSON.stringify(mockActivity),
      });

      const { signRequest } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(signRequest).mockResolvedValue(signedRequest);

      transportStatus = 500;

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(false);
    });

    it("should handle errors during local delivery", async () => {
      const inboxUrl = "https://example.com/users/bob/inbox";
      const actorUri = "https://example.com/users/alice";

      const mockDb = {
        user: {
          findUnique: vi.fn().mockRejectedValue(new Error("Database error")),
        },
      };

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(false);
    });

    it("should handle errors during remote delivery", async () => {
      const inboxUrl = "https://example.com/users/bob/inbox";
      const actorUri = "https://example.com/users/alice";

      const { signRequest } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(signRequest).mockRejectedValue(new Error("Signing error"));

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(false);
    });

    it("should skip remote delivery when standalone mode is enabled", async () => {
      const inboxUrl = "https://example.com/users/bob/inbox";
      const actorUri = "https://example.com/users/alice";

      const { isStandaloneModeEnabled, isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(true); // Standalone mode enabled
      vi.mocked(isRemoteUri).mockReturnValue(true); // Remote URI

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(false);
      expect(isStandaloneModeEnabled).toHaveBeenCalled();
      // Should not attempt to sign or deliver
      const { signRequest } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      expect(signRequest).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should allow remote delivery when standalone mode is disabled", async () => {
      const inboxUrl = "https://example.com/users/bob/inbox";
      const actorUri = "https://example.com/users/alice";

      const signedRequest = new Request(inboxUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/activity+json",
          Signature: "test-signature",
        },
        body: JSON.stringify(mockActivity),
      });

      const { isStandaloneModeEnabled, isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(false); // Standalone mode disabled
      vi.mocked(isRemoteUri).mockReturnValue(true); // Remote URI

      const { signRequest } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(signRequest).mockResolvedValue(signedRequest);

      transportStatus = 200;

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(true);
      expect(signRequest).toHaveBeenCalled();
      expect(transportCalls.length).toBeGreaterThan(0);
    });

    it("should allow local delivery even when standalone mode is enabled", async () => {
      const inboxUrl = "https://example.com/users/bob/inbox";
      const actorUri = "https://example.com/users/alice";

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            actorUri: "https://example.com/users/bob",
          }),
        },
        activity: {
          create: vi.fn().mockResolvedValue({}),
        },
      };

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const { isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isRemoteUri).mockReturnValue(false); // Local URI

      const { ActivityService } = await import(
        "../../../../src/lib/activitypub/activity-service.js"
      );
      vi.mocked(ActivityService.storeInboxActivity).mockResolvedValue(
        undefined,
      );

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(true);
      expect(ActivityService.storeInboxActivity).toHaveBeenCalled();
    });
  });

  describe("deliverToRecipients", () => {
    it("should deliver to multiple recipients successfully", async () => {
      const recipients = [
        "https://example.com/users/bob/inbox",
        "https://example.com/users/charlie/inbox",
      ];
      const actorUri = "https://example.com/users/alice";

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockImplementation((args: any) => {
                const username = args?.where?.username;
                if (username === "bob") {
                  return Promise.resolve({
                    actorUri: "https://example.com/users/bob",
                  });
                } else if (username === "charlie") {
                  return Promise.resolve({
                    actorUri: "https://example.com/users/charlie",
                  });
                }
                return Promise.resolve(null);
              }),
            },
            activity: {
              create: vi.fn().mockResolvedValue({}),
            },
          };
          return callback(mockDb as any);
        },
      );

      const { ActivityService } = await import(
        "../../../../src/lib/activitypub/activity-service.js"
      );
      vi.mocked(ActivityService.storeInboxActivity).mockResolvedValue(
        undefined,
      );

      const result = await deliverToRecipients(
        mockActivity as any,
        recipients,
        actorUri,
        mockEnv as Env,
      );

      expect(result.successful).toBe(2);
      expect(result.failed).toBe(0);
    });

    it("should handle mixed success and failure", async () => {
      const recipients = [
        "https://example.com/users/bob/inbox",
        "https://example.com/users/nonexistent/inbox",
      ];
      const actorUri = "https://example.com/users/alice";

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockImplementation((args: any) => {
                const username = args?.where?.username;
                if (username === "bob") {
                  return Promise.resolve({
                    actorUri: "https://example.com/users/bob",
                  });
                } else if (username === "nonexistent") {
                  return Promise.resolve(null);
                }
                return Promise.resolve(null);
              }),
            },
            activity: {
              create: vi.fn().mockResolvedValue({}),
            },
          };
          return callback(mockDb as any);
        },
      );

      const { ActivityService } = await import(
        "../../../../src/lib/activitypub/activity-service.js"
      );
      vi.mocked(ActivityService.storeInboxActivity).mockResolvedValue(
        undefined,
      );

      const result = await deliverToRecipients(
        mockActivity as any,
        recipients,
        actorUri,
        mockEnv as Env,
      );

      expect(result.successful).toBe(1);
      expect(result.failed).toBe(1);
    });

    it("should handle all failures", async () => {
      const recipients = [
        "https://example.com/users/nonexistent1/inbox",
        "https://example.com/users/nonexistent2/inbox",
      ];
      const actorUri = "https://example.com/users/alice";

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const result = await deliverToRecipients(
        mockActivity as any,
        recipients,
        actorUri,
        mockEnv as Env,
      );

      expect(result.successful).toBe(0);
      expect(result.failed).toBe(2);
    });

    it("should handle database errors during batch delivery", async () => {
      const recipients = ["https://example.com/users/bob/inbox"];
      const actorUri = "https://example.com/users/alice";

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockRejectedValue(
        new Error("Database error"),
      );

      const result = await deliverToRecipients(
        mockActivity as any,
        recipients,
        actorUri,
        mockEnv as Env,
      );

      expect(result.successful).toBe(0);
      expect(result.failed).toBe(1);
    });

    it("should handle mixed local and remote recipients", async () => {
      const recipients = [
        "https://example.com/users/bob/inbox",
        "https://example.com/users/charlie/inbox",
      ];
      const actorUri = "https://example.com/users/alice";

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      let callCount = 0;
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          callCount++;
          // Only local delivery needs database
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue({
                actorUri: "https://example.com/users/bob",
              }),
            },
            activity: {
              create: vi.fn().mockResolvedValue({}),
            },
          };
          return callback(mockDb as any);
        },
      );

      const { ActivityService } = await import(
        "../../../../src/lib/activitypub/activity-service.js"
      );
      vi.mocked(ActivityService.storeInboxActivity).mockResolvedValue(
        undefined,
      );

      const { signRequest } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      const signedRequest = new Request(
        "https://example.com/users/charlie/inbox",
        {
          method: "POST",
          headers: { "Content-Type": "application/activity+json" },
          body: JSON.stringify(mockActivity),
        },
      );
      vi.mocked(signRequest).mockResolvedValue(signedRequest);

      transportStatus = 200;

      const result = await deliverToRecipients(
        mockActivity as any,
        recipients,
        actorUri,
        mockEnv as Env,
      );

      expect(result.successful).toBe(2);
      expect(result.failed).toBe(0);
    });
  });

  describe("deliverActivityWithFedify - additional edge cases", () => {
    it("should handle database query timeout", async () => {
      const inboxUrl = "https://example.com/users/bob/inbox";
      const actorUri = "https://example.com/users/alice";

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockRejectedValue(
        new Error("Query timeout"),
      );

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(false);
    });

    it("should handle ActivityService.storeInboxActivity failure", async () => {
      const inboxUrl = "https://example.com/users/bob/inbox";
      const actorUri = "https://example.com/users/alice";

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            actorUri: "https://example.com/users/bob",
          }),
        },
      };

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      let callCount = 0;
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          callCount++;
          if (callCount === 1) {
            return callback(mockDb as any);
          } else if (callCount === 2) {
            const { ActivityService } = await import(
              "../../../../src/lib/activitypub/activity-service.js"
            );
            vi.mocked(ActivityService.storeInboxActivity).mockRejectedValue(
              new Error("Storage error"),
            );
            return callback(mockDb as any);
          }
          return callback(mockDb as any);
        },
      );

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(false);
    });

    it("should handle fetch network errors", async () => {
      const inboxUrl = "https://example.com/users/bob/inbox";
      const actorUri = "https://example.com/users/alice";

      const { signRequest } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      const signedRequest = new Request(inboxUrl, {
        method: "POST",
        headers: { "Content-Type": "application/activity+json" },
        body: JSON.stringify(mockActivity),
      });
      vi.mocked(signRequest).mockResolvedValue(signedRequest);

      deliveryFetchOptions.transport = async () => {
        throw new Error("Network error");
      };

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(false);
    });

    it("should handle URL-encoded usernames in local inbox", async () => {
      const inboxUrl = "https://example.com/users/user%20with%20spaces/inbox";
      const actorUri = "https://example.com/users/alice";

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            actorUri: "https://example.com/users/user with spaces",
          }),
        },
        activity: {
          create: vi.fn().mockResolvedValue({}),
        },
      };

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const { ActivityService } = await import(
        "../../../../src/lib/activitypub/activity-service.js"
      );
      vi.mocked(ActivityService.storeInboxActivity).mockResolvedValue(
        undefined,
      );

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(true);
      expect(mockDb.user.findUnique).toHaveBeenCalledWith({
        where: { username: "user with spaces" },
        select: { actorUri: true },
      });
    });

    it("should handle invalid local inbox URL format (no match)", async () => {
      const inboxUrl = "https://example.com/invalid/format";
      const actorUri = "https://example.com/users/alice";

      const result = await deliverActivityWithFedify(
        mockActivity as any,
        inboxUrl,
        actorUri,
        mockEnv as Env,
      );

      expect(result).toBe(false);
    });
  });
});
