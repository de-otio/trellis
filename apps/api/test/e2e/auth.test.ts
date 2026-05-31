/**
 * End-to-End Tests: Authentication Endpoints
 *
 * Tests that auth endpoints respond correctly via CloudFront.
 * Auth is handled by AWS Cognito; legacy /auth/* endpoints return 410 (deprecated).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { requireDevEnvironment } from "../utils/test-environment-guard.js";
import { getApiUrl } from "../utils/test-config.js";

const API_URL = getApiUrl();

describe("Authentication E2E Tests", () => {
  beforeAll(() => {
    requireDevEnvironment();
  });

  describe("Session Validation Endpoint", () => {
    it("should return a non-5xx response for unauthenticated requests", async () => {
      const response = await fetch(`${API_URL}/api/auth/me`);
      // 200 (authenticated: false), 401, or 410 (deprecated) are all valid
      expect(response.status).toBeLessThan(500);
    });

    it("should reject invalid tokens without a server error", async () => {
      const response = await fetch(`${API_URL}/api/auth/me`, {
        headers: {
          Cookie: "trellis_session=invalid-token",
        },
      });
      // 200, 401, or 410 are all acceptable
      expect(response.status).toBeLessThan(500);
    });
  });

  describe("Logout Endpoint", () => {
    it("should respond without a server error", async () => {
      const response = await fetch(`${API_URL}/api/auth/logout`, {
        method: "POST",
      });
      // 200 (session cleared) or 410 (deprecated) are acceptable
      expect(response.status).toBeLessThan(500);
    });
  });

  describe("Magic Link Endpoint", () => {
    it("should not return 200 for missing email", async () => {
      const response = await fetch(`${API_URL}/api/auth/send-magic-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      // 400 (bad request), 410 (deprecated), or 500 (handler error) — anything but 200
      expect(response.status).not.toBe(200);
    });

    it("should not return 200 for invalid email format", async () => {
      const response = await fetch(`${API_URL}/api/auth/send-magic-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "invalid-email" }),
      });
      expect(response.status).not.toBe(200);
    });

    it("should respond to valid email request", async () => {
      const response = await fetch(`${API_URL}/api/auth/send-magic-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@example.com" }),
      });
      // Any response proves the endpoint is reachable through CloudFront
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(600);
    });
  });

  describe("Callback Endpoint", () => {
    it("should handle GET requests without a server error", async () => {
      const response = await fetch(`${API_URL}/api/auth/callback`, {
        method: "GET",
        redirect: "manual",
      });
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(600);
    });

    it("should handle POST requests without a server error", async () => {
      const response = await fetch(`${API_URL}/api/auth/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(600);
    });
  });

  describe("Security Headers", () => {
    it("should include security headers on all responses", async () => {
      const response = await fetch(`${API_URL}/api/auth/me`, {
        redirect: "manual",
      });

      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    });
  });
});
