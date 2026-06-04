/**
 * Tests for Remote Activity Handler
 *
 * Tests remote activity processing with Fedify integration.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../../src/env.js";
import { processRemoteActivity } from "../../../../src/lib/activitypub/services/remote-activity-handler.js";

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

vi.mock("../../../../src/lib/activitypub/activity-processor", () => ({
  ActivityProcessor: {
    processActivity: vi.fn(),
  },
}));

vi.mock("../../../../src/lib/activitypub/listeners/http-signatures", () => ({
  verifyHttpSignature: vi.fn(),
}));

vi.mock("../../../../src/lib/activitypub/standalone-mode", () => ({
  isStandaloneModeEnabled: vi.fn(),
  isRemoteUri: vi.fn(),
}));

describe("Remote Activity Handler", () => {
  const mockEnv: Partial<Env> = {
    LOG_LEVEL: "INFO",
    ACTIVITYPUB_BASE_URL: "https://example.com",
    DATABASE_URL: "postgresql://test",
  };

  const mockRemoteActivity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "Create",
    actor: "https://example.com/users/remote",
    object: {
      type: "Note",
      content: "Hello!",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("processRemoteActivity", () => {
    it("should reject activities without valid signature", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/activity+json",
        },
        body: JSON.stringify(mockRemoteActivity),
      });

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(false);

      const result = await processRemoteActivity(
        mockRemoteActivity as any,
        request,
        "https://example.com/users/bob",
        mockEnv as Env,
      );

      expect(result).toBe(false);
      expect(verifyHttpSignature).toHaveBeenCalledWith(request, mockEnv);
    });

    it("should reject local activities", async () => {
      const localActivity = {
        ...mockRemoteActivity,
        actor: "https://example.com/users/local",
      };

      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/activity+json",
        },
        body: JSON.stringify(localActivity),
      });

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const result = await processRemoteActivity(
        localActivity as any,
        request,
        "https://example.com/users/bob",
        mockEnv as Env,
      );

      expect(result).toBe(false);
    });

    it("should process remote activity successfully", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/activity+json",
          Signature: "valid-signature",
        },
        body: JSON.stringify(mockRemoteActivity),
      });

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: "user-123",
            username: "bob",
            actorUri: "https://example.com/users/bob",
            inboxUrl: "https://example.com/users/bob/inbox",
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

      const { isStandaloneModeEnabled } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(false); // Not in standalone mode

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const { isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isRemoteUri).mockReturnValue(true); // Mark as remote

      const { ActivityService } = await import(
        "../../../../src/lib/activitypub/activity-service.js"
      );
      vi.mocked(ActivityService.storeInboxActivity).mockResolvedValue(
        undefined,
      );

      const { ActivityProcessor } = await import(
        "../../../../src/lib/activitypub/activity-processor.js"
      );
      vi.mocked(ActivityProcessor.processActivity).mockResolvedValue(undefined);

      const result = await processRemoteActivity(
        mockRemoteActivity as any,
        request,
        "https://example.com/users/bob",
        mockEnv as Env,
      );

      expect(result).toBe(true);
      expect(ActivityService.storeInboxActivity).toHaveBeenCalled();
      expect(ActivityProcessor.processActivity).toHaveBeenCalled();
    });

    it("should return false when target user not found", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/activity+json",
          Signature: "valid-signature",
        },
        body: JSON.stringify(mockRemoteActivity),
      });

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

      const { isStandaloneModeEnabled } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(false); // Not in standalone mode

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const { isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isRemoteUri).mockReturnValue(true); // Mark as remote

      const result = await processRemoteActivity(
        mockRemoteActivity as any,
        request,
        "https://example.com/users/bob",
        mockEnv as Env,
      );

      expect(result).toBe(false);
    });

    it("should handle errors during processing", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/activity+json",
          Signature: "valid-signature",
        },
        body: JSON.stringify(mockRemoteActivity),
      });

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockRejectedValue(
        new Error("Verification error"),
      );

      const result = await processRemoteActivity(
        mockRemoteActivity as any,
        request,
        "https://example.com/users/bob",
        mockEnv as Env,
      );

      expect(result).toBe(false);
    });

    it("should reject remote activity when standalone mode is enabled", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/activity+json",
          Signature: "valid-signature",
        },
        body: JSON.stringify(mockRemoteActivity),
      });

      const { isStandaloneModeEnabled, isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(true); // Standalone mode enabled
      vi.mocked(isRemoteUri).mockReturnValue(true); // Remote URI

      const result = await processRemoteActivity(
        mockRemoteActivity as any,
        request,
        "https://example.com/users/bob",
        mockEnv as Env,
      );

      expect(result).toBe(false);
      expect(isStandaloneModeEnabled).toHaveBeenCalled();
      // Should not proceed to signature verification
      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      expect(verifyHttpSignature).not.toHaveBeenCalled();
    });

    it("should process remote activity when standalone mode is disabled", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/activity+json",
          Signature: "valid-signature",
        },
        body: JSON.stringify(mockRemoteActivity),
      });

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: "user-123",
            username: "bob",
            actorUri: "https://example.com/users/bob",
            inboxUrl: "https://example.com/users/bob/inbox",
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

      const { isStandaloneModeEnabled, isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(false); // Standalone mode disabled
      vi.mocked(isRemoteUri).mockReturnValue(true); // Remote URI

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const { ActivityService } = await import(
        "../../../../src/lib/activitypub/activity-service.js"
      );
      vi.mocked(ActivityService.storeInboxActivity).mockResolvedValue(
        undefined,
      );

      const { ActivityProcessor } = await import(
        "../../../../src/lib/activitypub/activity-processor.js"
      );
      vi.mocked(ActivityProcessor.processActivity).mockResolvedValue(undefined);

      const result = await processRemoteActivity(
        mockRemoteActivity as any,
        request,
        "https://example.com/users/bob",
        mockEnv as Env,
      );

      expect(result).toBe(true);
      expect(verifyHttpSignature).toHaveBeenCalled();
    });

    it("should handle activity with actor as object", async () => {
      const activityWithObjectActor = {
        ...mockRemoteActivity,
        actor: {
          id: "https://example.com/users/remote",
          type: "Person",
        },
      };

      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/activity+json",
          Signature: "valid-signature",
        },
        body: JSON.stringify(activityWithObjectActor),
      });

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: "user-123",
            username: "bob",
            actorUri: "https://example.com/users/bob",
            inboxUrl: "https://example.com/users/bob/inbox",
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

      const { isStandaloneModeEnabled, isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(false);
      vi.mocked(isRemoteUri).mockReturnValue(true);

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const { ActivityService } = await import(
        "../../../../src/lib/activitypub/activity-service.js"
      );
      vi.mocked(ActivityService.storeInboxActivity).mockResolvedValue(
        undefined,
      );

      const { ActivityProcessor } = await import(
        "../../../../src/lib/activitypub/activity-processor.js"
      );
      vi.mocked(ActivityProcessor.processActivity).mockResolvedValue(undefined);

      const result = await processRemoteActivity(
        activityWithObjectActor as any,
        request,
        "https://example.com/users/bob",
        mockEnv as Env,
      );

      expect(result).toBe(true);
    });

    it("should handle activity with missing actor", async () => {
      const activityWithoutActor = {
        "@context": "https://www.w3.org/ns/activitystreams",
        type: "Create",
        object: {
          type: "Note",
          content: "Hello!",
        },
      };

      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/activity+json",
          Signature: "valid-signature",
        },
        body: JSON.stringify(activityWithoutActor),
      });

      const { isStandaloneModeEnabled, isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(false);
      vi.mocked(isRemoteUri).mockReturnValue(false); // Not remote since no actor

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const result = await processRemoteActivity(
        activityWithoutActor as any,
        request,
        "https://example.com/users/bob",
        mockEnv as Env,
      );

      expect(result).toBe(false);
    });

    it("should handle activity storage errors", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/activity+json",
          Signature: "valid-signature",
        },
        body: JSON.stringify(mockRemoteActivity),
      });

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: "user-123",
            username: "bob",
            actorUri: "https://example.com/users/bob",
            inboxUrl: "https://example.com/users/bob/inbox",
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
            // First call: getUserByActorId - success
            return callback(mockDb as any);
          } else if (callCount === 2) {
            // Second call: storeInboxActivity - error
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

      const { isStandaloneModeEnabled, isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(false);
      vi.mocked(isRemoteUri).mockReturnValue(true);

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const result = await processRemoteActivity(
        mockRemoteActivity as any,
        request,
        "https://example.com/users/bob",
        mockEnv as Env,
      );

      expect(result).toBe(false);
    });

    it("should handle activity processing errors gracefully", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/activity+json",
          Signature: "valid-signature",
        },
        body: JSON.stringify(mockRemoteActivity),
      });

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: "user-123",
            username: "bob",
            actorUri: "https://example.com/users/bob",
            inboxUrl: "https://example.com/users/bob/inbox",
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

      const { isStandaloneModeEnabled, isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(false);
      vi.mocked(isRemoteUri).mockReturnValue(true);

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const { ActivityService } = await import(
        "../../../../src/lib/activitypub/activity-service.js"
      );
      vi.mocked(ActivityService.storeInboxActivity).mockResolvedValue(
        undefined,
      );

      const { ActivityProcessor } = await import(
        "../../../../src/lib/activitypub/activity-processor.js"
      );
      vi.mocked(ActivityProcessor.processActivity).mockRejectedValue(
        new Error("Processing error"),
      );

      // Should still return true even if processing fails (it's async)
      const result = await processRemoteActivity(
        mockRemoteActivity as any,
        request,
        "https://example.com/users/bob",
        mockEnv as Env,
      );

      expect(result).toBe(true);
      expect(ActivityService.storeInboxActivity).toHaveBeenCalled();
    });

    it("should handle database errors when fetching user", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/activity+json",
          Signature: "valid-signature",
        },
        body: JSON.stringify(mockRemoteActivity),
      });

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockRejectedValue(
        new Error("Database error"),
      );

      const { isStandaloneModeEnabled, isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(false);
      vi.mocked(isRemoteUri).mockReturnValue(true);

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const result = await processRemoteActivity(
        mockRemoteActivity as any,
        request,
        "https://example.com/users/bob",
        mockEnv as Env,
      );

      expect(result).toBe(false);
    });

    it("should handle user missing actorId", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/activity+json",
          Signature: "valid-signature",
        },
        body: JSON.stringify(mockRemoteActivity),
      });

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: "user-123",
            username: "bob",
            actorUri: null, // Missing actorId
            inboxUrl: "https://example.com/users/bob/inbox",
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

      const { isStandaloneModeEnabled, isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(false);
      vi.mocked(isRemoteUri).mockReturnValue(true);

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const result = await processRemoteActivity(
        mockRemoteActivity as any,
        request,
        "https://example.com/users/bob",
        mockEnv as Env,
      );

      // Should still process if user exists, even without actorId
      expect(result).toBe(true);
    });
  });
});
