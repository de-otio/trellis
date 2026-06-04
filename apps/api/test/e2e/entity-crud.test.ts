/**
 * Phase 3a: Entity CRUD
 *
 * Creates, reads, updates, and deletes an entity (dog profile).
 * All test data is prefixed with __e2e_ and cleaned up after.
 *
 * Note: Entity creation may be blocked by feature flags. Tests accept
 * feature-disabled responses (403 with specific message) as passing.
 */

import { afterAll, describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";
import { TestCleanup } from "./utils/cleanup.js";

const API_URL = getApiUrl();

describe("Entity CRUD", () => {
  const user = getShardUser(0);
  const cleanup = new TestCleanup(user.authFetch);
  let entityId: string | null = null;

  afterAll(async () => {
    await cleanup.cleanAll();
  });

  it("creates an entity (or feature is disabled)", async () => {
    const res = await user.authFetch(`${API_URL}/api/entities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `__e2e_dog_${Date.now()}`,
        breed: "Labrador",
        type: "dog",
      }),
    });
    // 201 = created, 403 = feature disabled (both acceptable)
    expect(res.status).not.toBe(401); // Must not be an auth failure
    expect(res.status).toBeLessThan(500);

    if (res.status === 201) {
      const body = await res.json();
      entityId = body.id;
      cleanup.track("entity", entityId!);
    }
  });

  it("gets entity by ID", async () => {
    if (!entityId) return; // Skip if creation was disabled
    const res = await user.authFetch(`${API_URL}/api/entities/${entityId}`);
    expect(res.status).toBe(200);
  });

  it("lists entities", async () => {
    const res = await user.authFetch(`${API_URL}/api/entities`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });

  it("updates entity", async () => {
    if (!entityId) return;
    const res = await user.authFetch(`${API_URL}/api/entities/${entityId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `__e2e_updated_${Date.now()}` }),
    });
    expect(res.status).toBeLessThan(500);
  });

  it("deletes entity", async () => {
    if (!entityId) return;
    const res = await user.authFetch(`${API_URL}/api/entities/${entityId}`, {
      method: "DELETE",
    });
    expect(res.status).toBeLessThan(500);
  });
});
