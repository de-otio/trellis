/**
 * Unit Tests: OpenAPI Generator
 *
 * Coverage floor: 80% lines.
 * Tests: round-trip, path normalisation, minimal schema validity,
 *        content-type assertions for discovery routes.
 */

import { describe, expect, it } from "vitest";
import {
  generateOpenApiDoc,
  routePatternToPath,
  type OpenApiDocument,
} from "../../../src/lib/openapi/generator.js";
import type { Route } from "../../../src/lib/routes/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRoute(overrides: Partial<Route> & { path: Route["path"] }): Route {
  return {
    method: "GET",
    handler: async () => new Response("ok"),
    description: "test route",
    // G4 MEDIUM-3: existing tests pre-date the publicSpec opt-in; flag
    // routes by default in the helper so behavioural assertions remain
    // meaningful. The dedicated `excludes routes without publicSpec`
    // test below exercises the opposite path.
    publicSpec: true,
    ...overrides,
  };
}

// ── routePatternToPath ────────────────────────────────────────────────────────

describe("routePatternToPath", () => {
  it("returns exact string path unchanged", () => {
    expect(routePatternToPath("/health")).toBe("/health");
  });

  it("converts express :param to {param}", () => {
    expect(routePatternToPath("/api/tenants/:id")).toBe("/api/tenants/{id}");
  });

  it("converts multiple express params", () => {
    expect(routePatternToPath("/api/tenants/:tenantId/domains/:domainId")).toBe(
      "/api/tenants/{tenantId}/domains/{domainId}",
    );
  });

  it("returns null for wildcard string", () => {
    expect(routePatternToPath("*")).toBeNull();
  });

  it("converts simple regex with capture group", () => {
    const re = /^\/api\/tenants\/([^/]+)\/domains$/;
    const result = routePatternToPath(re);
    expect(result).toBe("/api/tenants/{param0}/domains");
  });

  it("converts regex with multiple capture groups", () => {
    const re = /^\/api\/tenants\/([^/]+)\/domains\/([^/]+)$/;
    const result = routePatternToPath(re);
    expect(result).toBe("/api/tenants/{param0}/domains/{param1}");
  });

  it("returns null for complex regex with unresolvable metacharacters outside capture groups", () => {
    // Unescaped dot and plus OUTSIDE any capture group — cannot be safely converted
    const re = /^\/api\/v\d+\/users$/;
    const result = routePatternToPath(re);
    expect(result).toBeNull();
  });

  it("handles regex without anchors", () => {
    const re = /\/health/;
    const result = routePatternToPath(re);
    // Should return the path portion without anchors
    expect(result).toBe("/health");
  });
});

// ── generateOpenApiDoc ────────────────────────────────────────────────────────

describe("generateOpenApiDoc", () => {
  it("returns a document with required top-level keys", () => {
    const doc = generateOpenApiDoc([]);
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toBeDefined();
    expect(doc.info.title).toBeTruthy();
    expect(doc.info.version).toBeTruthy();
    expect(doc.paths).toBeDefined();
  });

  it("includes a route as a path entry", () => {
    const routes: Route[] = [makeRoute({ path: "/health", method: "GET" })];
    const doc = generateOpenApiDoc(routes);
    expect(doc.paths["/health"]).toBeDefined();
    expect(doc.paths["/health"].get).toBeDefined();
  });

  it("each operation has a responses object", () => {
    const routes: Route[] = [makeRoute({ path: "/health", method: "GET" })];
    const doc = generateOpenApiDoc(routes);
    const op = doc.paths["/health"].get;
    expect(op.responses).toBeDefined();
    expect(Object.keys(op.responses).length).toBeGreaterThan(0);
  });

  it("skips wildcard routes", () => {
    const routes: Route[] = [
      makeRoute({ path: "*", method: "*" }),
      makeRoute({ path: "/health", method: "GET" }),
    ];
    const doc = generateOpenApiDoc(routes);
    expect(doc.paths["*"]).toBeUndefined();
    expect(doc.paths["/health"]).toBeDefined();
  });

  it("skips wildcard method entries", () => {
    const routes: Route[] = [makeRoute({ path: "/test", method: "*" })];
    const doc = generateOpenApiDoc(routes);
    // Path may be present but no wildcard method key
    if (doc.paths["/test"]) {
      expect(doc.paths["/test"]["*"]).toBeUndefined();
    }
  });

  it("normalises express params in route path", () => {
    const routes: Route[] = [
      makeRoute({ path: "/api/tenants/:id", method: "GET" }),
    ];
    const doc = generateOpenApiDoc(routes);
    expect(doc.paths["/api/tenants/{id}"]).toBeDefined();
  });

  it("extracts path parameters into operation parameters", () => {
    const routes: Route[] = [
      makeRoute({ path: "/api/tenants/:tenantId/domains/:domainId", method: "GET" }),
    ];
    const doc = generateOpenApiDoc(routes);
    const op = doc.paths["/api/tenants/{tenantId}/domains/{domainId}"].get;
    expect(op.parameters).toBeDefined();
    expect(op.parameters!.length).toBe(2);
    expect(op.parameters!.map((p) => p.name)).toContain("tenantId");
    expect(op.parameters!.map((p) => p.name)).toContain("domainId");
    op.parameters!.forEach((p) => {
      expect(p.in).toBe("path");
      expect(p.required).toBe(true);
    });
  });

  it("adds requestBody for POST routes", () => {
    const routes: Route[] = [makeRoute({ path: "/api/tenants", method: "POST" })];
    const doc = generateOpenApiDoc(routes);
    const op = doc.paths["/api/tenants"].post;
    expect(op.requestBody).toBeDefined();
    expect(op.requestBody!.content["application/json"]).toBeDefined();
  });

  it("does not add requestBody for GET routes", () => {
    const routes: Route[] = [makeRoute({ path: "/health", method: "GET" })];
    const doc = generateOpenApiDoc(routes);
    expect(doc.paths["/health"].get.requestBody).toBeUndefined();
  });

  it("handles array of methods", () => {
    const routes: Route[] = [
      makeRoute({ path: "/api/resource", method: ["GET", "POST"] }),
    ];
    const doc = generateOpenApiDoc(routes);
    expect(doc.paths["/api/resource"].get).toBeDefined();
    expect(doc.paths["/api/resource"].post).toBeDefined();
  });

  it("uses route description as operation summary", () => {
    const routes: Route[] = [
      makeRoute({ path: "/health", method: "GET", description: "Health check endpoint" }),
    ];
    const doc = generateOpenApiDoc(routes);
    expect(doc.paths["/health"].get.summary).toBe("Health check endpoint");
  });

  it("assigns a federation tag to tenant routes", () => {
    const routes: Route[] = [
      makeRoute({ path: "/api/tenants", method: "POST" }),
    ];
    const doc = generateOpenApiDoc(routes);
    expect(doc.paths["/api/tenants"].post.tags).toContain("tenants");
  });

  it("assigns discovery tag to llms.txt", () => {
    const routes: Route[] = [
      makeRoute({ path: "/llms.txt", method: "GET" }),
    ];
    const doc = generateOpenApiDoc(routes);
    expect(doc.paths["/llms.txt"].get.tags).toContain("discovery");
  });

  it("round-trip: serialize → parse → structure is preserved", () => {
    const routes: Route[] = [
      makeRoute({ path: "/health", method: "GET", description: "Health" }),
      makeRoute({ path: "/api/tenants", method: "POST", description: "Create tenant" }),
      makeRoute({ path: "/api/tenants/:id", method: "GET", description: "Get tenant" }),
    ];
    const doc = generateOpenApiDoc(routes);
    const serialized = JSON.stringify(doc);
    const parsed: OpenApiDocument = JSON.parse(serialized);

    expect(parsed.openapi).toBe("3.1.0");
    expect(parsed.info.title).toBeTruthy();
    expect(parsed.paths["/health"]).toBeDefined();
    expect(parsed.paths["/api/tenants"]).toBeDefined();
    expect(parsed.paths["/api/tenants/{id}"]).toBeDefined();
    // Every path entry method has responses
    for (const [, pathItem] of Object.entries(parsed.paths)) {
      for (const [, op] of Object.entries(pathItem as Record<string, { responses: unknown }>)) {
        expect(op.responses).toBeDefined();
      }
    }
  });

  it("handles regex route for tenant domain pattern", () => {
    const routes: Route[] = [
      makeRoute({
        path: /^\/api\/tenants\/([^/]+)\/domains$/,
        method: "GET",
        description: "List tenant domains",
      }),
    ];
    const doc = generateOpenApiDoc(routes);
    expect(doc.paths["/api/tenants/{param0}/domains"]).toBeDefined();
  });

  it("skips routes with unresolvable regex patterns", () => {
    const routes: Route[] = [
      // \d+ outside capture group — unresolvable metacharacter
      makeRoute({ path: /^\/api\/v\d+\/resources$/, method: "GET" }),
      makeRoute({ path: "/health", method: "GET" }),
    ];
    const doc = generateOpenApiDoc(routes);
    // health is present; the complex regex is skipped
    expect(doc.paths["/health"]).toBeDefined();
    // No key other than /health
    const keys = Object.keys(doc.paths);
    expect(keys.length).toBe(1);
  });

  it("defaults to GET when method is omitted", () => {
    const routes: Route[] = [
      { path: "/health", handler: async () => new Response("ok"), publicSpec: true },
    ];
    const doc = generateOpenApiDoc(routes);
    expect(doc.paths["/health"].get).toBeDefined();
  });

  describe("MEDIUM-3: publicSpec opt-in", () => {
    it("excludes routes that do not set publicSpec=true", () => {
      const routes: Route[] = [
        // Without publicSpec — should NOT appear.
        {
          path: "/api/posts",
          method: "GET",
          handler: async () => new Response("ok"),
          description: "List posts",
        },
        // Explicit false — should NOT appear.
        {
          path: "/api/comments",
          method: "GET",
          handler: async () => new Response("ok"),
          publicSpec: false,
        },
      ];
      const doc = generateOpenApiDoc(routes);
      expect(doc.paths["/api/posts"]).toBeUndefined();
      expect(doc.paths["/api/comments"]).toBeUndefined();
    });

    it("includes routes that set publicSpec=true", () => {
      const routes: Route[] = [
        {
          path: "/api/tenants",
          method: "POST",
          handler: async () => new Response("ok"),
          publicSpec: true,
        },
      ];
      const doc = generateOpenApiDoc(routes);
      expect(doc.paths["/api/tenants"]).toBeDefined();
    });
  });
});
