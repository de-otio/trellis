/**
 * Unit Tests: Tenant Compliance Route
 *
 * GET /api/tenants/:id/compliance.json
 *
 * Cases:
 *  1. Tenant in EU returns dataResidency.activeRegion: "EU"
 *  2. Tenant with OIDC IdP includes subprocessors.identityProvider
 *  3. Tenant without IdP omits subprocessors.identityProvider
 *  4. Cross-tenant isolation: tenant A's auth requesting tenant B returns 403
 *  5. Unauthenticated request returns 401
 *  6. MEMBER (without audit.view capability) returns 403
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { tenantComplianceRoutes } from "../../../src/lib/routes/tenant-compliance.js";
import { buildTwoTenantFixture } from "../../_helpers/multi-tenant-fixture.js";
import type { Env } from "../../../src/env.js";
import type { AuthContext } from "../../../src/lib/auth/auth-context.js";
import type { TenantRole, UserRole } from "@prisma/client";
import type { TenantMember, Tenant } from "@prisma/client";

// ── DB mock ──────────────────────────────────────────────────────────────────
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    tenant: { findUnique: vi.fn() },
    tenantIdentityProvider: { findUnique: vi.fn() },
  },
}));

vi.mock("../../../src/db", () => ({
  createPrisma: () => mockDb,
}));

// ── Auth mock ────────────────────────────────────────────────────────────────
const { mockAuthMiddleware } = vi.hoisted(() => ({
  mockAuthMiddleware: vi.fn(),
}));

vi.mock("../../../src/lib/auth/auth-middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/auth/auth-middleware.js")>();
  return {
    ...actual,
    authMiddleware: (...args: unknown[]) => mockAuthMiddleware(...args),
  };
});

// ── SecurityHeaders mock ─────────────────────────────────────────────────────
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    addSecurityHeaders(response: Response) {
      return response;
    }
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────
const mockEnv = { DATABASE_URL: "postgresql://test" } as unknown as Env;

const route = tenantComplianceRoutes[0]!;

function makeRequest(tenantId: string): Request {
  return new Request(
    `https://api.example.com/api/tenants/${tenantId}/compliance.json`,
    { method: "GET" },
  );
}

function routeContext(tenantId: string) {
  return {
    pathname: `/api/tenants/${tenantId}/compliance.json`,
    url: new URL(`https://api.example.com/api/tenants/${tenantId}/compliance.json`),
    params: { id: tenantId },
  };
}

function makeAuthWithRole(
  tenantId: string,
  tenantRole: TenantRole,
  globalRole: UserRole = "B2B_PARTNER",
): AuthContext {
  return {
    cognitoSub: "cognito-sub-test",
    userId: "user-test-id",
    globalRole,
    activeTenantId: tenantId,
    tenantSlug: "test-tenant",
    tenantRole,
    handle: "testuser",
    membershipsLoader: async () => [] as (TenantMember & { tenant: Tenant })[],
  };
}

describe("GET /api/tenants/:id/compliance.json", () => {
  const { authA, authB, tenantA, tenantB } = buildTwoTenantFixture();

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: auth returns tenant A admin
    mockAuthMiddleware.mockResolvedValue(authA);
    // Default: tenant exists with region "EU" (LOW-5: column added,
    // existing rows default to "EU" so the public assertion still holds).
    mockDb.tenant.findUnique.mockResolvedValue({ id: tenantA.id, region: "EU" });
    // Default: no IdP
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue(null);
  });

  // ── Case 5: unauthenticated ──────────────────────────────────────────────
  describe("401 — unauthenticated", () => {
    it("returns 401 when authMiddleware returns null", async () => {
      mockAuthMiddleware.mockResolvedValue(null);
      const response = await route.handler(
        makeRequest(tenantA.id),
        mockEnv,
        routeContext(tenantA.id),
      );
      expect(response.status).toBe(401);
      const body = await response.json() as { error: string };
      expect(body.error).toBe("UNAUTHORIZED");
    });
  });

  // ── Case 4: cross-tenant isolation ──────────────────────────────────────
  describe("403 — cross-tenant isolation", () => {
    it("returns 403 when caller's activeTenantId differs from path tenantId", async () => {
      // authA is active on tenantA; request is for tenantB
      mockAuthMiddleware.mockResolvedValue(authA);
      const response = await route.handler(
        makeRequest(tenantB.id),
        mockEnv,
        routeContext(tenantB.id),
      );
      expect(response.status).toBe(403);
      const body = await response.json() as { error: string };
      expect(body.error).toBe("FORBIDDEN");
    });

    it("returns 403 when authB requests tenantA compliance", async () => {
      mockAuthMiddleware.mockResolvedValue(authB);
      const response = await route.handler(
        makeRequest(tenantA.id),
        mockEnv,
        routeContext(tenantA.id),
      );
      expect(response.status).toBe(403);
    });
  });

  // ── Case 6: capability gate ──────────────────────────────────────────────
  describe("403 — insufficient capability", () => {
    it("returns 403 when caller is MEMBER (lacks audit.view)", async () => {
      const memberAuth = makeAuthWithRole(tenantA.id, "MEMBER");
      mockAuthMiddleware.mockResolvedValue(memberAuth);
      const response = await route.handler(
        makeRequest(tenantA.id),
        mockEnv,
        routeContext(tenantA.id),
      );
      expect(response.status).toBe(403);
      const body = await response.json() as { error: string };
      expect(body.error).toBe("FORBIDDEN");
    });

    it("returns 403 when caller is GUEST (lacks audit.view)", async () => {
      const guestAuth = makeAuthWithRole(tenantA.id, "GUEST");
      mockAuthMiddleware.mockResolvedValue(guestAuth);
      const response = await route.handler(
        makeRequest(tenantA.id),
        mockEnv,
        routeContext(tenantA.id),
      );
      expect(response.status).toBe(403);
    });
  });

  // ── Case 1: EU region ────────────────────────────────────────────────────
  describe("200 — tenant in EU", () => {
    it("returns dataResidency.activeRegion: EU", async () => {
      const response = await route.handler(
        makeRequest(tenantA.id),
        mockEnv,
        routeContext(tenantA.id),
      );
      expect(response.status).toBe(200);
      const body = await response.json() as { dataResidency: { activeRegion: string } };
      expect(body.dataResidency.activeRegion).toBe("EU");
    });

    it("returns 200 with application/json content-type", async () => {
      const response = await route.handler(
        makeRequest(tenantA.id),
        mockEnv,
        routeContext(tenantA.id),
      );
      expect(response.headers.get("content-type")).toContain("application/json");
    });

    it("LOW-5: reflects a non-default region read from the tenant row", async () => {
      mockDb.tenant.findUnique.mockResolvedValue({ id: tenantA.id, region: "US" });
      const response = await route.handler(
        makeRequest(tenantA.id),
        mockEnv,
        routeContext(tenantA.id),
      );
      const body = await response.json() as { dataResidency: { activeRegion: string } };
      expect(body.dataResidency.activeRegion).toBe("US");
    });

    it("includes version and publishedAt from baseline", async () => {
      const response = await route.handler(
        makeRequest(tenantA.id),
        mockEnv,
        routeContext(tenantA.id),
      );
      const body = await response.json() as { version: string; publishedAt: string };
      expect(body.version).toBe("1.0.0");
      expect(body.publishedAt).toBeDefined();
    });

    it("includes GDPR framework from baseline", async () => {
      const response = await route.handler(
        makeRequest(tenantA.id),
        mockEnv,
        routeContext(tenantA.id),
      );
      const body = await response.json() as { regulatoryFrameworks: Array<{ name: string }> };
      const gdpr = body.regulatoryFrameworks.find((f) => f.name === "GDPR");
      expect(gdpr).toBeDefined();
    });
  });

  // ── Case 2: tenant with OIDC IdP ─────────────────────────────────────────
  describe("200 — tenant with OIDC IdP", () => {
    beforeEach(() => {
      mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({
        kind: "OIDC",
        issuerUrl: "https://login.microsoftonline.com/tenant-xyz/v2.0",
      });
    });

    it("includes subprocessors.identityProvider with issuerUrl", async () => {
      const response = await route.handler(
        makeRequest(tenantA.id),
        mockEnv,
        routeContext(tenantA.id),
      );
      const body = await response.json() as {
        subprocessors: { identityProvider?: { issuerUrl: string; kind: string } };
      };
      expect(body.subprocessors.identityProvider).toBeDefined();
      expect(body.subprocessors.identityProvider!.issuerUrl).toBe(
        "https://login.microsoftonline.com/tenant-xyz/v2.0",
      );
      expect(body.subprocessors.identityProvider!.kind).toBe("OIDC");
    });

    it("includes IdP in dataMinimization.tenantSpecific.activeIntegrations", async () => {
      const response = await route.handler(
        makeRequest(tenantA.id),
        mockEnv,
        routeContext(tenantA.id),
      );
      const body = await response.json() as {
        dataMinimization?: { tenantSpecific?: { activeIntegrations: Array<{ type: string }> } };
      };
      expect(body.dataMinimization?.tenantSpecific?.activeIntegrations).toHaveLength(1);
      expect(body.dataMinimization?.tenantSpecific?.activeIntegrations[0]?.type).toBe("OIDC");
    });
  });

  // ── Case 3: tenant without IdP ───────────────────────────────────────────
  describe("200 — tenant without IdP", () => {
    it("omits subprocessors.identityProvider", async () => {
      // mockDb.tenantIdentityProvider.findUnique already returns null by default
      const response = await route.handler(
        makeRequest(tenantA.id),
        mockEnv,
        routeContext(tenantA.id),
      );
      const body = await response.json() as {
        subprocessors: { identityProvider?: unknown };
      };
      expect(body.subprocessors.identityProvider).toBeUndefined();
    });

    it("returns empty activeIntegrations", async () => {
      const response = await route.handler(
        makeRequest(tenantA.id),
        mockEnv,
        routeContext(tenantA.id),
      );
      const body = await response.json() as {
        dataMinimization?: { tenantSpecific?: { activeIntegrations: unknown[] } };
      };
      expect(body.dataMinimization?.tenantSpecific?.activeIntegrations).toHaveLength(0);
    });
  });

  // ── SUPER_ADMIN bypass ────────────────────────────────────────────────────
  describe("SUPER_ADMIN cross-tenant access", () => {
    it("allows SUPER_ADMIN to read any tenant's compliance", async () => {
      const superAdminAuth = makeAuthWithRole(tenantA.id, "OWNER", "SUPER_ADMIN");
      mockAuthMiddleware.mockResolvedValue(superAdminAuth);
      mockDb.tenant.findUnique.mockResolvedValue({ id: tenantB.id });

      const response = await route.handler(
        makeRequest(tenantB.id),
        mockEnv,
        routeContext(tenantB.id),
      );
      expect(response.status).toBe(200);
    });
  });

  // ── 404 — tenant not found ────────────────────────────────────────────────
  describe("404 — tenant not found", () => {
    it("returns 404 when tenant row does not exist", async () => {
      mockDb.tenant.findUnique.mockResolvedValue(null);
      const response = await route.handler(
        makeRequest(tenantA.id),
        mockEnv,
        routeContext(tenantA.id),
      );
      expect(response.status).toBe(404);
      const body = await response.json() as { error: string };
      expect(body.error).toBe("NOT_FOUND");
    });
  });

  // ── ADMIN role gets access ────────────────────────────────────────────────
  describe("200 — ADMIN role", () => {
    it("returns 200 for ADMIN role (has audit.view)", async () => {
      const adminAuth = makeAuthWithRole(tenantA.id, "ADMIN");
      mockAuthMiddleware.mockResolvedValue(adminAuth);
      const response = await route.handler(
        makeRequest(tenantA.id),
        mockEnv,
        routeContext(tenantA.id),
      );
      expect(response.status).toBe(200);
    });
  });
});
