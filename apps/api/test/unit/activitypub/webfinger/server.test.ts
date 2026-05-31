/**
 * Tests for WebFinger Server
 *
 * Tests WebFinger protocol implementation for ActivityPub actor discovery.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleWebFinger } from "../../../../src/lib/activitypub/webfinger/server.js";
import {
  createFedifyTestEnv,
  createMockUser,
} from "../../../utils/fedify-test-fixtures.js";
import type { Env } from "../../../../src/env.js";
import type { User, PrismaClient } from "@prisma/client";
import { DatabaseConnectionManager } from "../../../../src/lib/database-connection-manager.js";

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

describe("WebFinger Server", () => {
  let mockEnv: Env;
  let mockUser: User;
  let mockPrisma: PrismaClient;

  beforeEach(() => {
    mockEnv = createFedifyTestEnv();
    mockUser = createMockUser({
      username: "alice",
      actorUri: "https://example.com/users/alice",
    }) as User;

    // Mock Prisma client
    mockPrisma = {
      user: {
        findUnique: vi.fn(),
      },
    } as any;
  });

  describe("handleWebFinger", () => {
    it("should return WebFinger response for valid user", async () => {
      const resource = "acct:alice@example.com";
      const request = new Request(
        `https://example.com/.well-known/webfinger?resource=${encodeURIComponent(resource)}`,
      );

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue({
                id: mockUser.id,
                username: mockUser.username,
                actorUri: mockUser.actorUri,
                publicKey: mockUser.publicKey,
                suspended: false,
                deletedAt: null,
              }),
            },
          };
          return callback(mockDb as any);
        },
      );

      const response = await handleWebFinger(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.subject).toBe(resource);
      expect(body.links).toHaveLength(1);
      expect(body.links[0].rel).toBe("self");
      expect(body.links[0].type).toBe("application/activity+json");
      expect(body.links[0].href).toBe("https://example.com/users/alice");
    });

    it("should return 400 if resource parameter is missing", async () => {
      const request = new Request("https://example.com/.well-known/webfinger");

      const response = await handleWebFinger(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("resource parameter is required");
    });

    it("should return 400 if resource format is invalid", async () => {
      const resource = "invalid-format";
      const request = new Request(
        `https://example.com/.well-known/webfinger?resource=${encodeURIComponent(resource)}`,
      );

      const response = await handleWebFinger(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("Invalid resource format");
    });

    it("should return 400 if domain does not match", async () => {
      const resource = "acct:alice@other-domain.com";
      const request = new Request(
        `https://example.com/.well-known/webfinger?resource=${encodeURIComponent(resource)}`,
      );

      const response = await handleWebFinger(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("Domain mismatch");
    });

    it("should return 404 if user not found", async () => {
      const resource = "acct:nonexistent@example.com";
      const request = new Request(
        `https://example.com/.well-known/webfinger?resource=${encodeURIComponent(resource)}`,
      );

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue(null),
            },
          };
          return callback(mockDb as any);
        },
      );

      const response = await handleWebFinger(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe("User not found");
    });

    it("should return 404 if user is suspended", async () => {
      const resource = "acct:alice@example.com";
      const request = new Request(
        `https://example.com/.well-known/webfinger?resource=${encodeURIComponent(resource)}`,
      );

      const { withQueryTimeoutAndRetry } = await import(
        "../../../../src/lib/db-query-helper.js"
      );
      vi.mocked(withQueryTimeoutAndRetry).mockImplementation(
        async (dbManager, region, env, callback) => {
          const mockDb = {
            user: {
              findUnique: vi.fn().mockResolvedValue({
                id: mockUser.id,
                username: mockUser.username,
                actorUri: mockUser.actorUri,
                publicKey: mockUser.publicKey,
                suspended: true,
                deletedAt: null,
              }),
            },
          };
          return callback(mockDb as any);
        },
      );

      const response = await handleWebFinger(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe("User account is suspended or deleted");
    });
  });
});
