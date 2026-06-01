/**
 * Unit Tests: FriendshipService (stub contract lock)
 *
 * FriendshipService is a deliberate no-op stub. The Friendship model was
 * removed; mutual relationships now live in the graph DB. These tests lock
 * the stub contract so the deprecated ActivityPub friendship path cannot
 * silently come back returning real data.
 *
 * No real Prisma deps are exercised — `{} as any` is passed for the db arg.
 */

import { describe, expect, it } from "vitest";
import { FriendshipService } from "../../../src/lib/activitypub/friendship-service.js";

const db = {} as any;

describe("FriendshipService (stub)", () => {
  describe("createFriendship", () => {
    it("resolves without throwing", async () => {
      await expect(
        FriendshipService.createFriendship(
          db,
          "https://example.com/users/alice",
          "https://example.com/users/bob",
          "pending",
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe("acceptFriendship", () => {
    it("resolves without throwing", async () => {
      await expect(
        FriendshipService.acceptFriendship(
          db,
          "https://example.com/users/alice",
          "https://example.com/users/bob",
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe("getFriendsActorUris", () => {
    it("resolves to an empty array with only required args", async () => {
      const result = await FriendshipService.getFriendsActorUris(
        db,
        "https://example.com/users/alice",
      );
      expect(result).toEqual([]);
    });

    it("resolves to an empty array when page and limit are supplied", async () => {
      const result = await FriendshipService.getFriendsActorUris(
        db,
        "https://example.com/users/alice",
        2,
        50,
      );
      expect(result).toEqual([]);
    });
  });

  describe("getFriendsCount", () => {
    it("resolves to 0", async () => {
      const result = await FriendshipService.getFriendsCount(
        db,
        "https://example.com/users/alice",
      );
      expect(result).toBe(0);
    });
  });
});
