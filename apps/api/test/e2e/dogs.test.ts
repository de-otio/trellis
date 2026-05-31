/**
 * End-to-End Tests: Entity Profile Endpoints
 *
 * Tests for entity profile endpoints (replaces dog profiles for white-label support).
 * These tests verify endpoints against a live API.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { requireDevEnvironment } from "../utils/test-environment-guard.js";
import { getApiUrl } from "../utils/test-config.js";

const API_URL = getApiUrl();

describe("Entity Profiles E2E Tests", () => {
  beforeAll(() => {
    requireDevEnvironment();
  });

  describe("GET /api/entities", () => {
    it("should return 401 for unauthenticated requests", async () => {
      const response = await fetch(`${API_URL}/api/entities`);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBeDefined();
    });
  });

  describe("POST /api/entities", () => {
    it("should return 401 for unauthenticated requests", async () => {
      const response = await fetch(`${API_URL}/api/entities`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Test Entity",
        }),
      });

      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/entities/:id", () => {
    it("should return 401 for unauthenticated requests", async () => {
      const response = await fetch(`${API_URL}/api/entities/test-id`);

      expect(response.status).toBe(401);
    });
  });

  describe("Error Sanitization", () => {
    it("should not expose internal error details", async () => {
      // Make request that might cause internal error
      const response = await fetch(`${API_URL}/api/entities`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `session=invalid-session-token`,
        },
        body: JSON.stringify({
          name: "Test",
        }),
      });

      // Should return sanitized error
      const body = await response.json();
      expect(body.error).toBeDefined();
      expect(body.error).not.toContain("stack");
      expect(body.error).not.toContain("at ");
      expect(body.error).not.toMatch(/TypeError|Error:/);
    });
  });
});
