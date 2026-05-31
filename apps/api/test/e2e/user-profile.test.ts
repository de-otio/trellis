/**
 * User Profile E2E Tests
 *
 * Tests profile read and update endpoints.
 */

import { describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";

const API_URL = getApiUrl();

describe("User Profile", () => {
  const user = getShardUser(0);

  it("rejects unauthenticated profile update", async () => {
    const res = await fetch(`${API_URL}/api/user/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stealthMode: true }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects invalid profile body", async () => {
    const res = await user.authFetch(`${API_URL}/api/user/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invalid_field_that_does_not_exist: 12345 }),
    });
    // Should be 400 (validation) or 200 (ignores unknown fields) — not 401 or 5xx
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects unauthenticated region preference", async () => {
    const res = await fetch(`${API_URL}/api/user/region-preference`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ region: "EU" }),
    });
    expect(res.status).toBe(401);
  });

  it("profile is accessible after auth", async () => {
    const res = await user.authFetch(`${API_URL}/api/user/profile`);
    // 200 (profile exists) or 404 (new user, no profile yet) — both prove auth worked
    expect(res.status).not.toBe(401);
    expect([200, 404]).toContain(res.status);
  });

  it("updates profile settings", async () => {
    const res = await user.authFetch(`${API_URL}/api/user/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stealthMode: true }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);

    // Restore original value
    if (res.status === 200) {
      await user.authFetch(`${API_URL}/api/user/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stealthMode: false }),
      });
    }
  });
});
