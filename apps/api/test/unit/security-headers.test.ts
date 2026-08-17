import { describe, expect, it } from "vitest";
import {
  SecurityHeaders,
  SecurityHeadersEnv,
} from "../../src/lib/security-headers.js";

describe("SecurityHeaders", () => {
  describe("Default Security Headers", () => {
    it("should include HSTS header", () => {
      const securityHeaders = new SecurityHeaders();
      const response = new Response("test");
      const secureResponse = securityHeaders.addSecurityHeaders(response);

      const hsts = secureResponse.headers.get("Strict-Transport-Security");
      expect(hsts).toBe("max-age=31536000; includeSubDomains; preload");
    });

    it("should include X-Content-Type-Options", () => {
      const securityHeaders = new SecurityHeaders();
      const response = new Response("test");
      const secureResponse = securityHeaders.addSecurityHeaders(response);

      const header = secureResponse.headers.get("X-Content-Type-Options");
      expect(header).toBe("nosniff");
    });

    it("should include X-Frame-Options", () => {
      const securityHeaders = new SecurityHeaders();
      const response = new Response("test");
      const secureResponse = securityHeaders.addSecurityHeaders(response);

      const header = secureResponse.headers.get("X-Frame-Options");
      expect(header).toBe("DENY");
    });

    it("should include X-XSS-Protection", () => {
      const securityHeaders = new SecurityHeaders();
      const response = new Response("test");
      const secureResponse = securityHeaders.addSecurityHeaders(response);

      const header = secureResponse.headers.get("X-XSS-Protection");
      expect(header).toBe("1; mode=block");
    });

    it("should include Referrer-Policy", () => {
      const securityHeaders = new SecurityHeaders();
      const response = new Response("test");
      const secureResponse = securityHeaders.addSecurityHeaders(response);

      const header = secureResponse.headers.get("Referrer-Policy");
      expect(header).toBe("strict-origin-when-cross-origin");
    });
  });

  describe("Content Security Policy", () => {
    it("should include default CSP", () => {
      const securityHeaders = new SecurityHeaders();
      const response = new Response("test");
      const secureResponse = securityHeaders.addSecurityHeaders(response);

      const csp = secureResponse.headers.get("Content-Security-Policy");
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self' https://www.gstatic.com");
      expect(csp).toContain("style-src 'self' https://fonts.googleapis.com");
      expect(csp).toContain("img-src 'self' data: https:");
      expect(csp).toContain("font-src 'self' data: https://fonts.gstatic.com");
      expect(csp).toContain("frame-ancestors 'none'");
    });

    // Phase 8 hardening — the review flagged the CSP as otherwise sound but
    // missing these two directives.
    it("Phase 8: includes object-src 'none' (no legacy plugin embedding)", () => {
      const csp = new SecurityHeaders()
        .addSecurityHeaders(new Response("test"))
        .headers.get("Content-Security-Policy");
      expect(csp).toContain("object-src 'none'");
    });

    it("Phase 8: includes base-uri 'self' (an injected <base> cannot re-point relative URLs)", () => {
      const csp = new SecurityHeaders()
        .addSecurityHeaders(new Response("test"))
        .headers.get("Content-Security-Policy");
      expect(csp).toContain("base-uri 'self'");
    });

    it("Phase 8: both directives survive CSP_* env overrides", () => {
      const csp = new SecurityHeaders({
        CSP_SCRIPT_SRC: "'self' https://cdn.example.org",
        CSP_STYLE_SRC: "'self' 'unsafe-inline'",
        CSP_CONNECT_SRC: "https://api.example.org",
      })
        .addSecurityHeaders(new Response("test"))
        .headers.get("Content-Security-Policy");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
    });

    it("should include default connect-src domains", () => {
      const securityHeaders = new SecurityHeaders();
      const response = new Response("test");
      const secureResponse = securityHeaders.addSecurityHeaders(response);

      const csp = secureResponse.headers.get("Content-Security-Policy");
      expect(csp).toContain(
        "connect-src 'self' https://bsky.social https://api.rkm1.de https://www.gstatic.com",
      );
    });

    it("should add additional connect-src domains from environment", () => {
      const env: SecurityHeadersEnv = {
        CSP_CONNECT_SRC:
          "https://analytics.example.com https://api.example.com",
      };

      const securityHeaders = new SecurityHeaders(env);
      const response = new Response("test");
      const secureResponse = securityHeaders.addSecurityHeaders(response);

      const csp = secureResponse.headers.get("Content-Security-Policy");
      expect(csp).toContain(
        "connect-src 'self' https://bsky.social https://api.rkm1.de https://www.gstatic.com https://analytics.example.com https://api.example.com",
      );
    });

    it("should override script-src from environment", () => {
      const env: SecurityHeadersEnv = {
        CSP_SCRIPT_SRC: "'self' 'unsafe-inline' https://cdn.example.com",
      };

      const securityHeaders = new SecurityHeaders(env);
      const response = new Response("test");
      const secureResponse = securityHeaders.addSecurityHeaders(response);

      const csp = secureResponse.headers.get("Content-Security-Policy");
      expect(csp).toContain(
        "script-src 'self' 'unsafe-inline' https://cdn.example.com",
      );
    });

    it("should override style-src from environment", () => {
      const env: SecurityHeadersEnv = {
        CSP_STYLE_SRC: "'self' https://fonts.googleapis.com",
      };

      const securityHeaders = new SecurityHeaders(env);
      const response = new Response("test");
      const secureResponse = securityHeaders.addSecurityHeaders(response);

      const csp = secureResponse.headers.get("Content-Security-Policy");
      expect(csp).toContain("style-src 'self' https://fonts.googleapis.com");
    });

    it("should handle empty CSP_CONNECT_SRC", () => {
      const env: SecurityHeadersEnv = {
        CSP_CONNECT_SRC: "",
      };

      const securityHeaders = new SecurityHeaders(env);
      const response = new Response("test");
      const secureResponse = securityHeaders.addSecurityHeaders(response);

      const csp = secureResponse.headers.get("Content-Security-Policy");
      expect(csp).toContain(
        "connect-src 'self' https://bsky.social https://api.rkm1.de https://www.gstatic.com",
      );
    });

    it("should handle whitespace in CSP_CONNECT_SRC", () => {
      const env: SecurityHeadersEnv = {
        CSP_CONNECT_SRC: "  https://example.com   https://example.org  ",
      };

      const securityHeaders = new SecurityHeaders(env);
      const response = new Response("test");
      const secureResponse = securityHeaders.addSecurityHeaders(response);

      const csp = secureResponse.headers.get("Content-Security-Policy");
      expect(csp).toContain("https://example.com");
      expect(csp).toContain("https://example.org");
    });
  });

  describe("Response Preservation", () => {
    it("should preserve response body", async () => {
      const securityHeaders = new SecurityHeaders();
      const response = new Response("test body");
      const secureResponse = securityHeaders.addSecurityHeaders(response);

      const body = await secureResponse.text();
      expect(body).toBe("test body");
    });

    it("should preserve response status", () => {
      const securityHeaders = new SecurityHeaders();
      const response = new Response("test", {
        status: 404,
        statusText: "Not Found",
      });
      const secureResponse = securityHeaders.addSecurityHeaders(response);

      expect(secureResponse.status).toBe(404);
      expect(secureResponse.statusText).toBe("Not Found");
    });

    it("should preserve existing response headers", () => {
      const securityHeaders = new SecurityHeaders();
      const response = new Response("test", {
        headers: {
          "Content-Type": "application/json",
          "X-Custom-Header": "custom-value",
        },
      });
      const secureResponse = securityHeaders.addSecurityHeaders(response);

      expect(secureResponse.headers.get("Content-Type")).toBe(
        "application/json",
      );
      expect(secureResponse.headers.get("X-Custom-Header")).toBe(
        "custom-value",
      );
    });

    it("should override existing security headers", () => {
      const securityHeaders = new SecurityHeaders();
      const response = new Response("test", {
        headers: {
          "X-Frame-Options": "SAMEORIGIN", // Less restrictive
        },
      });
      const secureResponse = securityHeaders.addSecurityHeaders(response);

      // Should be overridden to more restrictive DENY
      expect(secureResponse.headers.get("X-Frame-Options")).toBe("DENY");
    });
  });

  describe("createSecureResponse", () => {
    it("should create response with security headers", () => {
      const securityHeaders = new SecurityHeaders();
      const response = securityHeaders.createSecureResponse("test body", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });

      expect(response.headers.get("Strict-Transport-Security")).toBeDefined();
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Content-Type")).toBe("text/plain");
    });

    it("should handle null body", () => {
      const securityHeaders = new SecurityHeaders();
      const response = securityHeaders.createSecureResponse(null, {
        status: 204,
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("Strict-Transport-Security")).toBeDefined();
    });
  });

  describe("Production Configuration", () => {
    it("should support typical production environment setup", () => {
      const env: SecurityHeadersEnv = {
        CSP_CONNECT_SRC: "https://analytics.example.com",
      };

      const securityHeaders = new SecurityHeaders(env);
      const response = new Response("test");
      const secureResponse = securityHeaders.addSecurityHeaders(response);

      // Verify all critical security headers are present
      expect(
        secureResponse.headers.get("Strict-Transport-Security"),
      ).toBeDefined();
      expect(secureResponse.headers.get("X-Content-Type-Options")).toBe(
        "nosniff",
      );
      expect(secureResponse.headers.get("X-Frame-Options")).toBe("DENY");
      expect(
        secureResponse.headers.get("Content-Security-Policy"),
      ).toBeDefined();

      // Verify CSP includes analytics domain
      const csp = secureResponse.headers.get("Content-Security-Policy");
      expect(csp).toContain("https://analytics.example.com");
    });
  });
});
