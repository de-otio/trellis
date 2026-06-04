/**
 * Extended Unit Tests: Security Headers
 *
 * Tests edge cases for security headers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SecurityHeaders } from "../../src/lib/security-headers.js";

describe("Security Headers Extended", () => {
  let securityHeaders: SecurityHeaders;

  beforeEach(() => {
    securityHeaders = new SecurityHeaders();
  });

  describe("createSecureResponse", () => {
    it("should add security headers to response", () => {
      const response = securityHeaders.createSecureResponse("OK", {
        status: 200,
      });
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("X-XSS-Protection")).toBe("1; mode=block");
    });

    it("should preserve existing headers", () => {
      const response = securityHeaders.createSecureResponse("OK", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });

    it("should handle different status codes", () => {
      const response200 = securityHeaders.createSecureResponse("OK", {
        status: 200,
      });
      const response404 = securityHeaders.createSecureResponse("Not Found", {
        status: 404,
      });
      const response500 = securityHeaders.createSecureResponse("Error", {
        status: 500,
      });

      expect(response200.status).toBe(200);
      expect(response404.status).toBe(404);
      expect(response500.status).toBe(500);
    });
  });

  describe("addSecurityHeaders", () => {
    it("should add security headers to existing response", () => {
      const response = new Response("OK", { status: 200 });
      const secured = securityHeaders.addSecurityHeaders(response);
      expect(secured.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });

    it("should not duplicate headers", () => {
      const response = new Response("OK", {
        status: 200,
        headers: { "X-Content-Type-Options": "nosniff" },
      });
      const secured = securityHeaders.addSecurityHeaders(response);
      const values = secured.headers.get("X-Content-Type-Options");
      expect(values).toBe("nosniff");
    });
  });
});
