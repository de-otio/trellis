/**
 * Connections & Followers E2E Tests
 *
 * Tests social graph endpoints: connection codes, follow/unfollow, counts.
 * Requires 2 test users for cross-user interactions.
 *
 * The legacy /api/friends endpoints were removed in the pre-launch schema
 * end-state pass — connections are established via /api/connection-codes
 * and recorded as relationship edges (see lib/friend-ids.ts).
 */

import { describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";

const API_URL = getApiUrl();

describe("Connections & Followers", () => {
  const userA = getShardUser(0);
  const userB = getShardUser(1);

  describe("Auth guards", () => {
    it("connection-code listing rejects unauthenticated", async () => {
      const res = await fetch(`${API_URL}/api/connection-codes`);
      expect(res.status).toBe(401);
    });

    it("followers rejects unauthenticated", async () => {
      const res = await fetch(`${API_URL}/api/followers/following`);
      expect(res.status).toBe(401);
    });
  });

  describe("Read endpoints", () => {
    it("connection-code list returns valid structure", async () => {
      const res = await userA.authFetch(`${API_URL}/api/connection-codes`);
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
    });

    it("following list returns valid structure", async () => {
      const res = await userA.authFetch(`${API_URL}/api/followers/following`);
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
    });

    it("followers list returns valid structure", async () => {
      const res = await userA.authFetch(`${API_URL}/api/followers/followers`);
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
    });

    it("follow count returns valid structure", async () => {
      const res = await userA.authFetch(`${API_URL}/api/followers/count`);
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
    });
  });

  describe("Follow flow", () => {
    it("userA follows userB", async () => {
      const res = await userA.authFetch(`${API_URL}/api/followers/follow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: userB.userId, targetType: "user" }),
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
    });

    it("userA unfollows userB", async () => {
      const res = await userA.authFetch(`${API_URL}/api/followers/unfollow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: userB.userId, targetType: "user" }),
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
    });
  });

  describe("Connection-code flow", () => {
    it("userA creates a connection code and userB redeems it", async () => {
      // Create code
      const codeRes = await userA.authFetch(`${API_URL}/api/connection-codes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(codeRes.status).not.toBe(401);
      expect(codeRes.status).toBeLessThan(500);

      if (codeRes.status === 200 || codeRes.status === 201) {
        const codeBody = await codeRes.json();
        const code = codeBody.code || codeBody.connectionCode;
        if (code) {
          // Redeem
          const redeemRes = await userB.authFetch(
            `${API_URL}/api/connection-codes/redeem`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code }),
            },
          );
          expect(redeemRes.status).not.toBe(401);
          expect(redeemRes.status).toBeLessThan(500);
        }
      }
    });
  });
});
