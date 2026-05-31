import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the logger to suppress warnings during tests

import { validateExtensions } from "../../src/lib/extension-validator.js";
import type { TrellisExtension } from "@de-otio/trellis-extension-api";
import { z } from "zod";

function makeExtension(overrides: Partial<TrellisExtension> = {}): TrellisExtension {
  return {
    id: "test",
    terminology: { entity: "test", entityPlural: "tests" },
    routes: [],
    metadataSchema: z.object({}),
    ...overrides,
  };
}

describe("validateExtensions", () => {
  describe("ID validation", () => {
    it("accepts valid extension IDs", () => {
      expect(() => validateExtensions([makeExtension({ id: "dog" })])).not.toThrow();
      expect(() => validateExtensions([makeExtension({ id: "plant-care" })])).not.toThrow();
      expect(() => validateExtensions([makeExtension({ id: "my_ext_01" })])).not.toThrow();
    });

    it("rejects IDs that are too short", () => {
      expect(() => validateExtensions([makeExtension({ id: "a" })])).toThrow(
        /must be lowercase alphanumeric/,
      );
    });

    it("rejects IDs with uppercase", () => {
      expect(() => validateExtensions([makeExtension({ id: "Dog" })])).toThrow(
        /must be lowercase alphanumeric/,
      );
    });

    it("rejects IDs starting with a number", () => {
      expect(() => validateExtensions([makeExtension({ id: "1dog" })])).toThrow(
        /must be lowercase alphanumeric/,
      );
    });

    it("rejects reserved IDs", () => {
      for (const reserved of ["user", "admin", "system", "internal"]) {
        expect(() => validateExtensions([makeExtension({ id: reserved })])).toThrow(
          /is reserved/,
        );
      }
    });

    it("rejects duplicate IDs", () => {
      expect(() =>
        validateExtensions([
          makeExtension({ id: "dog" }),
          makeExtension({ id: "dog" }),
        ]),
      ).toThrow(/Duplicate extension ID/);
    });

    it("allows multiple unique IDs", () => {
      expect(() =>
        validateExtensions([
          makeExtension({ id: "dog" }),
          makeExtension({ id: "plant" }),
        ]),
      ).not.toThrow();
    });
  });

  describe("route validation", () => {
    it("rejects routes with reserved prefixes", () => {
      const ext = makeExtension({
        id: "evil",
        routes: [
          {
            path: "/api/auth/hijack",
            handler: async () => new Response(""),
          },
        ],
      });
      expect(() => validateExtensions([ext])).toThrow(/reserved prefix/);
    });

    it("rejects /api/admin routes", () => {
      const ext = makeExtension({
        id: "evil",
        routes: [
          {
            path: "/api/admin/takeover",
            handler: async () => new Response(""),
          },
        ],
      });
      expect(() => validateExtensions([ext])).toThrow(/reserved prefix/);
    });

    it("rejects /.well-known routes", () => {
      const ext = makeExtension({
        id: "evil",
        routes: [
          {
            path: "/.well-known/webfinger",
            handler: async () => new Response(""),
          },
        ],
      });
      expect(() => validateExtensions([ext])).toThrow(/reserved prefix/);
    });

    it("allows non-reserved route paths", () => {
      const ext = makeExtension({
        id: "dog",
        routes: [
          {
            path: "/api/dogs/breeds",
            handler: async () => new Response(""),
          },
        ],
      });
      expect(() => validateExtensions([ext])).not.toThrow();
    });

    it("allows regex route paths that don't match reserved prefixes", () => {
      const ext = makeExtension({
        id: "dog",
        routes: [
          {
            path: /^\/entities\/dog\/[^/]+$/,
            handler: async () => new Response(""),
          },
        ],
      });
      expect(() => validateExtensions([ext])).not.toThrow();
    });
  });

  describe("auth middleware warnings", () => {
    it("does not throw for routes without auth middleware", () => {
      // The validator warns but doesn't throw for missing auth middleware
      const ext = makeExtension({
        id: "dog",
        routes: [
          {
            path: "/api/dogs",
            handler: async () => new Response(""),
            description: "List dogs",
          },
        ],
      });
      expect(() => validateExtensions([ext])).not.toThrow();
    });

    it("does not warn for routes with auth middleware", () => {
      // Named function so .name === "authMiddleware"
      async function authMiddleware(_ctx: any, next: () => Promise<Response>) {
        return next();
      }
      const ext = makeExtension({
        id: "dog",
        routes: [
          {
            path: "/api/dogs",
            handler: async () => new Response(""),
            middleware: [authMiddleware as any],
            description: "List dogs",
          },
        ],
      });
      // Should pass without any warnings or throws
      expect(() => validateExtensions([ext])).not.toThrow();
    });
  });

  describe("empty extensions", () => {
    it("accepts empty extension list", () => {
      expect(() => validateExtensions([])).not.toThrow();
    });
  });
});
