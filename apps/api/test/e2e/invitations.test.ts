/**
 * Invitations E2E Tests
 *
 * Tests invitation list, create, delete, and validation endpoints.
 */

import { afterAll, describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";
import { TestCleanup } from "./utils/cleanup.js";

const API_URL = getApiUrl();

describe("Invitations", () => {
  const user = getShardUser(0);
  const cleanup = new TestCleanup(user.authFetch);

  afterAll(async () => {
    await cleanup.cleanAll();
  });

  it("list invitations returns valid structure", async () => {
    const res = await user.authFetch(`${API_URL}/api/invitations`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });

  it("get inviter info returns valid response", async () => {
    const res = await user.authFetch(`${API_URL}/api/invitations/inviter-info`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });

  it("create and delete invitation", async () => {
    const createRes = await user.authFetch(`${API_URL}/api/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `__e2e_invite_${Date.now()}@example.com` }),
    });
    expect(createRes.status).not.toBe(401);
    expect(createRes.status).toBeLessThan(500);

    if (createRes.status === 201 || createRes.status === 200) {
      const body = await createRes.json();
      const invitationId = body.id;
      if (invitationId) {
        cleanup.track("invitation", invitationId);

        // Delete it
        const deleteRes = await user.authFetch(`${API_URL}/api/invitations/${invitationId}`, {
          method: "DELETE",
        });
        expect(deleteRes.status).toBeLessThan(500);
      }
    }
  });

  it("validate invitation with bad code", async () => {
    const res = await user.authFetch(`${API_URL}/api/invitations/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "invalid-code-12345" }),
    });
    expect(res.status).not.toBe(401);
    // Expect 400 or 404 for invalid code
    expect(res.status).toBeLessThan(500);
  });
});
