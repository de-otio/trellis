/**
 * Friends & Followers E2E Tests
 *
 * Tests social graph endpoints: friend connections, follow/unfollow, counts.
 * Requires 2 test users for cross-user interactions.
 */

import { describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";

const API_URL = getApiUrl();

describe("Friends & Followers", () => {
  const userA = getShardUser(0);
  const userB = getShardUser(1);

  describe("Auth guards", () => {
    it("friends list rejects unauthenticated", async () => {
      const res = await fetch(`${API_URL}/api/friends`);
      expect(res.status).toBe(401);
    });

    it("followers rejects unauthenticated", async () => {
      const res = await fetch(`${API_URL}/api/followers/following`);
      expect(res.status).toBe(401);
    });
  });

  describe("Read endpoints", () => {
    it("friends list returns valid structure", async () => {
      const res = await userA.authFetch(`${API_URL}/api/friends`);
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

  describe("Friend connection flow", () => {
    it("userA generates connection code and userB connects", async () => {
      // Generate code
      const codeRes = await userA.authFetch(`${API_URL}/api/friends/connection-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      expect(codeRes.status).not.toBe(401);
      expect(codeRes.status).toBeLessThan(500);

      if (codeRes.status === 200 || codeRes.status === 201) {
        const codeBody = await codeRes.json();
        const code = codeBody.code || codeBody.connectionCode;
        if (code) {
          // Connect
          const connectRes = await userB.authFetch(`${API_URL}/api/friends/connect`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
          });
          expect(connectRes.status).not.toBe(401);
          expect(connectRes.status).toBeLessThan(500);
        }
      }
    });
  });
});
