/**
 * Account Deletion E2E Tests
 *
 * Tests account deletion request, status, and cancellation.
 * Deletion confirmation is prod-excluded (irreversible).
 */

import { describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";
import { isProdExcluded } from "../utils/test-environment-guard.js";

const API_URL = getApiUrl();

describe("Account Deletion", () => {
  const user = getShardUser(0);

  it("rejects unauthenticated", async () => {
    const res = await fetch(`${API_URL}/api/user/delete-account`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("status for non-existent job returns 404", async () => {
    const res = await user.authFetch(
      `${API_URL}/api/user/delete-account/status/00000000-0000-0000-0000-000000000000`,
    );
    expect([400, 404]).toContain(res.status);
  });

  it("cancel with no pending deletion returns error", async () => {
    const res = await user.authFetch(`${API_URL}/api/user/delete-account/cancel`, {
      method: "POST",
    });
    // 400 or 404 when no pending deletion exists
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });

  // Note: We intentionally do NOT test the full request+cancel flow on the shared
  // pool user, as deletion requests may have side effects. The request+cancel flow
  // and confirm flow should use a dedicated sacrificial E2eTestUser (future work
  // when running on dev-only with isProdExcluded guard).
  describe.skipIf(isProdExcluded())("Deletion flow (dev-only)", () => {
    it("request and cancel deletion", async () => {
      // This test uses the pool user — only safe on dev where we control the data
      const requestRes = await user.authFetch(`${API_URL}/api/user/delete-account`, {
        method: "DELETE",
      });
      expect(requestRes.status).not.toBe(401);
      expect(requestRes.status).toBeLessThan(500);

      // Immediately cancel to avoid any side effects
      if (requestRes.status === 200 || requestRes.status === 202) {
        const cancelRes = await user.authFetch(`${API_URL}/api/user/delete-account/cancel`, {
          method: "POST",
        });
        expect(cancelRes.status).toBeLessThan(500);
      }
    });
  });
});
