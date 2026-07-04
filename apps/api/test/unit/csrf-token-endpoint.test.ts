/**
 * Unit Tests: CSRF Token Endpoint
 *
 * Tests for the CSRF token generation API endpoint route definition.
 */

import { describe, it, expect } from "vitest";
import { routes } from "../../src/lib/routes/index.js";

describe("CSRF Token Endpoint", () => {
  it("should have CSRF token endpoint route", () => {
    const csrfRoute = routes.find((r) => r.path === "/api/csrf-token");
    expect(csrfRoute).toBeDefined();
    expect(csrfRoute?.method).toBe("GET");
    expect(csrfRoute?.description).toContain("CSRF token");
  });

  it("should have CORS middleware", () => {
    const csrfRoute = routes.find((r) => r.path === "/api/csrf-token");
    expect(csrfRoute?.middleware).toBeDefined();
    expect(csrfRoute?.middleware?.length).toBeGreaterThan(0);
  });

  it("should have handler function", () => {
    const csrfRoute = routes.find((r) => r.path === "/api/csrf-token");
    expect(csrfRoute?.handler).toBeDefined();
    expect(typeof csrfRoute?.handler).toBe("function");
  });
});
