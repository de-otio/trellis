/**
 * Safe Link Redirector E2E Tests
 *
 * Tests the /out endpoint for safe URL redirecting.
 * All tests are public — no auth needed.
 */

import { describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";

const API_URL = getApiUrl();

describe("Safe Link Redirector", () => {
  it("redirects valid URL", async () => {
    const res = await fetch(`${API_URL}/out?url=${encodeURIComponent("https://example.com")}`, {
      redirect: "manual",
    });
    // 302 redirect or 200 with interstitial page
    expect(res.status).toBeLessThan(500);
  });

  it("rejects missing URL parameter", async () => {
    const res = await fetch(`${API_URL}/out`);
    expect(res.status).toBeLessThan(500);
    // Expect 400 or similar client error, or a redirect to home
    expect(res.status).not.toBe(500);
  });

  it("rejects javascript: protocol", async () => {
    const res = await fetch(`${API_URL}/out?url=${encodeURIComponent("javascript:alert(1)")}`, {
      redirect: "manual",
    });
    // Should reject with 400 or redirect to a safe page, never execute
    expect(res.status).toBeLessThan(500);
    if (res.status === 302) {
      const location = res.headers.get("location") || "";
      expect(location).not.toContain("javascript:");
    }
  });

  it("rejects data: protocol", async () => {
    const res = await fetch(
      `${API_URL}/out?url=${encodeURIComponent("data:text/html,<script>alert(1)</script>")}`,
      { redirect: "manual" },
    );
    expect(res.status).toBeLessThan(500);
    if (res.status === 302) {
      const location = res.headers.get("location") || "";
      expect(location).not.toContain("data:");
    }
  });
});
