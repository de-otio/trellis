/**
 * Phase 1: Smoke Tests — PROD-SAFE
 *
 * Read-only checks that the deployment is alive and correctly configured.
 * No authentication required. No state changes. Safe to run anywhere.
 */

import { describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";

const API_URL = getApiUrl();

describe("Smoke Tests", () => {
  it("health check returns ok", async () => {
    const res = await fetch(`${API_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("unknown route returns 404 without stack trace", async () => {
    const res = await fetch(`${API_URL}/api/nonexistent-route-e2e-test`);
    expect(res.status).toBe(404);
    const text = await res.text();
    // Must not leak internal details
    expect(text).not.toContain("at Object.");
    expect(text).not.toContain("node_modules");
    expect(text).not.toContain("Error:");
  });

  it("CORS preflight returns allow headers", async () => {
    const res = await fetch(`${API_URL}/api/entities`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).not.toBeNull();
  });

  it("security headers are present", async () => {
    const res = await fetch(`${API_URL}/health`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("protected API routes require auth", async () => {
    const res = await fetch(`${API_URL}/api/entities`);
    expect(res.status).toBe(401);
  });
});
