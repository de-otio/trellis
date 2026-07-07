/**
 * Unit Tests: Collection Handler
 *
 * Covers CRUD, ownership enforcement, env-driven caps (items + per-user),
 * add-time referent-visibility validation, and the SEC-12 read-time
 * visibility filter for PUBLIC/UNLISTED collections.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import { CollectionHandler } from "../../src/lib/collection-handler.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";

const mockPrisma = {
  collection: {
    count: vi.fn(),
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  collectionItem: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  entity: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
};

vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeCollection(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "coll_1",
    tenantId: "tenant_1",
    ownerUserId: "user123",
    title: "My List",
    description: null,
    visibility: "PRIVATE",
    itemCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "item_1",
    collectionId: "coll_1",
    targetType: "user",
    targetId: "target_1",
    position: 0,
    note: null,
    addedAt: NOW,
    ...overrides,
  };
}

describe("CollectionHandler", () => {
  let handler: CollectionHandler;
  let mockEnv: Env;
  let mockSession: any;
  const ctx = {} as TrellisRequestContext;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new CollectionHandler();

    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      SESSION_SECRET: "test-secret-32-characters-long!!",
      collection: { maxItems: 3, maxPerUser: 2 },
    } as unknown as Env;

    mockSession = {
      userId: "user123",
      email: "user@example.com",
      role: "END_USER",
      expiresAt: Date.now() + 3600000,
      dataRegion: "EU",
      profileContext: "primary",
    };

    mockPrisma.user.findUnique.mockResolvedValue({ personalTenantId: "tenant_1" });
  });

  describe("handleCreate", () => {
    it("creates and returns 201", async () => {
      mockPrisma.collection.count.mockResolvedValue(0);
      mockPrisma.collection.create.mockResolvedValue(makeCollection());

      const request = jsonRequest("https://api.example.com/api/collections", "POST", {
        title: "My List",
      });

      const response = await handler.handleCreate(request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.id).toBe("coll_1");
      expect(mockPrisma.collection.create).toHaveBeenCalledWith({
        data: {
          tenantId: "tenant_1",
          ownerUserId: "user123",
          title: "My List",
          description: null,
          visibility: "PRIVATE",
        },
      });
    });

    it("returns 400 on invalid body", async () => {
      const request = jsonRequest("https://api.example.com/api/collections", "POST", {
        title: "",
      });

      const response = await handler.handleCreate(request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 500 on database error", async () => {
      mockPrisma.collection.count.mockResolvedValue(0);
      mockPrisma.collection.create.mockRejectedValue(new Error("db down"));

      const request = jsonRequest("https://api.example.com/api/collections", "POST", {
        title: "My List",
      });

      const response = await handler.handleCreate(request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("INTERNAL_ERROR");
    });

    it("enforces maxPerUser as a boundary: Nth collection ok, N+1th rejected", async () => {
      // maxPerUser = 2 (from mockEnv). At count=1 (2nd collection) -> allowed.
      mockPrisma.collection.count.mockResolvedValueOnce(1);
      mockPrisma.collection.create.mockResolvedValue(makeCollection({ id: "coll_2" }));
      const okRequest = jsonRequest("https://api.example.com/api/collections", "POST", {
        title: "Second",
      });
      const okResponse = await handler.handleCreate(okRequest, mockSession, mockEnv, ctx);
      expect(okResponse.status).toBe(201);

      // At count=2 (3rd collection, N+1th) -> rejected.
      mockPrisma.collection.count.mockResolvedValueOnce(2);
      const rejectRequest = jsonRequest("https://api.example.com/api/collections", "POST", {
        title: "Third",
      });
      const rejectResponse = await handler.handleCreate(rejectRequest, mockSession, mockEnv, ctx);
      expect(rejectResponse.status).toBe(409);
      const rejectBody = await rejectResponse.json();
      expect(rejectBody.error).toBe("LIMIT_EXCEEDED");
    });

    it("cap boundary is env-driven, not a literal", async () => {
      // With maxPerUser overridden to 5, a count of 2 (which rejected above) is now allowed.
      const widerEnv = {
        ...mockEnv,
        collection: { maxItems: 3, maxPerUser: 5 },
      } as unknown as Env;

      mockPrisma.collection.count.mockResolvedValue(2);
      mockPrisma.collection.create.mockResolvedValue(makeCollection({ id: "coll_3" }));

      const request = jsonRequest("https://api.example.com/api/collections", "POST", {
        title: "Third",
      });
      const response = await handler.handleCreate(request, mockSession, widerEnv, ctx);
      expect(response.status).toBe(201);
    });
  });

  describe("handleGet", () => {
    it("returns a public collection with its items for an anonymous caller", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(
        makeCollection({ visibility: "PUBLIC", itemCount: 1 }),
      );
      mockPrisma.collectionItem.findMany.mockResolvedValue([makeItem()]);
      mockPrisma.user.findMany.mockResolvedValue([{ id: "target_1" }]);
      mockPrisma.entity.findMany.mockResolvedValue([]);

      const request = jsonRequest("https://api.example.com/api/collections/coll_1", "GET");
      const response = await handler.handleGet("coll_1", request, null, mockEnv, ctx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].targetId).toBe("target_1");
    });

    it("returns 404 when not found", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(null);

      const request = jsonRequest("https://api.example.com/api/collections/missing", "GET");
      const response = await handler.handleGet("missing", request, null, mockEnv, ctx);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("NOT_FOUND");
    });

    it("returns 404 for a PRIVATE collection viewed by a non-owner (no leak)", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(
        makeCollection({ visibility: "PRIVATE", ownerUserId: "owner_1" }),
      );

      const request = jsonRequest("https://api.example.com/api/collections/coll_1", "GET");
      const response = await handler.handleGet("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(404);
    });

    it("returns 500 on database error", async () => {
      mockPrisma.collection.findUnique.mockRejectedValue(new Error("db down"));

      const request = jsonRequest("https://api.example.com/api/collections/coll_1", "GET");
      const response = await handler.handleGet("coll_1", request, null, mockEnv, ctx);

      expect(response.status).toBe(500);
    });

    it("SEC-12: filters out an item whose referent went private since it was added", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(
        makeCollection({ visibility: "UNLISTED", itemCount: 2 }),
      );
      mockPrisma.collectionItem.findMany.mockResolvedValue([
        makeItem({ id: "item_1", targetId: "still_public_user" }),
        makeItem({ id: "item_2", targetId: "now_private_user" }),
      ]);
      // Only the still-public user comes back from the PUBLIC-filtered query —
      // the now-private user is excluded because its profileVisibility is no
      // longer PUBLIC.
      mockPrisma.user.findMany.mockResolvedValue([{ id: "still_public_user" }]);
      mockPrisma.entity.findMany.mockResolvedValue([]);

      const request = jsonRequest("https://api.example.com/api/collections/coll_1", "GET");
      const response = await handler.handleGet("coll_1", request, null, mockEnv, ctx);

      expect(response.status).toBe(200);
      const body = await response.json();
      // The underlying stored itemCount still reflects both rows (denormalized,
      // unaffected by the read-time view filter)...
      expect(body.itemCount).toBe(2);
      // ...but only the currently-public referent is present in the response.
      expect(body.items).toHaveLength(1);
      expect(body.items[0].targetId).toBe("still_public_user");
    });

    it("does not filter items for a PRIVATE collection viewed by its owner", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(
        makeCollection({ visibility: "PRIVATE", itemCount: 1 }),
      );
      mockPrisma.collectionItem.findMany.mockResolvedValue([makeItem({ targetId: "private_user" })]);

      const request = jsonRequest("https://api.example.com/api/collections/coll_1", "GET");
      const response = await handler.handleGet("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items).toHaveLength(1);
      // No user/entity lookups performed — PRIVATE collections skip the filter.
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    });
  });

  describe("handleUpdate", () => {
    it("updates and returns 200", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(makeCollection());
      mockPrisma.collection.update.mockResolvedValue(makeCollection({ title: "Renamed" }));

      const request = jsonRequest("https://api.example.com/api/collections/coll_1", "PATCH", {
        title: "Renamed",
      });
      const response = await handler.handleUpdate("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.title).toBe("Renamed");
    });

    it("returns 404 when not found", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(null);

      const request = jsonRequest("https://api.example.com/api/collections/coll_1", "PATCH", {
        title: "Renamed",
      });
      const response = await handler.handleUpdate("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(404);
    });

    it("returns 403 when the caller does not own the collection", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(
        makeCollection({ ownerUserId: "someone_else" }),
      );

      const request = jsonRequest("https://api.example.com/api/collections/coll_1", "PATCH", {
        title: "Renamed",
      });
      const response = await handler.handleUpdate("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(403);
      expect(mockPrisma.collection.update).not.toHaveBeenCalled();
    });

    it("returns 500 on database error", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(makeCollection());
      mockPrisma.collection.update.mockRejectedValue(new Error("db down"));

      const request = jsonRequest("https://api.example.com/api/collections/coll_1", "PATCH", {
        title: "Renamed",
      });
      const response = await handler.handleUpdate("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(500);
    });
  });

  describe("handleDelete", () => {
    it("deletes and returns 204", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(makeCollection());
      mockPrisma.collection.delete.mockResolvedValue(makeCollection());

      const request = jsonRequest("https://api.example.com/api/collections/coll_1", "DELETE");
      const response = await handler.handleDelete("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(204);
      expect(mockPrisma.collection.delete).toHaveBeenCalledWith({ where: { id: "coll_1" } });
    });

    it("returns 404 when not found", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(null);

      const request = jsonRequest("https://api.example.com/api/collections/coll_1", "DELETE");
      const response = await handler.handleDelete("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(404);
    });

    it("returns 403 when the caller does not own the collection", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(
        makeCollection({ ownerUserId: "someone_else" }),
      );

      const request = jsonRequest("https://api.example.com/api/collections/coll_1", "DELETE");
      const response = await handler.handleDelete("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(403);
      expect(mockPrisma.collection.delete).not.toHaveBeenCalled();
    });

    it("returns 500 on database error", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(makeCollection());
      mockPrisma.collection.delete.mockRejectedValue(new Error("db down"));

      const request = jsonRequest("https://api.example.com/api/collections/coll_1", "DELETE");
      const response = await handler.handleDelete("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(500);
    });
  });

  describe("handleAddItem", () => {
    it("adds an item and returns 201", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(
        makeCollection({ visibility: "PRIVATE", itemCount: 0 }),
      );
      mockPrisma.user.findUnique.mockResolvedValue({ id: "target_1" });
      mockPrisma.collectionItem.create.mockResolvedValue(makeItem());
      mockPrisma.collection.update.mockResolvedValue(makeCollection({ itemCount: 1 }));

      const request = jsonRequest("https://api.example.com/api/collections/coll_1/items", "POST", {
        targetType: "user",
        targetId: "target_1",
      });
      const response = await handler.handleAddItem("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(201);
      expect(mockPrisma.collection.update).toHaveBeenCalledWith({
        where: { id: "coll_1" },
        data: { itemCount: { increment: 1 } },
      });
    });

    it("returns 404 when the collection does not exist", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(null);

      const request = jsonRequest("https://api.example.com/api/collections/coll_1/items", "POST", {
        targetType: "user",
        targetId: "target_1",
      });
      const response = await handler.handleAddItem("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(404);
    });

    it("returns 403 when the caller does not own the collection", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(
        makeCollection({ ownerUserId: "someone_else" }),
      );

      const request = jsonRequest("https://api.example.com/api/collections/coll_1/items", "POST", {
        targetType: "user",
        targetId: "target_1",
      });
      const response = await handler.handleAddItem("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(403);
    });

    it("returns 404 when the referent does not exist", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(makeCollection({ itemCount: 0 }));
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const request = jsonRequest("https://api.example.com/api/collections/coll_1/items", "POST", {
        targetType: "user",
        targetId: "ghost",
      });
      const response = await handler.handleAddItem("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("REFERENT_NOT_FOUND");
    });

    it("rejects (add-time) a non-public referent for a PUBLIC collection", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(
        makeCollection({ visibility: "PUBLIC", itemCount: 0 }),
      );
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ id: "target_1" }) // existence check
        .mockResolvedValueOnce({ profileVisibility: "PRIVATE" }); // public check

      const request = jsonRequest("https://api.example.com/api/collections/coll_1/items", "POST", {
        targetType: "user",
        targetId: "target_1",
      });
      const response = await handler.handleAddItem("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.error).toBe("REFERENT_NOT_PUBLIC");
      expect(mockPrisma.collectionItem.create).not.toHaveBeenCalled();
    });

    it("allows a non-public referent in a PRIVATE collection", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(
        makeCollection({ visibility: "PRIVATE", itemCount: 0 }),
      );
      mockPrisma.user.findUnique.mockResolvedValue({ id: "target_1" });
      mockPrisma.collectionItem.create.mockResolvedValue(makeItem());
      mockPrisma.collection.update.mockResolvedValue(makeCollection({ itemCount: 1 }));

      const request = jsonRequest("https://api.example.com/api/collections/coll_1/items", "POST", {
        targetType: "user",
        targetId: "target_1",
      });
      const response = await handler.handleAddItem("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(201);
    });

    it("rejects a duplicate item (unique constraint)", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(
        makeCollection({ visibility: "PRIVATE", itemCount: 1 }),
      );
      mockPrisma.user.findUnique.mockResolvedValue({ id: "target_1" });
      const conflict = Object.assign(new Error("unique constraint"), { code: "P2002" });
      mockPrisma.collectionItem.create.mockRejectedValue(conflict);

      const request = jsonRequest("https://api.example.com/api/collections/coll_1/items", "POST", {
        targetType: "user",
        targetId: "target_1",
      });
      const response = await handler.handleAddItem("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe("CONFLICT");
    });

    it("enforces maxItems as a boundary: Nth item ok, N+1th rejected", async () => {
      // maxItems = 3 (from mockEnv). itemCount=2 -> adding the 3rd is allowed.
      mockPrisma.collection.findUnique.mockResolvedValueOnce(
        makeCollection({ visibility: "PRIVATE", itemCount: 2 }),
      );
      mockPrisma.user.findUnique.mockResolvedValue({ id: "target_1" });
      mockPrisma.collectionItem.create.mockResolvedValue(makeItem());
      mockPrisma.collection.update.mockResolvedValue(makeCollection({ itemCount: 3 }));

      const okRequest = jsonRequest("https://api.example.com/api/collections/coll_1/items", "POST", {
        targetType: "user",
        targetId: "target_1",
      });
      const okResponse = await handler.handleAddItem("coll_1", okRequest, mockSession, mockEnv, ctx);
      expect(okResponse.status).toBe(201);

      // itemCount=3 (== maxItems) -> the 4th (N+1th) is rejected.
      mockPrisma.collection.findUnique.mockResolvedValueOnce(
        makeCollection({ visibility: "PRIVATE", itemCount: 3 }),
      );
      const rejectRequest = jsonRequest("https://api.example.com/api/collections/coll_1/items", "POST", {
        targetType: "user",
        targetId: "target_2",
      });
      const rejectResponse = await handler.handleAddItem("coll_1", rejectRequest, mockSession, mockEnv, ctx);
      expect(rejectResponse.status).toBe(409);
      const rejectBody = await rejectResponse.json();
      expect(rejectBody.error).toBe("LIMIT_EXCEEDED");
    });

    it("cap boundary is env-driven, not a literal", async () => {
      // With maxItems overridden to 5, itemCount=3 (which rejected above) is now allowed.
      const widerEnv = {
        ...mockEnv,
        collection: { maxItems: 5, maxPerUser: 2 },
      } as unknown as Env;

      mockPrisma.collection.findUnique.mockResolvedValue(
        makeCollection({ visibility: "PRIVATE", itemCount: 3 }),
      );
      mockPrisma.user.findUnique.mockResolvedValue({ id: "target_1" });
      mockPrisma.collectionItem.create.mockResolvedValue(makeItem());
      mockPrisma.collection.update.mockResolvedValue(makeCollection({ itemCount: 4 }));

      const request = jsonRequest("https://api.example.com/api/collections/coll_1/items", "POST", {
        targetType: "user",
        targetId: "target_1",
      });
      const response = await handler.handleAddItem("coll_1", request, mockSession, widerEnv, ctx);
      expect(response.status).toBe(201);
    });
  });

  describe("handleRemoveItem", () => {
    it("removes an item and decrements itemCount", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(makeCollection({ itemCount: 1 }));
      mockPrisma.collectionItem.findUnique.mockResolvedValue(makeItem());
      mockPrisma.collectionItem.delete.mockResolvedValue(makeItem());
      mockPrisma.collection.update.mockResolvedValue(makeCollection({ itemCount: 0 }));

      const request = jsonRequest(
        "https://api.example.com/api/collections/coll_1/items/item_1",
        "DELETE",
      );
      const response = await handler.handleRemoveItem(
        "coll_1",
        "item_1",
        request,
        mockSession,
        mockEnv,
        ctx,
      );

      expect(response.status).toBe(204);
      expect(mockPrisma.collection.update).toHaveBeenCalledWith({
        where: { id: "coll_1" },
        data: { itemCount: { decrement: 1 } },
      });
    });

    it("returns 403 when the caller does not own the collection", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(
        makeCollection({ ownerUserId: "someone_else" }),
      );

      const request = jsonRequest(
        "https://api.example.com/api/collections/coll_1/items/item_1",
        "DELETE",
      );
      const response = await handler.handleRemoveItem(
        "coll_1",
        "item_1",
        request,
        mockSession,
        mockEnv,
        ctx,
      );

      expect(response.status).toBe(403);
      expect(mockPrisma.collectionItem.delete).not.toHaveBeenCalled();
    });

    it("returns 404 when the item does not belong to the collection", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(makeCollection({ itemCount: 1 }));
      mockPrisma.collectionItem.findUnique.mockResolvedValue(
        makeItem({ collectionId: "different_collection" }),
      );

      const request = jsonRequest(
        "https://api.example.com/api/collections/coll_1/items/item_1",
        "DELETE",
      );
      const response = await handler.handleRemoveItem(
        "coll_1",
        "item_1",
        request,
        mockSession,
        mockEnv,
        ctx,
      );

      expect(response.status).toBe(404);
      expect(mockPrisma.collectionItem.delete).not.toHaveBeenCalled();
    });
  });

  describe("handleReorderItems", () => {
    it("persists new positions and leaves itemCount untouched", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(makeCollection({ itemCount: 2 }));
      mockPrisma.collectionItem.findMany
        .mockResolvedValueOnce([
          makeItem({ id: "item_1", position: 0 }),
          makeItem({ id: "item_2", position: 1 }),
        ])
        .mockResolvedValueOnce([
          makeItem({ id: "item_2", position: 0 }),
          makeItem({ id: "item_1", position: 1 }),
        ]);
      mockPrisma.collectionItem.update.mockResolvedValue({});

      const request = jsonRequest(
        "https://api.example.com/api/collections/coll_1/items/reorder",
        "PATCH",
        { orderedItemIds: ["item_2", "item_1"] },
      );
      const response = await handler.handleReorderItems("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(200);
      expect(mockPrisma.collectionItem.update).toHaveBeenNthCalledWith(1, {
        where: { id: "item_2" },
        data: { position: 0 },
      });
      expect(mockPrisma.collectionItem.update).toHaveBeenNthCalledWith(2, {
        where: { id: "item_1" },
        data: { position: 1 },
      });
      // Reordering never touches the denormalized itemCount.
      expect(mockPrisma.collection.update).not.toHaveBeenCalled();

      const body = await response.json();
      expect(body.items).toHaveLength(2);
    });

    it("returns 400 when orderedItemIds does not match the collection's current items", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(makeCollection({ itemCount: 2 }));
      mockPrisma.collectionItem.findMany.mockResolvedValue([
        makeItem({ id: "item_1" }),
        makeItem({ id: "item_2" }),
      ]);

      const request = jsonRequest(
        "https://api.example.com/api/collections/coll_1/items/reorder",
        "PATCH",
        { orderedItemIds: ["item_1", "item_not_in_collection"] },
      );
      const response = await handler.handleReorderItems("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(400);
      expect(mockPrisma.collectionItem.update).not.toHaveBeenCalled();
    });

    it("returns 403 when the caller does not own the collection", async () => {
      mockPrisma.collection.findUnique.mockResolvedValue(
        makeCollection({ ownerUserId: "someone_else" }),
      );

      const request = jsonRequest(
        "https://api.example.com/api/collections/coll_1/items/reorder",
        "PATCH",
        { orderedItemIds: ["item_1"] },
      );
      const response = await handler.handleReorderItems("coll_1", request, mockSession, mockEnv, ctx);

      expect(response.status).toBe(403);
    });
  });
});
