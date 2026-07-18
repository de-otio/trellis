/**
 * Multi-Tenant Test Fixture
 *
 * Seeds two isolated tenants (A and B), each with one user and active
 * TenantMember rows. Used by cross-tenant isolation tests to verify that
 * auth-as-A cannot read or mutate tenant-B resources.
 *
 * Auth contexts are mock objects — not Cognito tokens. Unit tests that need
 * a real auth context construct one with this fixture.
 */

import type { AuthContext } from "../../src/lib/auth/auth-context.js";
import type { TenantRole, UserRole } from "@prisma/client";
import type { TenantMember, Tenant } from "@prisma/client";

export interface TenantFixtureUser {
  id: string;
  email: string;
  sub: string;
  personalTenantId: string;
}

export interface TenantFixture {
  tenantA: { id: string; slug: string; displayName: string };
  tenantB: { id: string; slug: string; displayName: string };
  userA: TenantFixtureUser;
  userB: TenantFixtureUser;
  authA: AuthContext;
  authB: AuthContext;
}

function makeAuth(
  user: TenantFixtureUser,
  tenantId: string,
  tenantSlug: string,
  tenantRole: TenantRole = "OWNER",
  globalRole: UserRole = "B2B_PARTNER",
): AuthContext {
  return {
    sub: user.sub,
    userId: user.id,
    globalRole,
    activeTenantId: tenantId,
    tenantSlug,
    tenantRole,
    handle: user.email.split("@")[0] ?? "user",
    membershipsLoader: async () => [] as (TenantMember & { tenant: Tenant })[],
  };
}

/**
 * Returns a deterministic two-tenant fixture without hitting a real DB.
 * Suitable for unit tests that mock Prisma.
 */
export function buildTwoTenantFixture(): TenantFixture {
  const tenantA = { id: "tenant-a-id", slug: "tenant-a", displayName: "Tenant A" };
  const tenantB = { id: "tenant-b-id", slug: "tenant-b", displayName: "Tenant B" };

  const userA: TenantFixtureUser = {
    id: "user-a-id",
    email: "alice@test.example.com",
    sub: "cognito-sub-a",
    personalTenantId: "personal-tenant-a",
  };
  const userB: TenantFixtureUser = {
    id: "user-b-id",
    email: "bob@test.example.com",
    sub: "cognito-sub-b",
    personalTenantId: "personal-tenant-b",
  };

  return {
    tenantA,
    tenantB,
    userA,
    userB,
    authA: makeAuth(userA, tenantA.id, tenantA.slug),
    authB: makeAuth(userB, tenantB.id, tenantB.slug),
  };
}
