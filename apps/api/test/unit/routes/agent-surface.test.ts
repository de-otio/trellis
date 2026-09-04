/**
 * Unit Tests: Agent Surface Routes (T9b-a, plan 034 "agent words" lane)
 *
 * Tests:
 *   - GET /llms.txt     — default content-type/anchors, absence of retired
 *     false claims, and consumer-configured override served verbatim
 *   - GET /openapi.json — content-type, valid OpenAPI 3.1 structure
 *   - GET /security.txt — 404 with the standard error envelope when
 *     unconfigured, consumer-configured body served verbatim when set
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  agentSurfaceRoutes,
  buildAgentSurfaceRoutes,
  type AgentSurfaceContent,
} from "../../../src/lib/routes/agent-surface.js";
import type { Route } from "../../../src/lib/routes/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function findRoute(routes: Route[], path: string): Route {
  const r = routes.find((rt) => rt.path === path);
  if (!r) throw new Error(`Route not found: ${path}`);
  return r;
}

const mockEnv = {} as any;

function envWith(agentSurface: AgentSurfaceContent): any {
  return { agentSurface };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    url: new URL("https://api.example.com/"),
    pathname: "/",
    params: {},
    ...overrides,
  } as any;
}

// ── /llms.txt ─────────────────────────────────────────────────────────────────

describe("GET /llms.txt (default, unconfigured)", () => {
  const route = findRoute(agentSurfaceRoutes, "/llms.txt");

  it("responds with 200", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    expect(res.status).toBe(200);
  });

  it("content-type is text/plain", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
  });

  it("body contains setup-status endpoint anchor", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).toContain("/api/tenants/{id}/setup-status");
  });

  it("body contains openapi.json endpoint anchor", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).toContain("/openapi.json");
  });

  it("body contains the real (not /.well-known/) compliance.json endpoint anchor", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).toContain("/api/tenants/{id}/compliance.json");
  });

  it("body contains the device-authorization grant endpoints", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).toContain("/oauth2/device_authorization");
    expect(body).toContain("/oauth2/token");
  });

  it("body contains identity-provider endpoint anchor", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).toContain("/api/tenants/{id}/identity-provider");
  });

  it("body contains domains endpoint anchor", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).toContain("/api/tenants/{id}/domains");
  });

  it("body contains role-mappings endpoint anchor", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).toContain("/api/tenants/{id}/role-mappings");
  });

  it("body contains error format documentation", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).toContain("Error format");
  });

  it("body does not name any product other than Trellis", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).not.toContain("dog");
    expect(body).not.toContain("Persona scenario");
    expect(body).not.toContain("Microsoft Graph");
    expect(body).not.toContain("Entra");
  });

  it("does NOT claim /.well-known/compliance.json (retired false claim)", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).not.toContain("/.well-known/compliance.json");
  });

  it("does NOT claim a PKCE endpoint under an example.com auth host (retired false claim)", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).not.toContain("auth.example.com");
  });

  it("does NOT claim identity-provider/test-sign-in (retired: no such route exists)", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).not.toContain("test-sign-in");
  });

  it("does NOT claim refresh tokens are single-use and rotated (retired false claim)", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).not.toContain("Refresh tokens are single-use and rotated");
  });

  it("does NOT claim domain.*/idp.*/role_mapping.* scopes (retired false claim)", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).not.toContain("domain.*, idp.*, role_mapping.*");
    expect(body).not.toContain("domain.*");
    expect(body).not.toContain("idp.*");
    expect(body).not.toContain("role_mapping.*");
  });

  it("has CORS middleware configured", () => {
    expect(route.middleware).toBeDefined();
    expect(route.middleware!.length).toBeGreaterThan(0);
  });

  it("has a description", () => {
    expect(route.description).toBeTruthy();
  });
});

describe("GET /llms.txt (consumer-configured)", () => {
  const route = findRoute(agentSurfaceRoutes, "/llms.txt");

  it("serves the configured body verbatim instead of the default", async () => {
    const configured = "# Acme — Agent Setup Contract\n\nCustom content.\n";
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(
      req,
      envWith({ llmsTxt: configured }),
      makeCtx(),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe(configured);
  });

  it("keeps the text/plain content-type for configured content", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(
      req,
      envWith({ llmsTxt: "custom" }),
      makeCtx(),
    );
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
  });
});

// ── /openapi.json ─────────────────────────────────────────────────────────────

describe("GET /openapi.json", () => {
  it("responds with 200", async () => {
    const routes = buildAgentSurfaceRoutes(() => []);
    const route = findRoute(routes, "/openapi.json");
    const req = new Request("https://api.example.com/openapi.json");
    const res = await route.handler(req, mockEnv, makeCtx());
    expect(res.status).toBe(200);
  });

  it("content-type is application/json", async () => {
    const routes = buildAgentSurfaceRoutes(() => []);
    const route = findRoute(routes, "/openapi.json");
    const req = new Request("https://api.example.com/openapi.json");
    const res = await route.handler(req, mockEnv, makeCtx());
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("body is valid JSON", async () => {
    const routes = buildAgentSurfaceRoutes(() => []);
    const route = findRoute(routes, "/openapi.json");
    const req = new Request("https://api.example.com/openapi.json");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(() => JSON.parse(body)).not.toThrow();
  });

  it("document has openapi: 3.1.0", async () => {
    const routes = buildAgentSurfaceRoutes(() => []);
    const route = findRoute(routes, "/openapi.json");
    const req = new Request("https://api.example.com/openapi.json");
    const res = await route.handler(req, mockEnv, makeCtx());
    const doc = await res.json();
    expect(doc.openapi).toBe("3.1.0");
  });

  it("document has info object with title and version", async () => {
    const routes = buildAgentSurfaceRoutes(() => []);
    const route = findRoute(routes, "/openapi.json");
    const req = new Request("https://api.example.com/openapi.json");
    const res = await route.handler(req, mockEnv, makeCtx());
    const doc = await res.json();
    expect(doc.info).toBeDefined();
    expect(doc.info.title).toBeTruthy();
    expect(doc.info.version).toBeTruthy();
  });

  it("document has paths object", async () => {
    const routes = buildAgentSurfaceRoutes(() => []);
    const route = findRoute(routes, "/openapi.json");
    const req = new Request("https://api.example.com/openapi.json");
    const res = await route.handler(req, mockEnv, makeCtx());
    const doc = await res.json();
    expect(doc.paths).toBeDefined();
    expect(typeof doc.paths).toBe("object");
  });

  it("includes injected routes in paths", async () => {
    const injectedRoutes: Route[] = [
      {
        path: "/api/tenants",
        method: "GET",
        handler: async () => new Response("ok"),
        description: "List tenants",
        // G4 MEDIUM-3: only routes flagged publicSpec land in /openapi.json.
        publicSpec: true,
      },
    ];
    const routes = buildAgentSurfaceRoutes(() => injectedRoutes);
    const route = findRoute(routes, "/openapi.json");
    const req = new Request("https://api.example.com/openapi.json");
    const res = await route.handler(req, mockEnv, makeCtx());
    const doc = await res.json();
    expect(doc.paths["/api/tenants"]).toBeDefined();
    expect(doc.paths["/api/tenants"].get).toBeDefined();
  });

  it("each path operation has a responses field", async () => {
    const injectedRoutes: Route[] = [
      { path: "/health", method: "GET", handler: async () => new Response("ok"), publicSpec: true },
      { path: "/api/tenants", method: "POST", handler: async () => new Response("ok"), publicSpec: true },
    ];
    const routes = buildAgentSurfaceRoutes(() => injectedRoutes);
    const route = findRoute(routes, "/openapi.json");
    const req = new Request("https://api.example.com/openapi.json");
    const res = await route.handler(req, mockEnv, makeCtx());
    const doc = await res.json();
    for (const [, pathItem] of Object.entries(doc.paths)) {
      for (const [, op] of Object.entries(pathItem as Record<string, { responses: unknown }>)) {
        expect(op.responses).toBeDefined();
      }
    }
  });

  it("has CORS middleware configured", () => {
    const routes = buildAgentSurfaceRoutes(() => []);
    const route = findRoute(routes, "/openapi.json");
    expect(route.middleware).toBeDefined();
    expect(route.middleware!.length).toBeGreaterThan(0);
  });

  it("has a description", () => {
    const routes = buildAgentSurfaceRoutes(() => []);
    const route = findRoute(routes, "/openapi.json");
    expect(route.description).toBeTruthy();
  });
});

// ── /security.txt ─────────────────────────────────────────────────────────────

describe("GET /security.txt (unconfigured)", () => {
  const route = findRoute(agentSurfaceRoutes, "/security.txt");

  it("responds with 404 rather than a placeholder contact", async () => {
    const req = new Request("https://api.example.com/security.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    expect(res.status).toBe(404);
  });

  it("body is the standard structured error envelope", async () => {
    const req = new Request("https://api.example.com/security.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.error).toBe("NOT_FOUND");
    expect(body.message).toBeTruthy();
    expect(body.remediation).toBeTruthy();
  });

  it("remediation tells the operator to configure agentSurface.securityTxt", async () => {
    const req = new Request("https://api.example.com/security.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.json();
    expect(body.remediation).toContain("agentSurface.securityTxt");
  });

  it("does NOT serve the retired example.com placeholder contact", async () => {
    const req = new Request("https://api.example.com/security.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).not.toContain("security@example.com");
  });

  it("has CORS middleware configured", () => {
    expect(route.middleware).toBeDefined();
    expect(route.middleware!.length).toBeGreaterThan(0);
  });

  it("has a description", () => {
    expect(route.description).toBeTruthy();
  });
});

describe("GET /security.txt (consumer-configured)", () => {
  const route = findRoute(agentSurfaceRoutes, "/security.txt");

  const configured = [
    "Contact: mailto:security@acme.example",
    "Expires: 2027-01-01T00:00:00.000Z",
    "Preferred-Languages: en",
    "Canonical: https://api.acme.example/security.txt",
    "",
  ].join("\n");

  it("responds with 200 and the configured body verbatim", async () => {
    const req = new Request("https://api.example.com/security.txt");
    const res = await route.handler(
      req,
      envWith({ securityTxt: configured }),
      makeCtx(),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe(configured);
  });

  it("content-type is text/plain", async () => {
    const req = new Request("https://api.example.com/security.txt");
    const res = await route.handler(
      req,
      envWith({ securityTxt: configured }),
      makeCtx(),
    );
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
  });
});

// ── agentSurfaceRoutes export ─────────────────────────────────────────────────

describe("agentSurfaceRoutes export", () => {
  it("exports exactly 3 routes", () => {
    expect(agentSurfaceRoutes).toHaveLength(3);
  });

  it("all routes use GET method", () => {
    for (const route of agentSurfaceRoutes) {
      expect(route.method).toBe("GET");
    }
  });

  it("exports routes for all three endpoints", () => {
    const paths = agentSurfaceRoutes.map((r) => r.path);
    expect(paths).toContain("/llms.txt");
    expect(paths).toContain("/openapi.json");
    expect(paths).toContain("/security.txt");
  });
});
