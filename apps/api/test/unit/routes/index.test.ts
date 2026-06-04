/**
 * Unit Tests: Routes Index
 *
 * Tests the shape of the `routes` registry (consumed by the OpenAPI
 * generator). Request routing itself is exercised against the Hono app in
 * `test/unit/app.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { routes } from "../../../src/lib/routes/index.js";

describe("Routes Index", () => {
  describe("routes registry", () => {
    it("should export routes array", () => {
      expect(routes).toBeDefined();
      expect(Array.isArray(routes)).toBe(true);
      expect(routes.length).toBeGreaterThan(0);
    });

    it("should have all routes with required properties", () => {
      routes.forEach((route) => {
        expect(route).toBeDefined();
        expect(route.path).toBeDefined();
        expect(route.method).toBeDefined();
        expect(route.handler).toBeDefined();
        expect(typeof route.handler).toBe("function");
      });
    });

    it("should have middleware defined for routes that need it", () => {
      routes.forEach((route) => {
        if (route.middleware) {
          expect(Array.isArray(route.middleware)).toBe(true);
        }
      });
    });
  });
});
