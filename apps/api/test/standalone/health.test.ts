/**
 * Standalone — health & auth gating.
 *
 * The booted server (global-setup.ts) must answer /health and gate protected
 * routes, with no AWS and no consuming vertical.
 */

import { describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";

const API_URL = getApiUrl();

describe("standalone: health & gating", () => {
  it("GET /health returns 200 with ok:true", async () => {
    const res = await fetch(`${API_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("includes security headers on responses", async () => {
    const res = await fetch(`${API_URL}/health`);
    // SecurityHeaders sets a baseline set on every response.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects an unauthenticated protected request with 401", async () => {
    const res = await fetch(`${API_URL}/api/entities`);
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown route", async () => {
    const res = await fetch(`${API_URL}/api/does-not-exist-zzz`);
    expect(res.status).toBe(404);
  });
});
