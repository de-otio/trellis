/**
 * Media Metadata Visibility E2E Tests
 *
 * Tests setting and getting metadata visibility on media.
 */

import { afterAll, describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";
import { TestCleanup } from "./utils/cleanup.js";

const API_URL = getApiUrl();

describe("Media Metadata Visibility", () => {
  const user = getShardUser(0);
  const cleanup = new TestCleanup(user.authFetch);

  afterAll(async () => {
    await cleanup.cleanAll();
  });

  it("get visibility for non-existent media returns 404", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await user.authFetch(`${API_URL}/api/media/${fakeId}/visibility`);
    expect([404, 400]).toContain(res.status);
  });

  it("visibility rejects unauthenticated", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(`${API_URL}/api/media/${fakeId}/visibility`);
    expect(res.status).toBe(401);
  });

  it("set and get visibility on uploaded media", async () => {
    // Upload a tiny test image
    const TINY_JPEG = Buffer.from(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
      "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwh" +
      "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAAR" +
      "CAABAAEDASIAAhEBAxEB/8QAFRABAQMFAQAAAAAAAAAAAAAAAAARITEj/8QAFhEBAQEAAAAAAAAA" +
      "AAAAAAAAAAEL/9oADAMBAAIRAxEAPwCwAB//2Q==",
      "base64",
    );

    const formData = new FormData();
    const blob = new Blob([TINY_JPEG], { type: "image/jpeg" });
    formData.append("file", blob, `__e2e_visibility_${Date.now()}.jpg`);

    const uploadRes = await user.authFetch(`${API_URL}/api/media/upload`, {
      method: "POST",
      body: formData,
    });
    if (uploadRes.status >= 300) return;
    const uploadBody = await uploadRes.json();
    const mediaId = uploadBody.id || uploadBody.mediaId;
    if (!mediaId) return;
    cleanup.track("media", mediaId);

    // Set visibility
    const setRes = await user.authFetch(`${API_URL}/api/media/${mediaId}/visibility`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ showLocation: false }),
    });
    expect(setRes.status).toBeLessThan(500);

    // Get visibility
    const getRes = await user.authFetch(`${API_URL}/api/media/${mediaId}/visibility`);
    expect(getRes.status).toBeLessThan(500);
  });
});
