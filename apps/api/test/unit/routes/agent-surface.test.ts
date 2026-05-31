/**
 * Unit Tests: Agent Surface Routes (T9b-a)
 *
 * Tests:
 *   - GET /llms.txt   — content-type, body anchors
 *   - GET /openapi.json — content-type, valid OpenAPI 3.1 structure
 *   - GET /security.txt — RFC 9116 compliance, Contact field, RFC 3339 Expires
 */

import { beforeEach, describe, expect, it } from "vitest";
import { agentSurfaceRoutes, buildAgentSurfaceRoutes } from "../../../src/lib/routes/agent-surface.js";
import type { Route } from "../../../src/lib/routes/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function findRoute(routes: Route[], path: string): Route {
  const r = routes.find((rt) => rt.path === path);
  if (!r) throw new Error(`Route not found: ${path}`);
  return r;
}

const mockEnv = {} as any;

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    url: new URL("https://api.example.com/"),
    pathname: "/",
    params: {},
    ...overrides,
  } as any;
}

// ── /llms.txt ─────────────────────────────────────────────────────────────────

describe("GET /llms.txt", () => {
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

  it("body contains compliance.json endpoint anchor", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).toContain("/.well-known/compliance.json");
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

  it("body describes the persona scenario", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    // The agent-friendly onboarding persona scenario
    expect(body).toContain("Persona scenario");
  });

  it("body contains error format documentation", async () => {
    const req = new Request("https://api.example.com/llms.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).toContain("Error format");
  });

  it("has CORS middleware configured", () => {
    expect(route.middleware).toBeDefined();
    expect(route.middleware!.length).toBeGreaterThan(0);
  });

  it("has a description", () => {
    expect(route.description).toBeTruthy();
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

describe("GET /security.txt", () => {
  const route = findRoute(agentSurfaceRoutes, "/security.txt");

  it("responds with 200", async () => {
    const req = new Request("https://api.example.com/security.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    expect(res.status).toBe(200);
  });

  it("content-type is text/plain", async () => {
    const req = new Request("https://api.example.com/security.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
  });

  it("body contains Contact field", async () => {
    const req = new Request("https://api.example.com/security.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).toContain("Contact: ");
  });

  it("Contact field has mailto: URI", async () => {
    const req = new Request("https://api.example.com/security.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    const contactLine = body.split("\n").find((l) => l.startsWith("Contact:"));
    expect(contactLine).toBeDefined();
    expect(contactLine).toContain("mailto:");
  });

  it("body contains Expires field", async () => {
    const req = new Request("https://api.example.com/security.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).toContain("Expires: ");
  });

  it("Expires value is a valid RFC 3339 datetime", async () => {
    const req = new Request("https://api.example.com/security.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    const expiresLine = body.split("\n").find((l) => l.startsWith("Expires:"));
    expect(expiresLine).toBeDefined();
    const value = expiresLine!.replace("Expires: ", "").trim();
    // ISO 8601 / RFC 3339: parseable by Date
    const parsed = new Date(value);
    expect(parsed.getTime()).not.toBeNaN();
    // Should be approximately 1 year in the future
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    const diff = parsed.getTime() - Date.now();
    expect(diff).toBeGreaterThan(oneYearMs - 60_000);
    expect(diff).toBeLessThan(oneYearMs + 60_000);
  });

  it("body contains Preferred-Languages field", async () => {
    const req = new Request("https://api.example.com/security.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).toContain("Preferred-Languages: ");
  });

  it("body contains Canonical field", async () => {
    const req = new Request("https://api.example.com/security.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).toContain("Canonical: ");
  });

  it("body contains Policy field", async () => {
    const req = new Request("https://api.example.com/security.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body).toContain("Policy: ");
  });

  it("lines use key: value format (RFC 9116)", async () => {
    const req = new Request("https://api.example.com/security.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    const lines = body.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      // Each non-empty line should be "Key: value"
      expect(line).toMatch(/^[A-Za-z-]+: .+/);
    }
  });

  it("body ends with a trailing newline", async () => {
    const req = new Request("https://api.example.com/security.txt");
    const res = await route.handler(req, mockEnv, makeCtx());
    const body = await res.text();
    expect(body.endsWith("\n")).toBe(true);
  });

  it("has CORS middleware configured", () => {
    expect(route.middleware).toBeDefined();
    expect(route.middleware!.length).toBeGreaterThan(0);
  });

  it("has a description", () => {
    expect(route.description).toBeTruthy();
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
