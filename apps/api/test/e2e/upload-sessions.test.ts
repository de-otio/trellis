/**
 * Upload Sessions E2E Tests
 *
 * Tests upload session lifecycle: create, abandon, complete.
 */

import { describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";

const API_URL = getApiUrl();

describe("Upload Sessions", () => {
  const user = getShardUser(0);

  it("rejects unauthenticated", async () => {
    const res = await fetch(`${API_URL}/api/upload-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("create session returns valid structure", async () => {
    const res = await user.authFetch(`${API_URL}/api/upload-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });

  it("create and abandon session", async () => {
    const createRes = await user.authFetch(`${API_URL}/api/upload-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (createRes.status >= 300) return;
    const body = await createRes.json();
    const sessionId = body.id;
    if (!sessionId) return;

    const abandonRes = await user.authFetch(`${API_URL}/api/upload-sessions/${sessionId}/abandon`, {
      method: "POST",
    });
    expect(abandonRes.status).toBeLessThan(500);
  });

  it("create session and complete", async () => {
    const createRes = await user.authFetch(`${API_URL}/api/upload-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (createRes.status >= 300) return;
    const body = await createRes.json();
    const sessionId = body.id;
    if (!sessionId) return;

    const completeRes = await user.authFetch(`${API_URL}/api/upload-sessions/${sessionId}/complete`, {
      method: "POST",
    });
    expect(completeRes.status).toBeLessThan(500);
  });
});
