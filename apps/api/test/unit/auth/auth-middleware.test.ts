/**
 * Unit Tests: Auth Middleware
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authMiddleware,
  extractVerifiedTenantId,
  requireActiveTenant,
  requireOwnTenant,
} from "../../../src/lib/auth/auth-middleware.js";
import type { AuthContext } from "../../../src/lib/auth/auth-context.js";

const USER_CUID = "cabc1234567890abcdefghijk";
const TENANT_CUID = "ctnt1234567890abcdefghijk";
const TENANT_CUID_2 = "ctnt2234567890abcdefghijk";

const { mockVerify } = vi.hoisted(() => ({ mockVerify: vi.fn() }));

vi.mock("../../../src/lib/auth/cognito-jwt", () => ({
  extractBearerToken: (header: string | null) => {
    if (!header?.startsWith("Bearer ")) return null;
    return header.slice(7);
  },
  verifyJwt: (...args: unknown[]) => mockVerify(...args),
}));

const { mockFindMany } = vi.hoisted(() => ({ mockFindMany: vi.fn() }));

vi.mock("../../../src/db", () => ({
  createPrisma: () => ({
    tenantMember: { findMany: mockFindMany },
  }),
}));

const mockEnv = { DATABASE_URL: "postgresql://test" } as any;

describe("authMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when Authorization header is missing", async () => {
    const request = new Request("https://api.example.com/api/tenants");
    const result = await authMiddleware(request, mockEnv);
    expect(result).toBeNull();
  });

  it("returns null when Authorization header is not Bearer", async () => {
    const request = new Request("https://api.example.com/api/tenants", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    const result = await authMiddleware(request, mockEnv);
    expect(result).toBeNull();
  });

  it("returns null when JWT verification throws", async () => {
    mockVerify.mockRejectedValue(new Error("Token expired"));
    const request = new Request("https://api.example.com/api/tenants", {
      headers: { Authorization: "Bearer bad-token" },
    });
    const result = await authMiddleware(request, mockEnv);
    expect(result).toBeNull();
  });

  it("returns null when userId claim is missing", async () => {
    mockVerify.mockResolvedValue({
      sub: "cognito-sub",
      activeTenantId: TENANT_CUID,
      // no custom:userId
    });
    const request = new Request("https://api.example.com/api/tenants", {
      headers: { Authorization: "Bearer valid-token" },
    });
    const result = await authMiddleware(request, mockEnv);
    expect(result).toBeNull();
  });

  it("returns null when activeTenantId claim is missing", async () => {
    mockVerify.mockResolvedValue({
      sub: "cognito-sub",
      userId: USER_CUID,
      // no custom:activeTenantId
    });
    const request = new Request("https://api.example.com/api/tenants", {
      headers: { Authorization: "Bearer valid-token" },
    });
    const result = await authMiddleware(request, mockEnv);
    expect(result).toBeNull();
  });

  it("returns null when userId is not a cuid", async () => {
    mockVerify.mockResolvedValue({
      sub: "cognito-sub",
      userId: "not-a-cuid",
      activeTenantId: TENANT_CUID,
    });
    const request = new Request("https://api.example.com/api/tenants", {
      headers: { Authorization: "Bearer valid-token" },
    });
    expect(await authMiddleware(request, mockEnv)).toBeNull();
  });

  it("returns null when activeTenantId is not a cuid", async () => {
    mockVerify.mockResolvedValue({
      sub: "cognito-sub",
      userId: USER_CUID,
      activeTenantId: "not-a-cuid",
    });
    const request = new Request("https://api.example.com/api/tenants", {
      headers: { Authorization: "Bearer valid-token" },
    });
    expect(await authMiddleware(request, mockEnv)).toBeNull();
  });

  it("builds AuthContext from T3 JWT claims", async () => {
    mockVerify.mockResolvedValue({
      sub: "cognito-sub-123",
      userId: USER_CUID,
      globalRole: "B2B_PARTNER",
      activeTenantId: TENANT_CUID,
      tenantSlug: "acme",
      tenantRole: "ADMIN",
      handle: "alice",
    });
    const request = new Request("https://api.example.com/api/tenants", {
      headers: { Authorization: "Bearer valid-token" },
    });
    const result = await authMiddleware(request, mockEnv);

    expect(result).not.toBeNull();
    expect(result!.sub).toBe("cognito-sub-123");
    expect(result!.userId).toBe(USER_CUID);
    expect(result!.globalRole).toBe("B2B_PARTNER");
    expect(result!.activeTenantId).toBe(TENANT_CUID);
    expect(result!.tenantSlug).toBe("acme");
    expect(result!.tenantRole).toBe("ADMIN");
    expect(result!.handle).toBe("alice");
  });

  it("falls back to legacy custom:role when custom:globalRole absent", async () => {
    mockVerify.mockResolvedValue({
      sub: "sub",
      userId: USER_CUID,
      globalRole: "END_USER",
      activeTenantId: TENANT_CUID,
    });
    const request = new Request("https://api.example.com/", {
      headers: { Authorization: "Bearer t" },
    });
    const result = await authMiddleware(request, mockEnv);
    expect(result?.globalRole).toBe("END_USER");
  });

  it("defaults tenantRole to GUEST (least privilege) when claim absent", async () => {
    mockVerify.mockResolvedValue({
      sub: "sub",
      userId: USER_CUID,
      activeTenantId: TENANT_CUID,
    });
    const request = new Request("https://api.example.com/", {
      headers: { Authorization: "Bearer t" },
    });
    const result = await authMiddleware(request, mockEnv);
    expect(result?.tenantRole).toBe("GUEST");
  });

  it("membershipsLoader fetches from DB (lazy)", async () => {
    mockVerify.mockResolvedValue({
      sub: "sub",
      userId: USER_CUID,
      activeTenantId: TENANT_CUID,
    });
    mockFindMany.mockResolvedValue([{ tenantId: TENANT_CUID, userId: USER_CUID, role: "OWNER", tenant: {} }]);

    const request = new Request("https://api.example.com/", {
      headers: { Authorization: "Bearer t" },
    });
    const result = await authMiddleware(request, mockEnv);

    // Not called yet — lazy
    expect(mockFindMany).not.toHaveBeenCalled();

    const memberships = await result!.membershipsLoader();
    expect(mockFindMany).toHaveBeenCalledOnce();
    expect(memberships).toHaveLength(1);

    // Second call uses cache
    await result!.membershipsLoader();
    expect(mockFindMany).toHaveBeenCalledOnce();
  });
});

describe("requireActiveTenant", () => {
  const makeAuth = (activeTenantId: string, globalRole = "B2B_PARTNER"): AuthContext => ({
    sub: "sub",
    userId: USER_CUID,
    globalRole: globalRole as any,
    activeTenantId,
    tenantSlug: "slug",
    tenantRole: "MEMBER",
    handle: "user",
    membershipsLoader: async () => [],
  });

  it("returns null when tenants match", () => {
    const result = requireActiveTenant(makeAuth(TENANT_CUID), TENANT_CUID);
    expect(result).toBeNull();
  });

  it("returns 403 when tenants differ", () => {
    const result = requireActiveTenant(makeAuth(TENANT_CUID), TENANT_CUID_2);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns null for SUPER_ADMIN regardless of active tenant", () => {
    const result = requireActiveTenant(makeAuth(TENANT_CUID, "SUPER_ADMIN"), TENANT_CUID_2);
    expect(result).toBeNull();
  });
});

describe("requireOwnTenant", () => {
  const makeAuth = (activeTenantId: string, globalRole = "B2B_PARTNER"): AuthContext => ({
    sub: "sub",
    userId: USER_CUID,
    globalRole: globalRole as any,
    activeTenantId,
    tenantSlug: "slug",
    tenantRole: "MEMBER",
    handle: "user",
    membershipsLoader: async () => [],
  });

  it("returns null when tenants match", () => {
    expect(requireOwnTenant(makeAuth(TENANT_CUID), TENANT_CUID)).toBeNull();
  });

  it("returns 404 (not 403) when tenants differ — no existence leak", async () => {
    const result = requireOwnTenant(makeAuth(TENANT_CUID), TENANT_CUID_2);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(404);
    const body = await result!.json() as { error: string };
    expect(body.error).toBe("NOT_FOUND");
  });

  it("returns null for SUPER_ADMIN", () => {
    expect(requireOwnTenant(makeAuth(TENANT_CUID, "SUPER_ADMIN"), TENANT_CUID_2)).toBeNull();
  });
});

describe("extractVerifiedTenantId (WS1 tenant-context source)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the verified active tenant id for a valid token", async () => {
    mockVerify.mockResolvedValue({
      sub: "cognito-sub",
      userId: USER_CUID,
      activeTenantId: TENANT_CUID,
    });
    const request = new Request("https://api.example.com/api/posts", {
      headers: { Authorization: "Bearer valid-token" },
    });
    expect(await extractVerifiedTenantId(request, mockEnv)).toBe(TENANT_CUID);
  });

  it("returns null when there is no Bearer token", async () => {
    const request = new Request("https://api.example.com/api/posts");
    expect(await extractVerifiedTenantId(request, mockEnv)).toBeNull();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("returns null when JWT verification throws", async () => {
    mockVerify.mockRejectedValue(new Error("expired"));
    const request = new Request("https://api.example.com/api/posts", {
      headers: { Authorization: "Bearer bad" },
    });
    expect(await extractVerifiedTenantId(request, mockEnv)).toBeNull();
  });

  it("returns null for a malformed activeTenantId claim", async () => {
    mockVerify.mockResolvedValue({
      sub: "cognito-sub",
      userId: USER_CUID,
      activeTenantId: "not-a-cuid",
    });
    const request = new Request("https://api.example.com/api/posts", {
      headers: { Authorization: "Bearer valid-token" },
    });
    expect(await extractVerifiedTenantId(request, mockEnv)).toBeNull();
  });
});
