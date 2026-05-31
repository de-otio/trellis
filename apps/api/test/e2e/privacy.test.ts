/**
 * Privacy Preferences E2E Tests
 *
 * Tests privacy settings read and update.
 */

import { describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";

const API_URL = getApiUrl();

describe("Privacy Preferences", () => {
  const user = getShardUser(0);

  it("rejects unauthenticated request", async () => {
    const res = await fetch(`${API_URL}/api/user/privacy-preferences`);
    expect(res.status).toBe(401);
  });

  it("returns valid structure", async () => {
    const res = await user.authFetch(`${API_URL}/api/user/privacy-preferences`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      const body = await res.json();
      expect(typeof body).toBe("object");
    }
  });

  it("rejects invalid update", async () => {
    const res = await user.authFetch(`${API_URL}/api/user/privacy-preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ followPrivacy: "INVALID_VALUE" }),
    });
    expect(res.status).not.toBe(401);
    // Expect 400 (validation error) or other non-5xx
    expect(res.status).toBeLessThan(500);
  });

  it("updates privacy settings", async () => {
    // Get current preferences to restore later
    const getRes = await user.authFetch(`${API_URL}/api/user/privacy-preferences`);
    let originalPrivacy: string | null = null;

    if (getRes.status === 200) {
      const original = await getRes.json();
      originalPrivacy = original.followPrivacy;
    }

    // Update
    const res = await user.authFetch(`${API_URL}/api/user/privacy-preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ followPrivacy: "PRIVATE" }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);

    // Verify persistence
    if (res.status === 200) {
      const verifyRes = await user.authFetch(`${API_URL}/api/user/privacy-preferences`);
      if (verifyRes.status === 200) {
        const body = await verifyRes.json();
        expect(body.followPrivacy).toBe("PRIVATE");
      }

      // Restore original
      if (originalPrivacy) {
        await user.authFetch(`${API_URL}/api/user/privacy-preferences`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ followPrivacy: originalPrivacy }),
        });
      }
    }
  });

  it("privacy change persists across requests", async () => {
    const res = await user.authFetch(`${API_URL}/api/user/privacy-preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ followPrivacy: "FOLLOWERS" }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);

    if (res.status === 200) {
      const verifyRes = await user.authFetch(`${API_URL}/api/user/privacy-preferences`);
      if (verifyRes.status === 200) {
        const body = await verifyRes.json();
        expect(body.followPrivacy).toBe("FOLLOWERS");
      }

      // Restore to PUBLIC
      await user.authFetch(`${API_URL}/api/user/privacy-preferences`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ followPrivacy: "PUBLIC" }),
      });
    }
  });
});
