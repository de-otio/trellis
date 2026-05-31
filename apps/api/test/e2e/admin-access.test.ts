/**
 * Admin Access Control E2E Tests
 *
 * Verifies that admin endpoints reject non-admin users.
 * Uses a regular END_USER test user — should always get 403.
 */

import { describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";

const API_URL = getApiUrl();

describe("Admin Access Control", () => {
  const user = getShardUser(0);

  it("dashboard metrics rejects non-admin", async () => {
    const res = await user.authFetch(`${API_URL}/api/dashboard/metrics/users`);
    expect([403, 401]).toContain(res.status);
  });

  it("system health rejects non-admin", async () => {
    const res = await user.authFetch(`${API_URL}/api/dashboard/system/health`);
    expect([403, 401]).toContain(res.status);
  });

  it("admin user list rejects non-admin", async () => {
    const res = await user.authFetch(`${API_URL}/api/admin/users`);
    expect([403, 401]).toContain(res.status);
  });

  it("employees rejects non-partner", async () => {
    const res = await user.authFetch(`${API_URL}/api/employees`);
    expect([403, 401]).toContain(res.status);
  });
});
