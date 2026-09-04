/**
 * Unit Tests: OpenAPI Generator
 *
 * Coverage floor: 80% lines.
 * Tests: round-trip, path normalisation, minimal schema validity,
 *        content-type assertions for discovery routes, and (plan 034 lane B)
 *        real Zod → JSON Schema emission, security schemes derived from
 *        `Route.scopes`, honest `operationId`/`info.version`/`tags`, and the
 *        named-path-parameter rule for public routes.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  generateOpenApiDoc,
  routePatternToPath,
  type OpenApiDocument,
} from "../../../src/lib/openapi/generator.js";
import type { Route } from "../../../src/lib/routes/types.js";
import { CORE_SCOPES } from "../../../src/lib/auth/scopes.js";
// The generator reads the LIVE extension registry for extension consent copy
// (plan 034, F-2). Registration is append-only and process-wide, so the one
// test below that registers does so last within its describe and uses an id no
// other test in this file names.
import { registerExtension, getExtensions } from "../../../src/extensions.js";

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
    // Plan 034 lane B (B.2): `scopes: []` = "authenticated, no particular
    // scope" — the default that keeps a route in the public document
    // without asserting any real scope requirement. The dedicated
    // `B.2: security schemes` tests below exercise `undefined` (omitted)
    // and a non-empty list separately.
    scopes: [],
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

  it("converts a named-capture regex to a named placeholder", () => {
    const re = /^\/api\/tenants\/(?<tenantId>[^/]+)$/;
    expect(routePatternToPath(re)).toBe("/api/tenants/{tenantId}");
  });

  it("converts multiple named-capture groups", () => {
    const re = /^\/api\/tenants\/(?<tenantId>[^/]+)\/domains\/(?<domainId>[^/]+)$/;
    expect(routePatternToPath(re)).toBe("/api/tenants/{tenantId}/domains/{domainId}");
  });

  it("mixes named and unnamed capture groups independently", () => {
    const re = /^\/api\/tenants\/(?<tenantId>[^/]+)\/domains\/([^/]+)$/;
    expect(routePatternToPath(re)).toBe("/api/tenants/{tenantId}/domains/{param0}");
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

  it("handles regex route with a named capture group for tenant domain pattern", () => {
    const routes: Route[] = [
      makeRoute({
        path: /^\/api\/tenants\/(?<tenantId>[^/]+)\/domains$/,
        method: "GET",
        description: "List tenant domains",
      }),
    ];
    const doc = generateOpenApiDoc(routes);
    expect(doc.paths["/api/tenants/{tenantId}/domains"]).toBeDefined();
  });

  it("handles an unnamed-capture regex route when the route is not in the public document", () => {
    const routes: Route[] = [
      makeRoute({
        path: /^\/api\/tenants\/([^/]+)\/domains$/,
        method: "GET",
        description: "List tenant domains",
        publicSpec: false,
      }),
    ];
    const doc = generateOpenApiDoc(routes);
    expect(doc.paths["/api/tenants/{param0}/domains"]).toBeUndefined();
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
      { path: "/health", handler: async () => new Response("ok"), publicSpec: true, scopes: [] },
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
          scopes: [],
        },
        // Explicit false — should NOT appear.
        {
          path: "/api/comments",
          method: "GET",
          handler: async () => new Response("ok"),
          publicSpec: false,
          scopes: [],
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
          scopes: [],
        },
      ];
      const doc = generateOpenApiDoc(routes);
      expect(doc.paths["/api/tenants"]).toBeDefined();
    });
  });

  // ── B.1: real JSON Schema request/response bodies ──────────────────────────

  describe("B.1: Zod → JSON Schema", () => {
    it("emits a $ref-ed request-body schema with typed properties", () => {
      const requestSchema = z.object({
        title: z.string().min(1).max(200),
        tags: z.array(z.string()).optional(),
      });
      const routes: Route[] = [
        makeRoute({
          path: "/api/posts",
          method: "POST",
          operationId: "createPost",
          requestSchema,
          scopes: ["posts:write"],
        }),
      ];
      const doc = generateOpenApiDoc(routes);
      const op = doc.paths["/api/posts"].post;

      expect(op.requestBody?.content["application/json"].schema).toEqual({
        $ref: "#/components/schemas/createPostRequest",
      });
      expect(doc.components?.schemas?.createPostRequest).toMatchObject({
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["title"],
      });
    });

    it("emits a $ref-ed response schema", () => {
      const responseSchema = z.object({ id: z.string(), title: z.string() });
      const routes: Route[] = [
        makeRoute({ path: "/api/widgets/:id", method: "GET", operationId: "getWidget", responseSchema }),
      ];
      const doc = generateOpenApiDoc(routes);
      const op = doc.paths["/api/widgets/{id}"].get;

      expect(op.responses["200"].content?.["application/json"].schema).toEqual({
        $ref: "#/components/schemas/getWidgetResponse",
      });
      expect(doc.components?.schemas?.getWidgetResponse).toMatchObject({
        type: "object",
        properties: { id: { type: "string" }, title: { type: "string" } },
        required: ["id", "title"],
      });
    });

    it("keeps emitting the empty {} schema for a route without requestSchema/responseSchema", () => {
      const routes: Route[] = [makeRoute({ path: "/api/health", method: "GET" })];
      const doc = generateOpenApiDoc(routes);
      expect(doc.paths["/api/health"].get.responses["200"].content).toBeUndefined();
      expect(Object.keys(doc.components?.schemas ?? {})).toHaveLength(0);
    });

    it("does not stamp a redundant $schema on each component schema", () => {
      const requestSchema = z.object({ name: z.string() });
      const routes: Route[] = [
        makeRoute({ path: "/api/things", method: "POST", operationId: "createThing", requestSchema }),
      ];
      const doc = generateOpenApiDoc(routes);
      expect(doc.components?.schemas?.createThingRequest).not.toHaveProperty("$schema");
      expect(doc.jsonSchemaDialect).toBe("https://json-schema.org/draft/2020-12/schema");
    });
  });

  // ── B.2: security schemes and per-operation security ────────────────────────

  describe("B.2: security schemes", () => {
    it("emits securitySchemes with an oauth2 entry and a bearer entry", () => {
      const doc = generateOpenApiDoc([]);
      const schemes = doc.components?.securitySchemes as Record<string, { type: string }>;
      expect(schemes.oauth2).toBeDefined();
      expect(schemes.oauth2.type).toBe("oauth2");
      expect(schemes.bearerAuth).toBeDefined();
      expect(schemes.bearerAuth.type).toBe("http");
    });

    it("contains every core scope entry verbatim — fails if the catalog and the spec diverge", () => {
      // Not `toEqual(CORE_SCOPES)` any more: the map is now the UNION of core's
      // catalog and whatever scopes the published operations reference (see the
      // extension-scope test below). Core's entries must still appear
      // unmodified — the generator imports the catalog, it never restates it.
      const doc = generateOpenApiDoc([]);
      const schemes = doc.components?.securitySchemes as {
        oauth2: { flows: { authorizationCode: { scopes: Record<string, string> } } };
      };
      expect(schemes.oauth2.flows.authorizationCode.scopes).toMatchObject(CORE_SCOPES);
      // With no route in the document there is nothing to union on, so the two
      // coincide exactly here.
      expect(schemes.oauth2.flows.authorizationCode.scopes).toEqual(CORE_SCOPES);
    });

    it("defines a published route's non-core scope in securitySchemes, not just in security", () => {
      // The F-2 defect, inverted. `buildSecurity` copies whatever the route
      // declared; before the fix `buildSecuritySchemes` emitted `CORE_SCOPES`
      // alone, so an extension route publishing `walks:read` produced a
      // document whose operation referenced a scope its own scheme never
      // defined — invalid per OpenAPI 3.1 §4.8.29.2.
      const doc = generateOpenApiDoc([
        makeRoute({ path: "/api/v1/ext/dog/walks", method: "GET", scopes: ["walks:read"] }),
      ]);
      const scopes = (
        doc.components?.securitySchemes as {
          oauth2: { flows: { authorizationCode: { scopes: Record<string, string> } } };
        }
      ).oauth2.flows.authorizationCode.scopes;

      expect(doc.paths["/api/v1/ext/dog/walks"].get.security).toEqual([
        { oauth2: ["walks:read"] },
      ]);
      expect(Object.keys(scopes)).toContain("walks:read");
      // No extension is registered in this unit context, so the description
      // falls back to the id verbatim rather than core inventing consent copy.
      expect(scopes["walks:read"]).toBe("walks:read");
      expect(scopes).toMatchObject(CORE_SCOPES);
    });

    it("takes the description from the registered extension's own consent copy", () => {
      // Where the words come from when the extension IS registered: its
      // `TrellisExtension.scopes` declaration, which lane 0 added for exactly
      // this and which nothing read before the F-2 fix.
      const before = getExtensions().length;
      registerExtension({
        id: "walkext",
        terminology: { entity: "walk", entityPlural: "walks" },
        routes: [],
        metadataSchema: z.object({}),
        scopes: [{ id: "walks:read", description: "See the walks you recorded" }],
      } as unknown as Parameters<typeof registerExtension>[0]);
      expect(getExtensions().length).toBe(before + 1);

      const doc = generateOpenApiDoc([
        makeRoute({ path: "/api/v1/ext/walkext/walks", method: "GET", scopes: ["walks:read"] }),
      ]);
      const scopes = (
        doc.components?.securitySchemes as {
          oauth2: { flows: { authorizationCode: { scopes: Record<string, string> } } };
        }
      ).oauth2.flows.authorizationCode.scopes;

      expect(scopes["walks:read"]).toBe("See the walks you recorded");
    });

    it("defines every scope any operation references — the OpenAPI validity property", () => {
      // Table-driven rather than example-driven: this is the invariant, and it
      // must hold for whatever set of operations the document happens to carry.
      const doc = generateOpenApiDoc([
        makeRoute({ path: "/api/v1/a", method: "GET", scopes: ["posts:read"] }),
        makeRoute({ path: "/api/v1/b", method: "GET", scopes: ["walks:read", "walks:write"] }),
        makeRoute({ path: "/api/v1/c", method: "GET", scopes: [] }),
      ]);
      const defined = new Set(
        Object.keys(
          (
            doc.components?.securitySchemes as {
              oauth2: { flows: { authorizationCode: { scopes: Record<string, string> } } };
            }
          ).oauth2.flows.authorizationCode.scopes,
        ),
      );

      const referenced: string[] = [];
      for (const [path_, item] of Object.entries(doc.paths)) {
        for (const [method, op] of Object.entries(item)) {
          for (const requirement of op.security ?? []) {
            for (const [scheme, list] of Object.entries(requirement)) {
              if (scheme !== "oauth2") continue;
              for (const scope of list) {
                referenced.push(scope);
                expect(defined, `${method.toUpperCase()} ${path_} references ${scope}`).toContain(
                  scope,
                );
              }
            }
          }
        }
      }
      expect(referenced.sort()).toEqual(["posts:read", "walks:read", "walks:write"]);
    });

    it("omits an operation from the document entirely when scopes is absent", () => {
      const routes: Route[] = [
        { path: "/api/secret", method: "GET", handler: async () => new Response("ok"), publicSpec: true },
      ];
      const doc = generateOpenApiDoc(routes);
      expect(doc.paths["/api/secret"]).toBeUndefined();
    });

    it("marks an empty scopes array as authenticated-no-scope via the bearer scheme", () => {
      const routes: Route[] = [makeRoute({ path: "/api/open", method: "GET", scopes: [] })];
      const doc = generateOpenApiDoc(routes);
      expect(doc.paths["/api/open"].get.security).toEqual([{ bearerAuth: [] }]);
    });

    it("derives per-operation security from a non-empty scopes list", () => {
      const routes: Route[] = [makeRoute({ path: "/api/posts", method: "GET", scopes: ["posts:read"] })];
      const doc = generateOpenApiDoc(routes);
      expect(doc.paths["/api/posts"].get.security).toEqual([{ oauth2: ["posts:read"] }]);
    });
  });

  // ── B.3: honest metadata ─────────────────────────────────────────────────────

  describe("B.3: honest metadata", () => {
    it("reads info.version from apps/api/package.json, not a literal", () => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const pkgPath = path.join(here, "..", "..", "..", "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
      const doc = generateOpenApiDoc([]);
      expect(doc.info.version).toBe(pkg.version);
    });

    it("uses the route's declared operationId when present", () => {
      const routes: Route[] = [makeRoute({ path: "/api/widgets", method: "GET", operationId: "listWidgets" })];
      const doc = generateOpenApiDoc(routes);
      expect(doc.paths["/api/widgets"].get.operationId).toBe("listWidgets");
    });

    it("falls back to a deterministic operationId derived from method + path", () => {
      const routes: Route[] = [makeRoute({ path: "/api/widgets", method: "GET" })];
      const doc = generateOpenApiDoc(routes);
      expect(doc.paths["/api/widgets"].get.operationId).toBe("get__api_widgets");
    });

    it("throws naming both routes when two operations resolve to the same operationId", () => {
      const routes: Route[] = [
        makeRoute({ path: "/api/a", method: "GET", operationId: "dup" }),
        makeRoute({ path: "/api/b", method: "GET", operationId: "dup" }),
      ];
      expect(() => generateOpenApiDoc(routes)).toThrow(/duplicate openapi operationid "dup"/i);
      try {
        generateOpenApiDoc(routes);
        expect.unreachable();
      } catch (err) {
        expect(String(err)).toContain("GET /api/a");
        expect(String(err)).toContain("GET /api/b");
      }
    });

    it("uses route.tags in place of the derived tag when present", () => {
      const routes: Route[] = [makeRoute({ path: "/api/widgets", method: "GET", tags: ["widgets"] })];
      const doc = generateOpenApiDoc(routes);
      expect(doc.paths["/api/widgets"].get.tags).toEqual(["widgets"]);
    });

    it("falls back to the derived tag when route.tags is absent", () => {
      const routes: Route[] = [makeRoute({ path: "/api/tenants", method: "POST" })];
      const doc = generateOpenApiDoc(routes);
      expect(doc.paths["/api/tenants"].post.tags).toEqual(["tenants"]);
    });

    it("carries route.stability through as the x-stability extension", () => {
      const routes: Route[] = [makeRoute({ path: "/api/beta-thing", method: "GET", stability: "beta" })];
      const doc = generateOpenApiDoc(routes);
      expect(doc.paths["/api/beta-thing"].get["x-stability"]).toBe("beta");
    });

    it("omits x-stability when stability is not declared", () => {
      const routes: Route[] = [makeRoute({ path: "/api/plain", method: "GET" })];
      const doc = generateOpenApiDoc(routes);
      expect(doc.paths["/api/plain"].get["x-stability"]).toBeUndefined();
    });

    it("carries a .meta({ example }) declared on a Zod schema through to the JSON Schema", () => {
      const requestSchema = z
        .object({ title: z.string() })
        .meta({ example: { title: "Hello world" } });
      const routes: Route[] = [
        makeRoute({ path: "/api/examples", method: "POST", operationId: "createExample", requestSchema }),
      ];
      const doc = generateOpenApiDoc(routes);
      expect(doc.components?.schemas?.createExampleRequest).toMatchObject({
        example: { title: "Hello world" },
      });
    });
  });

  // ── B.3: named path parameters required for public routes ──────────────────

  describe("B.3: named path parameters for public routes", () => {
    it("throws, naming the path, for a public route with an unnamed regex capture group", () => {
      const routes: Route[] = [
        makeRoute({ path: /^\/api\/widgets\/([^/]+)$/, method: "GET" }),
      ];
      expect(() => generateOpenApiDoc(routes)).toThrow(
        /public openapi route "\/api\/widgets\/\{param0\}".*unnamed regex capture group/is,
      );
    });

    it("accepts a public route using a named regex capture group", () => {
      const routes: Route[] = [
        makeRoute({ path: /^\/api\/widgets\/(?<id>[^/]+)$/, method: "GET" }),
      ];
      const doc = generateOpenApiDoc(routes);
      expect(doc.paths["/api/widgets/{id}"]).toBeDefined();
    });

    it("does not throw for a non-public route with positional params", () => {
      const routes: Route[] = [
        makeRoute({ path: /^\/api\/widgets\/([^/]+)$/, method: "GET", publicSpec: false }),
      ];
      expect(() => generateOpenApiDoc(routes)).not.toThrow();
    });

    it("does not throw for a publicSpec route with positional params when scopes is still undeclared", () => {
      // This is the state of every currently-shipped publicSpec route: no
      // route sets `scopes` yet (lane A/G's job), so the B.2 scopes filter
      // excludes it before the named-param check ever runs.
      const routes: Route[] = [
        {
          path: /^\/api\/widgets\/([^/]+)$/,
          method: "GET",
          handler: async () => new Response("ok"),
          publicSpec: true,
        },
      ];
      expect(() => generateOpenApiDoc(routes)).not.toThrow();
      const doc = generateOpenApiDoc(routes);
      expect(Object.keys(doc.paths)).toHaveLength(0);
    });
  });
});
