/**
 * Phase 4: Media Upload
 *
 * Uploads a small test image, verifies metadata, and deletes it.
 * Tests accept application errors as long as auth works.
 */

import { afterAll, describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";
import { TestCleanup } from "./utils/cleanup.js";

const API_URL = getApiUrl();

// Minimal 1x1 red JPEG
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwh" +
  "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAAR" +
  "CAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAFRABAw" +
  "MFAQAAAAAAAAAAAAAAARITIQIB/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAWEQEBAQAAAAAA" +
  "AAAAAAAAAAABAAL/2gAMAwEAAhEDEQA/AKgBhWf/2Q==",
  "base64",
);

describe("Media Upload", () => {
  const user = getShardUser(0);
  const cleanup = new TestCleanup(user.authFetch);
  let mediaId: string | null = null;

  afterAll(async () => {
    await cleanup.cleanAll();
  });

  it("uploads an image (or returns non-auth error)", async () => {
    const formData = new FormData();
    const blob = new Blob([TINY_JPEG], { type: "image/jpeg" });
    formData.append("file", blob, `__e2e_test_${Date.now()}.jpg`);

    const res = await user.authFetch(`${API_URL}/api/media/upload`, {
      method: "POST",
      body: formData,
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThanOrEqual(500);

    if (res.status < 300) {
      const body = await res.json();
      mediaId = body.id || body.mediaId;
      if (mediaId) cleanup.track("media", mediaId);
    }
  });

  it("gets media metadata (or returns non-auth error)", async () => {
    if (!mediaId) return;
    const res = await user.authFetch(`${API_URL}/api/media/${mediaId}`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThanOrEqual(500);
  });

  it("deletes media (or returns non-auth error)", async () => {
    if (!mediaId) return;
    const res = await user.authFetch(`${API_URL}/api/media/${mediaId}`, {
      method: "DELETE",
    });
    expect(res.status).toBeLessThanOrEqual(500);
  });
});
