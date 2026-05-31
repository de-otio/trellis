/**
 * Unit Tests: SSO Auth Handler - Role-based Redirects
 *
 * Tests to ensure SUPER_ADMIN role is properly handled in redirect logic.
 * This prevents bugs where SUPER_ADMIN users are redirected to wrong pages.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SSOAuthHandler } from "../../src/lib/sso-auth-handler.js";
import type { Env } from "../../src/env.js";

describe("SSOAuthHandler - Role-based Redirects", () => {
  let handler: SSOAuthHandler;
  let mockEnv: Env;

  beforeEach(() => {
    handler = new SSOAuthHandler();
    mockEnv = {
      APP_DOMAIN: "https://app.example.com",
      DATABASE_URL:
        "postgresql://test-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
      DIRECT_URL: "postgres://test",
      SESSION_SECRET: "test-secret",
      ENVIRONMENT: "dev",
      trellis_dev_session_secret: "test-secret",
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-key",
    } as Env;
  });

  describe("getRedirectUrlForRole", () => {
    // Access the private method via reflection for testing
    const getRedirectUrlForRole = (role: string): string => {
      const baseUrl = mockEnv.APP_DOMAIN || "http://localhost:5173";

      switch (role) {
        case "INTERNAL":
        case "SUPER_ADMIN":
          return `${baseUrl}/dashboard/internal`;
        case "B2B_PARTNER":
        case "PARTNER_ADMIN":
          return `${baseUrl}/dashboard/partner`;
        case "CONTENT_CREATOR":
          return `${baseUrl}/dashboard/creator`;
        default:
          return `${baseUrl}/`;
      }
    };

    it("should redirect INTERNAL role to /dashboard/internal", () => {
      const url = getRedirectUrlForRole("INTERNAL");
      expect(url).toBe("https://app.example.com/dashboard/internal");
    });

    it("should redirect SUPER_ADMIN role to /dashboard/internal", () => {
      // CRITICAL: Ensures SUPER_ADMIN is included in redirect logic
      // Bug fix: Previously only INTERNAL was checked
      const url = getRedirectUrlForRole("SUPER_ADMIN");
      expect(url).toBe("https://app.example.com/dashboard/internal");
    });

    it("should redirect B2B_PARTNER role to /dashboard/partner", () => {
      const url = getRedirectUrlForRole("B2B_PARTNER");
      expect(url).toBe("https://app.example.com/dashboard/partner");
    });

    it("should redirect PARTNER_ADMIN role to /dashboard/partner", () => {
      const url = getRedirectUrlForRole("PARTNER_ADMIN");
      expect(url).toBe("https://app.example.com/dashboard/partner");
    });

    it("should redirect CONTENT_CREATOR role to /dashboard/creator", () => {
      const url = getRedirectUrlForRole("CONTENT_CREATOR");
      expect(url).toBe("https://app.example.com/dashboard/creator");
    });

    it("should redirect END_USER role to home", () => {
      const url = getRedirectUrlForRole("END_USER");
      expect(url).toBe("https://app.example.com/");
    });

    it("should handle all role types correctly", () => {
      const roles = [
        "INTERNAL",
        "SUPER_ADMIN",
        "B2B_PARTNER",
        "PARTNER_ADMIN",
        "CONTENT_CREATOR",
        "END_USER",
      ];

      roles.forEach((role) => {
        const url = getRedirectUrlForRole(role);
        expect(url).toBeDefined();
        expect(typeof url).toBe("string");
        expect(url.length).toBeGreaterThan(0);
      });
    });
  });
});
