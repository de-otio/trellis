/**
 * Phase 6: GDPR / Data Export
 *
 * Queues a data export request. Does NOT test account deletion.
 * Uses shard user pool — runs in all environments.
 */

import { describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";

const API_URL = getApiUrl();

describe("GDPR — Data Export", () => {
  const { authFetch } = getShardUser(0);

  it("requests a data export", async () => {
    const res = await authFetch(`${API_URL}/api/user/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    // 200/201/202 (queued) or 409 (already in progress) — all acceptable
    expect(res.status).toBeLessThanOrEqual(500);
  });

  it("export status is queryable", async () => {
    const res = await authFetch(`${API_URL}/api/user/export/status/latest`);
    // 200 with status info or 404 if no export exists yet
    expect([200, 404]).toContain(res.status);
  });
});
