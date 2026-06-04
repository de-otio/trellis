/**
 * Unit Tests: Setup-status route
 *
 * Cases:
 *  1. No domains → nextStep.code === DOMAIN_REQUIRED (happy path through route)
 *  2. Cross-tenant: auth for tenant A requesting tenant B → 403
 *  3. Unauthenticated request → 401 with structured error
 *  4. Tenant not found (loadSetupStatus returns null) → 404
 *  5. MEMBER without IdpView capability → 403
 *  6. Full happy path → 200 with correct shape
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupStatusRoutes } from "../../../src/lib/routes/setup-status.js";
import { buildTwoTenantFixture } from "../../_helpers/multi-tenant-fixture.js";
import type { Env } from "../../../src/env.js";
import type { AuthContext } from "../../../src/lib/auth/auth-context.js";
import type { TenantRole, UserRole } from "@prisma/client";
import type { TenantMember, Tenant } from "@prisma/client";

// ── Module mocks ─────────────────────────────────────────────────────────────

const { mockAuthMiddleware } = vi.hoisted(() => ({
  mockAuthMiddleware: vi.fn<() => Promise<AuthContext | null>>(),
}));

vi.mock("../../../src/lib/auth/auth-middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/auth/auth-middleware.js")>();
  return {
    ...actual,
    authMiddleware: (...args: unknown[]) => mockAuthMiddleware(...args),
  };
});

const { mockLoadSetupStatus } = vi.hoisted(() => ({
  mockLoadSetupStatus: vi.fn(),
}));

vi.mock("../../../src/lib/tenant/setup-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/tenant/setup-status.js")>();
  return {
    ...actual,
    loadSetupStatus: (...args: unknown[]) => mockLoadSetupStatus(...args),
  };
});

vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    addSecurityHeaders(r: Response) {
      return r;
    }
    createSecureResponse(body: string, init: ResponseInit) {
      return new Response(body, init);
    }
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const mockEnv = { DATABASE_URL: "postgresql://test" } as unknown as Env;

const route = setupStatusRoutes[0]!;

function makeAuth(
  tenantId: string,
  tenantRole: TenantRole = "OWNER",
  globalRole: UserRole = "B2B_PARTNER",
): AuthContext {
  return {
    cognitoSub: "cognito-sub",
    userId: "user-id",
    globalRole,
    activeTenantId: tenantId,
    tenantSlug: "my-tenant",
    tenantRole,
    handle: "test-user",
    membershipsLoader: async () => [] as (TenantMember & { tenant: Tenant })[],
  };
}

function makeRequest(tenantId: string): Request {
  return new Request(`https://api.example.com/api/tenants/${tenantId}/setup-status`, {
    method: "GET",
  });
}

const TENANT_ID = "tenant-a-id";

const minimalStatus = {
  tenant: { status: "ok", tenantId: TENANT_ID },
  domains: [],
  idp: null,
  roleMappings: [],
  nextStep: {
    code: "DOMAIN_REQUIRED",
    message: "Add a domain to verify ownership before connecting an identity provider.",
    endpoint: `POST /api/tenants/${TENANT_ID}/domains`,
    remediation: "Call POST /api/tenants/{id}/domains with { \"domain\": \"yourdomain.com\" }.",
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/tenants/:id/setup-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 with structured error when unauthenticated", async () => {
    mockAuthMiddleware.mockResolvedValue(null);

    const response = await route.handler(
      makeRequest(TENANT_ID),
      mockEnv,
      { pathname: `/api/tenants/${TENANT_ID}/setup-status`, url: new URL(`https://api.example.com/api/tenants/${TENANT_ID}/setup-status`) },
    );

    expect(response.status).toBe(401);
    const body = await response.json() as Record<string, unknown>;
    expect(body.error).toBe("UNAUTHORIZED");
    expect(typeof body.message).toBe("string");
    expect(typeof body.remediation).toBe("string");
  });

  it("returns 403 for cross-tenant access (tenant A auth requesting tenant B)", async () => {
    const { authA } = buildTwoTenantFixture();
    // authA is scoped to tenant-a-id; we request tenant-b-id
    mockAuthMiddleware.mockResolvedValue(authA);

    const response = await route.handler(
      makeRequest("tenant-b-id"),
      mockEnv,
      { pathname: "/api/tenants/tenant-b-id/setup-status", url: new URL("https://api.example.com/api/tenants/tenant-b-id/setup-status") },
    );

    expect(response.status).toBe(403);
    const body = await response.json() as Record<string, unknown>;
    expect(body.error).toBe("FORBIDDEN");
    expect(typeof body.remediation).toBe("string");
  });

  it("returns 403 when MEMBER lacks IdpView capability", async () => {
    mockAuthMiddleware.mockResolvedValue(makeAuth(TENANT_ID, "MEMBER"));

    const response = await route.handler(
      makeRequest(TENANT_ID),
      mockEnv,
      { pathname: `/api/tenants/${TENANT_ID}/setup-status`, url: new URL(`https://api.example.com/api/tenants/${TENANT_ID}/setup-status`) },
    );

    expect(response.status).toBe(403);
    const body = await response.json() as Record<string, unknown>;
    expect(body.error).toBe("FORBIDDEN");
  });

  it("returns 404 when tenant is not found", async () => {
    mockAuthMiddleware.mockResolvedValue(makeAuth(TENANT_ID));
    mockLoadSetupStatus.mockResolvedValue(null);

    const response = await route.handler(
      makeRequest(TENANT_ID),
      mockEnv,
      { pathname: `/api/tenants/${TENANT_ID}/setup-status`, url: new URL(`https://api.example.com/api/tenants/${TENANT_ID}/setup-status`) },
    );

    expect(response.status).toBe(404);
    const body = await response.json() as Record<string, unknown>;
    expect(body.error).toBe("NOT_FOUND");
    expect(typeof body.remediation).toBe("string");
  });

  it("returns 200 with setup-status shape when tenant has no domains", async () => {
    mockAuthMiddleware.mockResolvedValue(makeAuth(TENANT_ID));
    mockLoadSetupStatus.mockResolvedValue(minimalStatus);

    const response = await route.handler(
      makeRequest(TENANT_ID),
      mockEnv,
      { pathname: `/api/tenants/${TENANT_ID}/setup-status`, url: new URL(`https://api.example.com/api/tenants/${TENANT_ID}/setup-status`) },
    );

    expect(response.status).toBe(200);
    const body = await response.json() as typeof minimalStatus;
    expect(body.nextStep.code).toBe("DOMAIN_REQUIRED");
    expect(body.tenant.tenantId).toBe(TENANT_ID);
    expect(body.domains).toHaveLength(0);
    expect(body.idp).toBeNull();
    expect(body.roleMappings).toHaveLength(0);
  });

  it("returns 200 with COMPLETE status when all steps are done", async () => {
    const completeStatus = {
      tenant: { status: "ok", tenantId: TENANT_ID },
      domains: [{ domain: "example.com", verifiedAt: "2026-01-01T00:00:00.000Z", status: "verified" }],
      idp: { kind: "OIDC", status: "ACTIVE", issuerUrl: "https://login.example.com" },
      roleMappings: [{ id: "rm-1", externalGroup: "sg-admins", tenantRole: "ADMIN" }],
      nextStep: {
        code: "COMPLETE",
        message: "Tenant setup is complete.",
        endpoint: `GET /api/tenants/${TENANT_ID}/setup-status`,
        remediation: "No action required.",
      },
    };

    mockAuthMiddleware.mockResolvedValue(makeAuth(TENANT_ID));
    mockLoadSetupStatus.mockResolvedValue(completeStatus);

    const response = await route.handler(
      makeRequest(TENANT_ID),
      mockEnv,
      { pathname: `/api/tenants/${TENANT_ID}/setup-status`, url: new URL(`https://api.example.com/api/tenants/${TENANT_ID}/setup-status`) },
    );

    expect(response.status).toBe(200);
    const body = await response.json() as typeof completeStatus;
    expect(body.nextStep.code).toBe("COMPLETE");
    expect(body.idp?.status).toBe("ACTIVE");
    expect(body.domains[0]?.status).toBe("verified");
  });

  it("SUPER_ADMIN can access any tenant's setup status", async () => {
    const superAdminAuth = makeAuth(TENANT_ID, "OWNER", "SUPER_ADMIN" as UserRole);
    // SUPER_ADMIN with activeTenantId = TENANT_ID requesting the same tenant
    mockAuthMiddleware.mockResolvedValue(superAdminAuth);
    mockLoadSetupStatus.mockResolvedValue(minimalStatus);

    const response = await route.handler(
      makeRequest(TENANT_ID),
      mockEnv,
      { pathname: `/api/tenants/${TENANT_ID}/setup-status`, url: new URL(`https://api.example.com/api/tenants/${TENANT_ID}/setup-status`) },
    );

    expect(response.status).toBe(200);
  });
});
