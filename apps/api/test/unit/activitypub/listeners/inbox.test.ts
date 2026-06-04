/**
 * Tests for Fedify Inbox Listener
 *
 * Tests inbox activity processing with Fedify integration.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../../src/env.js";
import {
  parseActivity,
  processInboxActivity,
} from "../../../../src/lib/activitypub/listeners/inbox.js";

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

vi.mock(
  "../../../../src/lib/activitypub/services/remote-activity-handler",
  () => ({
    processRemoteActivity: vi.fn(),
  }),
);

vi.mock("../../../../src/lib/activitypub/services/abuse-prevention", () => ({
  validateActivity: vi.fn(),
}));

vi.mock("../../../../src/lib/activitypub/standalone-mode", () => ({
  isStandaloneModeEnabled: vi.fn(),
  isRemoteUri: vi.fn(),
}));

describe("Fedify Inbox Listener", () => {
  const mockEnv: Partial<Env> = {
    LOG_LEVEL: "INFO",
    ACTIVITYPUB_BASE_URL: "https://example.com",
    DATABASE_URL: "postgresql://test",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("parseActivity", () => {
    it("should parse valid activity JSON", async () => {
      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        type: "Create",
        actor: "https://example.com/users/alice",
        object: {
          type: "Note",
          content: "Hello, world!",
        },
      };

      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(activity),
      });

      const result = await parseActivity(request, mockEnv as Env);

      expect(result).not.toBeNull();
      expect(result?.type).toBe("Create");
      expect(result?.actor).toBe("https://example.com/users/alice");
    });

    it("should return null for invalid activity (missing type)", async () => {
      const activity = {
        actor: "https://example.com/users/alice",
      };

      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(activity),
      });

      const result = await parseActivity(request, mockEnv as Env);

      expect(result).toBeNull();
    });

    it("should return null for invalid activity (missing actor)", async () => {
      const activity = {
        type: "Create",
      };

      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(activity),
      });

      const result = await parseActivity(request, mockEnv as Env);

      expect(result).toBeNull();
    });

    it("should return null for invalid JSON", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "invalid json",
      });

      const result = await parseActivity(request, mockEnv as Env);

      expect(result).toBeNull();
    });

    it("should handle actor as object with id", async () => {
      const activity = {
        type: "Create",
        actor: {
          id: "https://example.com/users/alice",
          type: "Person",
        },
        object: { type: "Note" },
      };

      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(activity),
      });

      const result = await parseActivity(request, mockEnv as Env);

      expect(result).not.toBeNull();
    });
  });

  describe("processInboxActivity", () => {
    it("should reject request with invalid signature", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "Create",
          actor: "https://example.com/users/alice",
          object: { type: "Note" },
        }),
      });

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(false);

      const response = await processInboxActivity(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("Unauthorized");
    });

    it("should reject request with invalid activity", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "invalid json",
      });

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const response = await processInboxActivity(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(400);
    });

    it("should reject remote activity that fails abuse prevention", async () => {
      const remoteActivity = {
        type: "Create",
        actor: "https://example.com/users/remote",
        object: { type: "Note" },
      };

      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(remoteActivity),
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
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const { isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isRemoteUri).mockReturnValue(true); // Mark as remote

      const { isStandaloneModeEnabled } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(false); // Not in standalone mode

      const { validateActivity } = await import(
        "../../../../src/lib/activitypub/services/abuse-prevention.js"
      );
      vi.mocked(validateActivity).mockResolvedValue(false); // Abuse prevention fails

      const response = await processInboxActivity(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(403);
    });

    it("should process local activity successfully", async () => {
      const localActivity = {
        type: "Create",
        actor: "https://example.com/users/alice",
        object: { type: "Note" },
      };

      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(localActivity),
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
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const { isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isRemoteUri).mockReturnValue(false); // Local activity

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

      const response = await processInboxActivity(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(202);
      expect(ActivityService.storeInboxActivity).toHaveBeenCalled();
    });

    it("should process remote activity successfully", async () => {
      const remoteActivity = {
        type: "Create",
        actor: "https://example.com/users/remote",
        object: { type: "Note" },
      };

      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(remoteActivity),
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
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const { isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isRemoteUri).mockReturnValue(true); // Mark as remote

      const { isStandaloneModeEnabled } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(false); // Not in standalone mode

      const { validateActivity } = await import(
        "../../../../src/lib/activitypub/services/abuse-prevention.js"
      );
      vi.mocked(validateActivity).mockResolvedValue(true); // Abuse prevention passes

      const { processRemoteActivity } = await import(
        "../../../../src/lib/activitypub/services/remote-activity-handler.js"
      );
      vi.mocked(processRemoteActivity).mockResolvedValue(true);

      const { ActivityService } = await import(
        "../../../../src/lib/activitypub/activity-service.js"
      );
      vi.mocked(ActivityService.storeInboxActivity).mockResolvedValue(
        undefined,
      );

      const response = await processInboxActivity(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(202);
      expect(processRemoteActivity).toHaveBeenCalled();
    });

    it("should return 404 for non-existent user", async () => {
      const request = new Request(
        "https://example.com/users/nonexistent/inbox",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "Create",
            actor: "https://example.com/users/alice",
            object: { type: "Note" },
          }),
        },
      );

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

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const response = await processInboxActivity(
        request,
        mockEnv as Env,
        "nonexistent",
      );

      expect(response.status).toBe(404);
    });

    it("should return 400 for user missing actorId", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "Create",
          actor: "https://example.com/users/alice",
          object: { type: "Note" },
        }),
      });

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: "user-123",
            username: "bob",
            actorUri: null,
            inboxUrl: null,
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

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const response = await processInboxActivity(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(400);
    });

    it("should handle errors gracefully", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "Create",
          actor: "https://example.com/users/alice",
          object: { type: "Note" },
        }),
      });

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockRejectedValue(
        new Error("Unexpected error"),
      );

      const response = await processInboxActivity(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(500);
    });

    it("should reject remote activity when standalone mode is enabled", async () => {
      const remoteActivity = {
        type: "Create",
        actor: "https://example.com/users/remote",
        object: { type: "Note" },
      };

      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(remoteActivity),
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
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const { isStandaloneModeEnabled, isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(true); // Standalone mode enabled
      vi.mocked(isRemoteUri).mockReturnValue(true); // Remote URI

      const response = await processInboxActivity(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe(
        "Remote activities not accepted in standalone mode",
      );
      expect(isStandaloneModeEnabled).toHaveBeenCalled();
    });

    it("should allow remote activity when standalone mode is disabled", async () => {
      const remoteActivity = {
        type: "Create",
        actor: "https://example.com/users/remote",
        object: { type: "Note" },
      };

      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(remoteActivity),
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
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const { isStandaloneModeEnabled, isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(false); // Standalone mode disabled
      vi.mocked(isRemoteUri).mockReturnValue(true); // Remote URI

      const { validateActivity } = await import(
        "../../../../src/lib/activitypub/services/abuse-prevention.js"
      );
      vi.mocked(validateActivity).mockResolvedValue(true);

      const { processRemoteActivity } = await import(
        "../../../../src/lib/activitypub/services/remote-activity-handler.js"
      );
      vi.mocked(processRemoteActivity).mockResolvedValue(true);

      const response = await processInboxActivity(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(202);
      expect(processRemoteActivity).toHaveBeenCalled();
    });

    it("should allow local activity even when standalone mode is enabled", async () => {
      const localActivity = {
        type: "Create",
        actor: "https://example.com/users/alice",
        object: { type: "Note" },
      };

      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(localActivity),
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
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

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

      const { ActivityProcessor } = await import(
        "../../../../src/lib/activitypub/activity-processor.js"
      );
      vi.mocked(ActivityProcessor.processActivity).mockResolvedValue(undefined);

      const response = await processInboxActivity(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(202);
      expect(ActivityService.storeInboxActivity).toHaveBeenCalled();
    });

    it("should handle activity with actor as object", async () => {
      const activityWithObjectActor = {
        type: "Create",
        actor: {
          id: "https://example.com/users/alice",
          type: "Person",
        },
        object: { type: "Note" },
      };

      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
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
      };

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

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

      const { ActivityProcessor } = await import(
        "../../../../src/lib/activitypub/activity-processor.js"
      );
      vi.mocked(ActivityProcessor.processActivity).mockResolvedValue(undefined);

      const response = await processInboxActivity(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(202);
    });

    it("should handle activity storage errors", async () => {
      const localActivity = {
        type: "Create",
        actor: "https://example.com/users/alice",
        object: { type: "Note" },
      };

      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(localActivity),
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
            // First call: getUserByUsername - success
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

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const { isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isRemoteUri).mockReturnValue(false);

      const response = await processInboxActivity(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(500);
    });

    it("should handle remote activity processing failure", async () => {
      const remoteActivity = {
        type: "Create",
        actor: "https://example.com/users/remote",
        object: { type: "Note" },
      };

      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(remoteActivity),
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
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          return callback(mockDb as any);
        },
      );

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const { isStandaloneModeEnabled, isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(false);
      vi.mocked(isRemoteUri).mockReturnValue(true);

      const { validateActivity } = await import(
        "../../../../src/lib/activitypub/services/abuse-prevention.js"
      );
      vi.mocked(validateActivity).mockResolvedValue(true);

      const { processRemoteActivity } = await import(
        "../../../../src/lib/activitypub/services/remote-activity-handler.js"
      );
      vi.mocked(processRemoteActivity).mockResolvedValue(false); // Processing failed

      const response = await processInboxActivity(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Failed to process activity");
    });

    it("should handle abuse prevention failure for remote activity", async () => {
      const remoteActivity = {
        type: "Create",
        actor: "https://example.com/users/remote",
        object: { type: "Note" },
      };

      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(remoteActivity),
      });

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const { isStandaloneModeEnabled, isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(false);
      vi.mocked(isRemoteUri).mockReturnValue(true);

      const { validateActivity } = await import(
        "../../../../src/lib/activitypub/services/abuse-prevention.js"
      );
      vi.mocked(validateActivity).mockResolvedValue(false); // Abuse detected

      const response = await processInboxActivity(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("Activity rejected");
    });

    it("should handle database errors when fetching user", async () => {
      const localActivity = {
        type: "Create",
        actor: "https://example.com/users/alice",
        object: { type: "Note" },
      };

      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(localActivity),
      });

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockRejectedValue(
        new Error("Database error"),
      );

      const { verifyHttpSignature } = await import(
        "../../../../src/lib/activitypub/listeners/http-signatures.js"
      );
      vi.mocked(verifyHttpSignature).mockResolvedValue(true);

      const { isRemoteUri } = await import(
        "../../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isRemoteUri).mockReturnValue(false); // Ensure it's treated as local

      const response = await processInboxActivity(
        request,
        mockEnv as Env,
        "bob",
      );

      expect(response.status).toBe(500);
    });
  });
});
