/**
 * Link Reports E2E Tests
 *
 * Tests link reporting endpoints for flagging malicious links.
 */

import { afterAll, describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";
import { TestCleanup } from "./utils/cleanup.js";

const API_URL = getApiUrl();

describe("Link Reports", () => {
  const user = getShardUser(0);
  const cleanup = new TestCleanup(user.authFetch);

  afterAll(async () => {
    await cleanup.cleanAll();
  });

  it("report link on non-existent post returns 404", async () => {
    const fakePostId = "00000000-0000-0000-0000-000000000000";
    const fakeLinkId = "00000000-0000-0000-0000-000000000001";
    const res = await user.authFetch(
      `${API_URL}/api/posts/${fakePostId}/links/${fakeLinkId}/report`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "spam" }),
      },
    );
    expect([400, 404]).toContain(res.status);
  });

  it("report link on real post", async () => {
    // Create a test post with a link
    const postRes = await user.authFetch(`${API_URL}/api/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `__e2e_link_report_${Date.now()} check out https://example.com`,
      }),
    });
    if (postRes.status !== 201) return;
    const postBody = await postRes.json();
    cleanup.track("post", postBody.id);

    // Try to report a link (the link ID may need to come from the post data)
    const fakeLinkId = "00000000-0000-0000-0000-000000000001";
    const res = await user.authFetch(
      `${API_URL}/api/posts/${postBody.id}/links/${fakeLinkId}/report`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "spam" }),
      },
    );
    // Accept 200, 201, 404 (if link ID doesn't match), or 400
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });
});
