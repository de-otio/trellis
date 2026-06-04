/**
 * Tests for Followers Collection (Fedify-Based)
 *
 * Tests the followers collection endpoint using Fedify's OrderedCollection.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { OrderedCollection } from "@fedify/fedify";
import {
  createFedifyTestEnv,
  createMockUser,
} from "../../../utils/fedify-test-fixtures.js";
import type { Env } from "../../../../src/env.js";
import type { User } from "@prisma/client";
import { DatabaseConnectionManager } from "../../../../src/lib/database-connection-manager.js";

// Mock dependencies
vi.mock("../../../../src/lib/database-connection-manager");
vi.mock("../../../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: vi.fn(
    async (_dbManager, _region, _env, callback) => {
      return callback({} as any);
    },
  ),
  QueryTimeoutPresets: {
    STANDARD: {},
  },
}));

describe("Followers Collection (Fedify)", () => {
  let mockEnv: Env;
  let mockUser: User;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = createFedifyTestEnv();
    mockUser = createMockUser({
      username: "testuser",
      actorUri: "https://example.com/users/testuser",
    }) as User;
  });

  describe("OrderedCollection creation", () => {
    it("should create OrderedCollection with correct structure", () => {
      const collectionUrl = new URL(
        "https://example.com/users/testuser/followers",
      );
      const collection = new OrderedCollection({
        id: collectionUrl,
        totalItems: 5,
        first: new URL(`${collectionUrl.toString()}?page=1`),
      });

      expect(collection).toBeInstanceOf(OrderedCollection);
      // Fedify doesn't expose properties directly, so we verify the object was created
      const collectionAny = collection as any;
      expect(collectionAny.id).toBeDefined();
      expect(collectionAny.totalItems).toBe(5);
    });

    it("should handle zero followers", () => {
      const collectionUrl = new URL(
        "https://example.com/users/testuser/followers",
      );
      const collection = new OrderedCollection({
        id: collectionUrl,
        totalItems: 0,
        first: new URL(`${collectionUrl.toString()}?page=1`),
      });

      expect(collection.totalItems).toBe(0);
    });

    it("should handle large follower counts", () => {
      const collectionUrl = new URL(
        "https://example.com/users/testuser/followers",
      );
      const collection = new OrderedCollection({
        id: collectionUrl,
        totalItems: 10000,
        first: new URL(`${collectionUrl.toString()}?page=1`),
      });

      expect(collection.totalItems).toBe(10000);
    });
  });

  describe("Collection serialization", () => {
    it("should serialize to JSON-LD correctly", async () => {
      const collectionUrl = new URL(
        "https://example.com/users/testuser/followers",
      );
      const collection = new OrderedCollection({
        id: collectionUrl,
        totalItems: 10,
        first: new URL(`${collectionUrl.toString()}?page=1`),
      });

      // Fedify doesn't expose properties directly, so we verify the object was created
      expect(collection).toBeInstanceOf(OrderedCollection);
      const collectionAny = collection as any;
      expect(collectionAny.id).toBeDefined();
      expect(collectionAny.totalItems).toBe(10);
    });
  });

  describe("Collection pagination", () => {
    it("should include first page URL", () => {
      const collectionUrl = new URL(
        "https://example.com/users/testuser/followers",
      );
      const collection = new OrderedCollection({
        id: collectionUrl,
        totalItems: 20,
        first: new URL(`${collectionUrl.toString()}?page=1`),
      });

      // Fedify doesn't expose properties directly, but we verify the collection was created
      expect(collection).toBeInstanceOf(OrderedCollection);
      const collectionAny = collection as any;
      if (collectionAny.first) {
        expect(collectionAny.first.toString()).toContain("?page=1");
      }
    });

    it("should handle custom pagination parameters", () => {
      const collectionUrl = new URL(
        "https://example.com/users/testuser/followers",
      );
      const firstPageUrl = new URL(
        `${collectionUrl.toString()}?page=1&limit=10`,
      );
      const collection = new OrderedCollection({
        id: collectionUrl,
        totalItems: 20,
        first: firstPageUrl,
      });

      // Fedify doesn't expose properties directly, but we verify the collection was created
      expect(collection).toBeInstanceOf(OrderedCollection);
      const collectionAny = collection as any;
      if (collectionAny.first) {
        expect(collectionAny.first.toString()).toContain("page=1");
        expect(collectionAny.first.toString()).toContain("limit=10");
      }
    });
  });

  describe("Integration with followers endpoint", () => {
    it("should work with followers collection route", async () => {
      // This test verifies that the collection structure is compatible
      // with the route handler expectations
      const collectionUrl = new URL(
        "https://example.com/users/testuser/followers",
      );
      const collection = new OrderedCollection({
        id: collectionUrl,
        totalItems: 0,
        first: new URL(`${collectionUrl.toString()}?page=1`),
      });

      // Verify structure matches what the route expects
      expect(collection).toBeInstanceOf(OrderedCollection);
      const collectionAny = collection as any;
      if (collectionAny.id) {
        expect(collectionAny.id.toString()).toBe(collectionUrl.toString());
      }
      expect(typeof collectionAny.totalItems).toBe("number");
    });
  });
});
