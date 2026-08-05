/**
 * Unit Tests: Keycloak JIT claims resolution + first-contact provisioning
 * (WS-0, plan 016).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";
import { Prisma, type PrismaClient } from "@prisma/client";

import { ClaimsCache, type CachedClaims } from "../../../src/lib/auth/claims-cache.js";
import type { TrellisClaims } from "../../../src/lib/auth/cognito-jwt.js";
import {
  resolveJitClaims,
  __setJitClaimsOverridesForTest,
} from "../../../src/lib/identity/jit-claims.js";
import type { DbClaimsLoad } from "../../../src/lib/identity/load-claims.js";
import type { ProvisioningResult } from "../../../src/lib/identity/provision-confirmed-user.js";

const SUB = "kc-user-uuid-1234";
const USER_CUID = "cusr1234567890abcdefghijk";
const TENANT_CUID = "ctnt1234567890abcdefghijk";

const mockEnv = { DATABASE_URL: "postgresql://test" } as any;

function tokenClaims(overrides: Partial<TrellisClaims> = {}): TrellisClaims {
  return { sub: SUB, username: "user@example.com", email: "user@example.com", ...overrides };
}

function provisioningResult(overrides: Partial<ProvisioningResult> = {}): ProvisioningResult {
  return {
    userId: USER_CUID,
    globalRole: "END_USER",
    handle: "user",
    personalTenantId: TENANT_CUID,
    personalTenantSlug: `personal-${USER_CUID}`,
    orgTenantId: null,
    orgTenantSlug: null,
    orgTenantRole: null,
    signupMethod: "MAGIC_LINK",
    invitationId: null,
    ...overrides,
  };
}

const NOT_FOUND: DbClaimsLoad = { user: null, activeMembership: null };

function foundUser(overrides: Partial<NonNullable<DbClaimsLoad["user"]>> = {}): DbClaimsLoad {
  return {
    user: {
      id: USER_CUID,
      role: "END_USER",
      handle: "user",
      suspended: false,
      suspendedAt: null,
      ...overrides,
    },
    activeMembership: {
      tenantId: TENANT_CUID,
      role: "OWNER",
      tenant: { slug: `personal-${USER_CUID}`, status: "ACTIVE" },
    },
  };
}

describe("resolveJitClaims", () => {
  let cache: ClaimsCache;
  let loadClaims: ReturnType<typeof vi.fn>;
  let provision: ReturnType<typeof vi.fn>;
  let getUser: ReturnType<typeof vi.fn>;
  const originalProvider = process.env.IDENTITY_PROVIDER;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.IDENTITY_PROVIDER = "keycloak";
    cache = new ClaimsCache(new MemoryKvStore());
    loadClaims = vi.fn().mockResolvedValue(NOT_FOUND);
    provision = vi.fn().mockResolvedValue(provisioningResult());
    getUser = vi.fn().mockResolvedValue(null);
    __setJitClaimsOverridesForTest({
      claimsCache: cache,
      db: {} as PrismaClient,
      identity: { getUser } as any,
      provision: provision as any,
      loadClaims: loadClaims as any,
    });
  });

  afterEach(() => {
    __setJitClaimsOverridesForTest(null);
    if (originalProvider === undefined) delete process.env.IDENTITY_PROVIDER;
    else process.env.IDENTITY_PROVIDER = originalProvider;
  });

  it("is a no-op (null) on non-Keycloak deployments — Cognito path byte-identical", async () => {
    process.env.IDENTITY_PROVIDER = "cognito";
    const result = await resolveJitClaims(tokenClaims(), mockEnv);
    expect(result).toBeNull();
    expect(loadClaims).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("returns cached claims without touching the DB", async () => {
    const cached: CachedClaims = {
      userId: USER_CUID,
      globalRole: "END_USER",
      activeTenantId: TENANT_CUID,
      tenantSlug: "personal",
      tenantRole: "OWNER",
      handle: "user",
    };
    await cache.put(SUB, cached);

    const result = await resolveJitClaims(tokenClaims(), mockEnv);

    expect(result).toEqual(cached);
    expect(loadClaims).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("derives claims from the DB for an existing user and primes the cache", async () => {
    loadClaims.mockResolvedValue(foundUser());

    const result = await resolveJitClaims(tokenClaims(), mockEnv);

    expect(result).toMatchObject({ userId: USER_CUID, activeTenantId: TENANT_CUID });
    expect(provision).not.toHaveBeenCalled();
    // Cache primed: a second resolution never hits the DB again.
    loadClaims.mockClear();
    const second = await resolveJitClaims(tokenClaims(), mockEnv);
    expect(second).toMatchObject({ userId: USER_CUID });
    expect(loadClaims).not.toHaveBeenCalled();
  });

  it("returns null (→401) for a suspended user and does not provision", async () => {
    loadClaims.mockResolvedValue(foundUser({ suspended: true }));

    const result = await resolveJitClaims(tokenClaims(), mockEnv);

    expect(result).toBeNull();
    expect(provision).not.toHaveBeenCalled();
  });

  it("treats suspendedAt as suspension even when the flag is false", async () => {
    loadClaims.mockResolvedValue(foundUser({ suspendedAt: new Date("2026-01-01") }));

    const result = await resolveJitClaims(tokenClaims(), mockEnv);

    expect(result).toBeNull();
    expect(provision).not.toHaveBeenCalled();
  });

  it("JIT-provisions on first contact and returns the resulting claims", async () => {
    const result = await resolveJitClaims(tokenClaims(), mockEnv);

    expect(provision).toHaveBeenCalledTimes(1);
    const [input] = provision.mock.calls[0]!;
    expect(input).toMatchObject({
      sub: SUB,
      email: "user@example.com",
      federated: false,
      signupMethodHint: "MAGIC_LINK",
    });
    expect(result).toEqual({
      userId: USER_CUID,
      globalRole: "END_USER",
      activeTenantId: TENANT_CUID,
      tenantSlug: `personal-${USER_CUID}`,
      tenantRole: "OWNER",
      handle: "user",
    });
  });

  it("re-provisions a half-provisioned user (row exists, no active membership)", async () => {
    loadClaims.mockResolvedValue({ ...foundUser(), activeMembership: null });

    const result = await resolveJitClaims(tokenClaims(), mockEnv);

    expect(provision).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ userId: USER_CUID, activeTenantId: TENANT_CUID });
  });

  it("maps multi-valued Keycloak attributes (first non-empty wins, custom: prefix first)", async () => {
    getUser.mockResolvedValue({
      id: SUB,
      email: "user@example.com",
      attributes: {
        "custom:dateOfBirth": ["", "2000-05-04"],
        dateOfBirth: ["1990-01-01"], // must lose to the custom:-prefixed key
        "custom:guardianEmail": ["guardian@example.com"],
        "custom:handle": ["hondo"],
        "custom:invitationCode": ["ABC123"],
      },
    });

    await resolveJitClaims(tokenClaims(), mockEnv);

    const [input] = provision.mock.calls[0]!;
    expect(input).toMatchObject({
      dateOfBirthRaw: "2000-05-04",
      guardianEmail: "guardian@example.com",
      providedHandle: "hondo",
      invitationCode: "ABC123",
    });
  });

  it("falls back to bare attribute names when no custom:-prefixed key exists", async () => {
    getUser.mockResolvedValue({
      id: SUB,
      email: "user@example.com",
      attributes: { dateOfBirth: ["1999-12-31"] },
    });

    await resolveJitClaims(tokenClaims(), mockEnv);

    const [input] = provision.mock.calls[0]!;
    expect(input).toMatchObject({ dateOfBirthRaw: "1999-12-31" });
  });

  it("uses the realm email when the token carries none", async () => {
    getUser.mockResolvedValue({ id: SUB, email: "realm@example.com" });

    await resolveJitClaims(tokenClaims({ email: undefined }), mockEnv);

    const [input] = provision.mock.calls[0]!;
    expect(input).toMatchObject({ email: "realm@example.com" });
  });

  it("returns null when neither token nor realm yields an email", async () => {
    getUser.mockResolvedValue(null);

    const result = await resolveJitClaims(tokenClaims({ email: undefined }), mockEnv);

    expect(result).toBeNull();
    expect(provision).not.toHaveBeenCalled();
  });

  it("survives a realm-attribute fetch failure with token-only input", async () => {
    getUser.mockRejectedValue(new Error("admin API down"));

    const result = await resolveJitClaims(tokenClaims(), mockEnv);

    expect(provision).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ userId: USER_CUID });
  });

  it("collapses concurrent first-requests into one provisioning (single-flight)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    provision.mockImplementation(async () => {
      await gate;
      return provisioningResult();
    });

    const [a, b] = [
      resolveJitClaims(tokenClaims(), mockEnv),
      resolveJitClaims(tokenClaims(), mockEnv),
    ];
    release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(provision).toHaveBeenCalledTimes(1);
    expect(ra).toEqual(rb);
  });

  it("retries once on a cross-instance unique-violation race (P2002)", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["email"] },
    });
    provision.mockRejectedValueOnce(p2002).mockResolvedValueOnce(provisioningResult());

    const result = await resolveJitClaims(tokenClaims(), mockEnv);

    expect(provision).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ userId: USER_CUID });
  });

  it("fails closed (null) on an unexpected provisioning error", async () => {
    provision.mockRejectedValue(new Error("db down"));

    const result = await resolveJitClaims(tokenClaims(), mockEnv);

    expect(result).toBeNull();
  });

  it("prefers the org tenant in the claims when provisioning resolved one", async () => {
    provision.mockResolvedValue(
      provisioningResult({
        orgTenantId: "corg1234567890abcdefghijk",
        orgTenantSlug: "acme",
        orgTenantRole: "MEMBER",
      }),
    );

    const result = await resolveJitClaims(tokenClaims(), mockEnv);

    expect(result).toMatchObject({
      activeTenantId: "corg1234567890abcdefghijk",
      tenantSlug: "acme",
      tenantRole: "MEMBER",
    });
  });
});
