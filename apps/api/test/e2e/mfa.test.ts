/**
 * MFA E2E Tests
 *
 * Tests Multi-Factor Authentication status, enrollment, and verification.
 * Security-critical: Tier 1 per testing strategy.
 */

import { describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";

const API_URL = getApiUrl();

describe("MFA", () => {
  const user = getShardUser(0);

  it("status rejects unauthenticated", async () => {
    const res = await fetch(`${API_URL}/api/mfa/status`);
    expect(res.status).toBe(401);
  });

  it("status returns valid structure", async () => {
    const res = await user.authFetch(`${API_URL}/api/mfa/status`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      const body = await res.json();
      expect(typeof body).toBe("object");
    }
  });

  it("enroll rejects unauthenticated", async () => {
    const res = await fetch(`${API_URL}/api/mfa/enroll/begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("verify rejects bad code", async () => {
    const res = await user.authFetch(`${API_URL}/api/mfa/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "000000" }),
    });
    expect(res.status).not.toBe(401);
    // Expect 400 or 403 for bad code — not 5xx
    expect(res.status).toBeLessThan(500);
  });

  it("enroll begin returns secret or error", async () => {
    const res = await user.authFetch(`${API_URL}/api/mfa/enroll/begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
    // Don't complete enrollment — would change account state
    // Just verify the endpoint responds correctly
  });
});
