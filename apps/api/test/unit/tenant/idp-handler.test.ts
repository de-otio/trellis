/**
 * Unit tests: IdpHandler
 *
 * Coverage:
 *  1. AUTH-GATING — every public method returns the guard Response and does
 *     NO I/O when requireActiveTenant / requireCapability / requireOwnTenant
 *     denies the request.
 *  2. VALIDATION — invalid JSON, schema rejections, SAML stub, missing-confirm
 *     on DELETE, empty-body PATCH.
 *  3. HAPPY PATHS — handleCreate, handleGet, handlePatch (config + status),
 *     handleDelete: correct Prisma + mock SDK calls, audit emitted, secret NOT
 *     leaked in responses.
 *  4. ERROR MAPPING — secrets ResourceExistsException → 409, Cognito failure
 *     → 502, RDS commit failure → 502 (with rollback side-effects), 404 on
 *     missing IdP.
 *  5. SECURITY INVARIANTS — single-IdP-per-tenant (409 IDP_EXISTS), issuer
 *     probe failure → 422 ISSUER_UNREACHABLE, no verified domains → 422,
 *     tenant not found → 404, status already-same → 200 unchanged, DELETE
 *     without confirm=true → 400, clientSecretArn never in response.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "../../../src/lib/auth/auth-context.js";
import type { Env } from "../../../src/env.js";
import type { IdpKind, IdpStatus, TenantRole, UserRole } from "@prisma/client";

// ── Hoisted mock factories ─────────────────────────────────────────────────────

const {
  mockRequireActiveTenant,
  mockRequireCapability,
  mockRequireOwnTenant,
  mockAuditEmit,
  mockPrisma,
  mockIdpSdk,
  mockSecrets,
  mockProbeOidcIssuer,
  mockInvalidateClaimsForSubs,
} = vi.hoisted(() => {
  // The transaction mock: runs the callback synchronously against the same
  // mockPrisma object so the inner create/update/delete calls are observable.
  const txProxy: Record<string, unknown> = {};
  const mockPrisma: Record<string, unknown> = {
    tenant: { findUnique: vi.fn() },
    tenantDomain: { findMany: vi.fn() },
    tenantIdentityProvider: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    tenantMember: { findMany: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: typeof txProxy) => Promise<unknown>) => fn(txProxy)),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };

  // txProxy delegates every model back to the top-level mockPrisma models so
  // spy assertions work on one place only.
  Object.assign(txProxy, {
    tenantIdentityProvider: mockPrisma.tenantIdentityProvider,
    $executeRaw: mockPrisma.$executeRaw,
  });

  return {
    mockRequireActiveTenant: vi.fn<[], Response | null>(),
    mockRequireCapability: vi.fn<[], Response | null>(),
    mockRequireOwnTenant: vi.fn<[], Response | null>(),
    mockAuditEmit: vi.fn().mockResolvedValue(undefined),
    mockPrisma,
    mockIdpSdk: {
      createOidcProvider: vi.fn().mockResolvedValue(undefined),
      updateOidcProvider: vi.fn().mockResolvedValue(undefined),
      deleteProvider: vi.fn().mockResolvedValue(undefined),
      providerExists: vi.fn().mockResolvedValue(true),
      setProviderEnabled: vi.fn().mockResolvedValue(undefined),
      // The handler asks the ADAPTER for the default mapping now — the key set
      // is provider-shaped, so it cannot be a module-level constant here.
      defaultAttributeMapping: vi.fn(() => ({
        email: "email",
        given_name: "given_name",
        family_name: "family_name",
        "custom:idpGroups": "groups",
      })),
    },
    mockSecrets: {
      create: vi.fn(),
      rotate: vi.fn(),
      delete: vi.fn(),
    },
    mockProbeOidcIssuer: vi.fn(),
    mockInvalidateClaimsForSubs: vi.fn().mockResolvedValue(undefined),
  };
});

// ── Module mocks ───────────────────────────────────────────────────────────────

vi.mock("../../../src/db", () => ({
  createPrisma: () => mockPrisma,
}));

vi.mock("../../../src/lib/auth/auth-middleware", async (orig) => ({
  ...(await orig<typeof import("../../../src/lib/auth/auth-middleware.js")>()),
  requireActiveTenant: mockRequireActiveTenant,
  requireOwnTenant: mockRequireOwnTenant,
}));

vi.mock("../../../src/lib/auth/require", async (orig) => ({
  ...(await orig<typeof import("../../../src/lib/auth/require.js")>()),
  requireCapability: mockRequireCapability,
}));

// Mock the TenantAuditEmitter used at module level inside idp-handler.
vi.mock("../../../src/lib/audit-composer", async (orig) => ({
  ...(await orig<typeof import("../../../src/lib/audit-composer.js")>()),
  TenantAuditEmitter: class {
    emit = mockAuditEmit;
  },
}));

vi.mock("../../../src/lib/cognito/issuer-probe", () => ({
  probeOidcIssuer: mockProbeOidcIssuer,
}));

// claims-cache is used as fallback when invalidateClaimsForSubs is not
// injected; the dep-injection path overrides it so we just stub the module.
vi.mock("../../../src/lib/auth/claims-cache", () => ({
  createClaimsCacheFromEnv: () => ({ invalidate: vi.fn().mockResolvedValue(undefined) }),
}));

// ── Import after mocks ─────────────────────────────────────────────────────────

import { IdpHandler } from "../../../src/lib/tenant/idp-handler.js";

// ── Test helpers ───────────────────────────────────────────────────────────────

const TENANT_ID = "ctest0001tenant001234567890";
const IDP_ID    = "ctest0001idp0000001234567890";

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    cognitoSub: "cognito-sub-test",
    userId: "ctest0001user001234567890123",
    globalRole: "END_USER" as UserRole,
    activeTenantId: TENANT_ID,
    tenantSlug: "acme-corp",
    tenantRole: "ADMIN" as TenantRole,
    handle: "testadmin",
    membershipsLoader: async () => [],
    ...overrides,
  };
}

const mockEnv = {
  COGNITO_USER_POOL_ID: "us-east-1_TestPool",
  COGNITO_APP_CLIENT_ID: "test-client-id",
  COGNITO_REGION: "us-east-1",
} as unknown as Env;

/** A minimal IdP row as returned by Prisma selects. */
const SAMPLE_IDP_ROW = {
  id: IDP_ID,
  tenantId: TENANT_ID,
  kind: "OIDC" as IdpKind,
  status: "ACTIVE" as IdpStatus,
  cognitoIdpName: `tenant-${TENANT_ID.slice(0, 25)}`,
  issuerUrl: "https://idp.example.org",
  clientId: "client-abc-123",
  clientSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:tenant/test/idp",
  defaultRole: null as TenantRole | null,
  attributeMapping: { email: "email", given_name: "given_name", family_name: "family_name", "custom:idpGroups": "groups" },
  scopes: "openid email profile groups",
  enabledAt: new Date("2025-01-01T00:00:00Z"),
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
};

/** The subset that formatIdpRecord returns (no clientSecretArn). */
const SAMPLE_IDP_FORMATTED = {
  id: IDP_ID,
  tenantId: TENANT_ID,
  kind: "OIDC",
  status: "ACTIVE",
  cognitoIdpName: SAMPLE_IDP_ROW.cognitoIdpName,
  issuerUrl: "https://idp.example.org",
  clientId: "client-abc-123",
  defaultRole: null,
  attributeMapping: SAMPLE_IDP_ROW.attributeMapping,
  scopes: "openid email profile groups",
};

const DENIED_403 = new Response(
  JSON.stringify({ error: "FORBIDDEN", message: "Active tenant does not match" }),
  { status: 403, headers: { "content-type": "application/json" } },
);

const DENIED_404 = new Response(
  JSON.stringify({ error: "NOT_FOUND", message: "Tenant not found" }),
  { status: 404, headers: { "content-type": "application/json" } },
);

function makeRequest(method: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function makeHandler(): IdpHandler {
  return new IdpHandler({
    idp: mockIdpSdk as never,
    secrets: mockSecrets as never,
    invalidateClaimsForSubs: mockInvalidateClaimsForSubs,
  });
}

/**
 * A handler with NO injected federation adapter, so it must build one from the
 * environment. That is the only way to reach the misconfiguration branch now:
 * an injected adapter IS a configured adapter, and asking it to also honour the
 * env would be asserting on a code path production does not have.
 */
function makeHandlerWithoutIdp(): IdpHandler {
  return new IdpHandler({
    secrets: mockSecrets as never,
    invalidateClaimsForSubs: mockInvalidateClaimsForSubs,
  });
}

// ── Shared setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: all auth checks pass
  mockRequireActiveTenant.mockReturnValue(null);
  mockRequireCapability.mockReturnValue(null);
  mockRequireOwnTenant.mockReturnValue(null);
  // Default: audit resolves silently
  mockAuditEmit.mockResolvedValue(undefined);
  // Default: secrets create resolves
  mockSecrets.create.mockResolvedValue({
    arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:tenant/test/idp",
  });
  mockSecrets.rotate.mockResolvedValue({
    arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:tenant/test/idp",
  });
  mockSecrets.delete.mockResolvedValue(undefined);
  // Default: idp sdk calls succeed
  mockIdpSdk.createOidcProvider.mockResolvedValue(undefined);
  mockIdpSdk.updateOidcProvider.mockResolvedValue(undefined);
  mockIdpSdk.deleteProvider.mockResolvedValue(undefined);
  mockIdpSdk.setProviderEnabled.mockResolvedValue(undefined);
  // Default: probe passes
  mockProbeOidcIssuer.mockResolvedValue({
    ok: true,
    issuer: "https://idp.example.org",
    authorizationEndpoint: "https://idp.example.org/auth",
    tokenEndpoint: "https://idp.example.org/token",
    jwksUri: "https://idp.example.org/.well-known/jwks.json",
  });
  // Default: invalidate claims succeeds
  mockInvalidateClaimsForSubs.mockResolvedValue(undefined);
  // Default prisma state: tenant found, no existing IdP, one verified domain
  (mockPrisma.tenant as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue({ id: TENANT_ID });
  (mockPrisma.tenantDomain as { findMany: ReturnType<typeof vi.fn> }).findMany.mockResolvedValue([{ domain: "example.org" }]);
  (mockPrisma.tenantIdentityProvider as {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  }).findUnique.mockResolvedValue(null);
  (mockPrisma.tenantIdentityProvider as { create: ReturnType<typeof vi.fn> }).create.mockResolvedValue(SAMPLE_IDP_ROW);
  (mockPrisma.tenantIdentityProvider as { update: ReturnType<typeof vi.fn> }).update.mockResolvedValue(SAMPLE_IDP_ROW);
  (mockPrisma.tenantIdentityProvider as { delete: ReturnType<typeof vi.fn> }).delete.mockResolvedValue(SAMPLE_IDP_ROW);
  (mockPrisma.tenantMember as { findMany: ReturnType<typeof vi.fn> }).findMany.mockResolvedValue([]);
  (mockPrisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        tenantIdentityProvider: mockPrisma.tenantIdentityProvider,
        $executeRaw: mockPrisma.$executeRaw,
      }),
  );
  (mockPrisma.$executeRaw as ReturnType<typeof vi.fn>).mockResolvedValue(1);
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleCreate
// ═══════════════════════════════════════════════════════════════════════════════

describe("IdpHandler.handleCreate", () => {
  const VALID_BODY = {
    kind: "OIDC",
    issuerUrl: "https://idp.example.org",
    clientId: "client-abc-123",
    clientSecret: "super-secret-value",
  };

  // ── AUTH GATING ──────────────────────────────────────────────────────────────

  it("AUTH DENY: requireActiveTenant → 403 — no DB, no SDK calls", async () => {
    mockRequireActiveTenant.mockReturnValue(DENIED_403);
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, VALID_BODY);
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(403);
    expect((mockPrisma.tenant as { findUnique: ReturnType<typeof vi.fn> }).findUnique).not.toHaveBeenCalled();
    expect(mockIdpSdk.createOidcProvider).not.toHaveBeenCalled();
    expect(mockSecrets.create).not.toHaveBeenCalled();
  });

  it("AUTH DENY: requireCapability → 403 — no DB, no SDK calls", async () => {
    mockRequireCapability.mockReturnValue(DENIED_403);
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, VALID_BODY);
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(403);
    expect(mockIdpSdk.createOidcProvider).not.toHaveBeenCalled();
    expect(mockSecrets.create).not.toHaveBeenCalled();
  });

  // ── VALIDATION ───────────────────────────────────────────────────────────────

  it("invalid JSON body → 400 INVALID_JSON", async () => {
    const h = makeHandler();
    const req = new Request(`https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-valid-json{{",
    });
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("INVALID_JSON");
    expect(mockSecrets.create).not.toHaveBeenCalled();
  });

  it("SAML kind → 501 SAML_NOT_AVAILABLE_IN_MVP", async () => {
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, {
      kind: "SAML",
      metadataUrl: "https://idp.example.org/metadata",
    });
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(501);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("SAML_NOT_AVAILABLE_IN_MVP");
    expect(mockSecrets.create).not.toHaveBeenCalled();
  });

  it("kind missing (not OIDC) → 400 VALIDATION_ERROR", async () => {
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, {
      issuerUrl: "https://idp.example.org",
      clientId: "abc",
      clientSecret: "secret",
    });
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(400);
    expect(mockSecrets.create).not.toHaveBeenCalled();
  });

  it("schema reject: issuerUrl not a URL → 400 VALIDATION_ERROR", async () => {
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, {
      ...VALID_BODY,
      issuerUrl: "not-a-url",
    });
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(mockSecrets.create).not.toHaveBeenCalled();
  });

  it("schema reject: clientId empty string → 400 VALIDATION_ERROR", async () => {
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, {
      ...VALID_BODY,
      clientId: "",
    });
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("schema reject: clientSecret empty string → 400 VALIDATION_ERROR", async () => {
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, {
      ...VALID_BODY,
      clientSecret: "",
    });
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("schema reject: defaultRole invalid value → 400 VALIDATION_ERROR", async () => {
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, {
      ...VALID_BODY,
      defaultRole: "OWNER",  // OWNER is not in the allowed enum
    });
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  // ── PRE-FLIGHT INVARIANTS ─────────────────────────────────────────────────────

  it("SECURITY: tenant not found → 404 — no IdP created", async () => {
    (mockPrisma.tenant as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue(null);
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, VALID_BODY);
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(404);
    expect(mockSecrets.create).not.toHaveBeenCalled();
    expect(mockIdpSdk.createOidcProvider).not.toHaveBeenCalled();
  });

  it("SECURITY: no verified domains → 422 UNPROCESSABLE — no IdP created", async () => {
    (mockPrisma.tenantDomain as { findMany: ReturnType<typeof vi.fn> }).findMany.mockResolvedValue([]);
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, VALID_BODY);
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("UNPROCESSABLE");
    expect(mockSecrets.create).not.toHaveBeenCalled();
    expect(mockIdpSdk.createOidcProvider).not.toHaveBeenCalled();
  });

  it("SECURITY: single-IdP invariant — existing IdP → 409 IDP_EXISTS, no SDK call", async () => {
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue({ id: IDP_ID });
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, VALID_BODY);
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("IDP_EXISTS");
    expect(mockSecrets.create).not.toHaveBeenCalled();
    expect(mockIdpSdk.createOidcProvider).not.toHaveBeenCalled();
  });

  it("SECURITY: issuer probe fails → 422 ISSUER_UNREACHABLE — no SDK call", async () => {
    mockProbeOidcIssuer.mockResolvedValue({
      ok: false,
      reason: "INSECURE_SCHEME",
      message: "issuerUrl must use https://",
    });
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, VALID_BODY);
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; reason: string };
    expect(body.error).toBe("ISSUER_UNREACHABLE");
    expect(body.reason).toBe("INSECURE_SCHEME");
    expect(mockSecrets.create).not.toHaveBeenCalled();
    expect(mockIdpSdk.createOidcProvider).not.toHaveBeenCalled();
  });

  it("missing Cognito pool config → 502 COGNITO_ERROR before any SDK call", async () => {
    const envNoPool = { COGNITO_APP_CLIENT_ID: "client-id" } as unknown as Env;
    const h = makeHandlerWithoutIdp();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, VALID_BODY);
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), envNoPool);

    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("COGNITO_ERROR");
    expect(mockSecrets.create).not.toHaveBeenCalled();
  });

  // ── ERROR MAPPING ─────────────────────────────────────────────────────────────

  it("secrets.create ResourceExistsException → 409 IDP_EXISTS, no Cognito call", async () => {
    mockSecrets.create.mockRejectedValue(Object.assign(new Error("exists"), { name: "ResourceExistsException" }));
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, VALID_BODY);
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("IDP_EXISTS");
    expect(mockIdpSdk.createOidcProvider).not.toHaveBeenCalled();
  });

  it("secrets.create generic error → 502 COGNITO_ERROR, no Cognito call", async () => {
    mockSecrets.create.mockRejectedValue(new Error("SM unavailable"));
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, VALID_BODY);
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(502);
    expect(mockIdpSdk.createOidcProvider).not.toHaveBeenCalled();
  });

  it("Cognito createOidcProvider fails → 502, rolls back secret", async () => {
    mockIdpSdk.createOidcProvider.mockRejectedValue(new Error("Cognito error"));
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, VALID_BODY);
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(502);
    // Rollback: secret should be deleted
    expect(mockSecrets.delete).toHaveBeenCalledWith(TENANT_ID);
  });

  it("$transaction (RDS commit) fails → 502, rolls back Cognito provider and secret", async () => {
    (mockPrisma.$transaction as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("RDS timeout"));
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, VALID_BODY);
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(502);
    // Rollback: both Cognito provider and secret should be cleaned up
    expect(mockIdpSdk.deleteProvider).toHaveBeenCalled();
    expect(mockSecrets.delete).toHaveBeenCalledWith(TENANT_ID);
  });

  // ── HAPPY PATH ───────────────────────────────────────────────────────────────

  it("happy path: returns 201 with formatted IdP record", async () => {
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, VALID_BODY);
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBe(IDP_ID);
    expect(body.kind).toBe("OIDC");
    expect(body.status).toBe("ACTIVE");
    expect(body.issuerUrl).toBe("https://idp.example.org");
  });

  it("SECURITY: clientSecretArn is NOT included in 201 response", async () => {
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, VALID_BODY);
    const res = await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(body, "clientSecretArn")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, "clientSecret")).toBe(false);
  });

  it("happy path: probe is called with the issuerUrl from body", async () => {
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, VALID_BODY);
    await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(mockProbeOidcIssuer).toHaveBeenCalledWith("https://idp.example.org");
  });

  it("happy path: secrets.create is called before Cognito createOidcProvider", async () => {
    const callOrder: string[] = [];
    mockSecrets.create.mockImplementation(async () => {
      callOrder.push("secrets.create");
      return { arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:tenant/test/idp" };
    });
    mockIdpSdk.createOidcProvider.mockImplementation(async () => {
      callOrder.push("cognito.create");
    });

    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, VALID_BODY);
    await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(callOrder).toEqual(["secrets.create", "cognito.create"]);
  });

  it("happy path: audit emitted with TENANT_IDP_CONNECTED type and issuerUrl", async () => {
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, VALID_BODY);
    await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    // Give the fire-and-forget void audit a tick to settle
    await Promise.resolve();
    expect(mockAuditEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tenant.idp.connected",
        tenantId: TENANT_ID,
        actorUserId: makeAuth().userId,
        payload: expect.objectContaining({
          idpKind: "OIDC",
          issuer: "https://idp.example.org",
        }),
      }),
      mockPrisma,
    );
  });

  it("happy path: Prisma create is called with status ACTIVE and no clientSecretArn leak", async () => {
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, VALID_BODY);
    await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect((mockPrisma.tenantIdentityProvider as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          kind: "OIDC",
          status: "ACTIVE",
          issuerUrl: "https://idp.example.org",
          clientId: "client-abc-123",
        }),
      }),
    );
  });

  it("happy path: idpIdentifiers are set from verified domains", async () => {
    (mockPrisma.tenantDomain as { findMany: ReturnType<typeof vi.fn> }).findMany.mockResolvedValue([
      { domain: "example.org" },
      { domain: "sub.example.org" },
    ]);
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, VALID_BODY);
    await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect(mockIdpSdk.createOidcProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        idpIdentifiers: expect.arrayContaining(["example.org", "sub.example.org"]),
      }),
    );
  });

  it("happy path: defaultRole is persisted when provided", async () => {
    const h = makeHandler();
    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, {
      ...VALID_BODY,
      defaultRole: "MEMBER",
    });
    await h.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

    expect((mockPrisma.tenantIdentityProvider as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ defaultRole: "MEMBER" }),
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleGet
// ═══════════════════════════════════════════════════════════════════════════════

describe("IdpHandler.handleGet", () => {
  // ── AUTH GATING ──────────────────────────────────────────────────────────────

  it("AUTH DENY: requireOwnTenant → 404 — no DB call", async () => {
    mockRequireOwnTenant.mockReturnValue(DENIED_404);
    const h = makeHandler();
    const res = await h.handleGet(TENANT_ID, makeAuth(), mockEnv);

    expect(res.status).toBe(404);
    expect((mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique).not.toHaveBeenCalled();
  });

  it("AUTH DENY: requireCapability → 403 — no DB call", async () => {
    mockRequireCapability.mockReturnValue(DENIED_403);
    const h = makeHandler();
    const res = await h.handleGet(TENANT_ID, makeAuth(), mockEnv);

    expect(res.status).toBe(403);
    expect((mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique).not.toHaveBeenCalled();
  });

  // ── HAPPY PATH ───────────────────────────────────────────────────────────────

  it("returns 200 with formatted IdP record when IdP exists", async () => {
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue(SAMPLE_IDP_ROW);
    const h = makeHandler();
    const res = await h.handleGet(TENANT_ID, makeAuth(), mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBe(IDP_ID);
    expect(body.kind).toBe("OIDC");
    expect(body.status).toBe("ACTIVE");
    expect(body.issuerUrl).toBe("https://idp.example.org");
    expect(body.clientId).toBe("client-abc-123");
  });

  it("SECURITY: clientSecretArn is NOT present in 200 response", async () => {
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue(SAMPLE_IDP_ROW);
    const h = makeHandler();
    const res = await h.handleGet(TENANT_ID, makeAuth(), mockEnv);
    const body = await res.json() as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(body, "clientSecretArn")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, "clientSecret")).toBe(false);
  });

  it("returns 404 NOT_FOUND when IdP does not exist", async () => {
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue(null);
    const h = makeHandler();
    const res = await h.handleGet(TENANT_ID, makeAuth(), mockEnv);

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("NOT_FOUND");
  });

  it("queries with correct tenantId scoping (where: { tenantId })", async () => {
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue(SAMPLE_IDP_ROW);
    const h = makeHandler();
    await h.handleGet(TENANT_ID, makeAuth(), mockEnv);

    expect((mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT_ID } }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handlePatch — status branch
// ═══════════════════════════════════════════════════════════════════════════════

describe("IdpHandler.handlePatch (status branch)", () => {
  // ── AUTH GATING ──────────────────────────────────────────────────────────────

  it("AUTH DENY: requireActiveTenant → 403 — no DB call", async () => {
    mockRequireActiveTenant.mockReturnValue(DENIED_403);
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { status: "DISABLED" });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(403);
    expect((mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique).not.toHaveBeenCalled();
  });

  it("AUTH DENY: requireCapability → 403 — no DB call", async () => {
    mockRequireCapability.mockReturnValue(DENIED_403);
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { status: "DISABLED" });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(403);
    expect((mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique).not.toHaveBeenCalled();
  });

  // ── VALIDATION ───────────────────────────────────────────────────────────────

  it("invalid JSON body → 400 INVALID_JSON", async () => {
    const h = makeHandler();
    const req = new Request(`https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{{bad-json",
    });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("INVALID_JSON");
  });

  it("status value INVALID → 400 VALIDATION_ERROR", async () => {
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { status: "PENDING" });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(400);
  });

  it("empty body (no recognized fields) → 400 VALIDATION_ERROR", async () => {
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, {});
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(400);
  });

  // ── NOT FOUND ─────────────────────────────────────────────────────────────────

  it("IdP not found for status toggle → 404", async () => {
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue(null);
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { status: "DISABLED" });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("NOT_FOUND");
  });

  // ── IDEMPOTENCY ───────────────────────────────────────────────────────────────

  it("status already ACTIVE when requesting ACTIVE → 200 unchanged:true, no SDK call", async () => {
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue({ id: IDP_ID, status: "ACTIVE", cognitoIdpName: SAMPLE_IDP_ROW.cognitoIdpName });
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { status: "ACTIVE" });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json() as { unchanged: boolean };
    expect(body.unchanged).toBe(true);
    expect(mockIdpSdk.setProviderEnabled).not.toHaveBeenCalled();
  });

  it("status already DISABLED when requesting DISABLED → 200 unchanged:true, no SDK call", async () => {
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue({ id: IDP_ID, status: "DISABLED", cognitoIdpName: SAMPLE_IDP_ROW.cognitoIdpName });
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { status: "DISABLED" });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json() as { unchanged: boolean };
    expect(body.unchanged).toBe(true);
    expect(mockIdpSdk.setProviderEnabled).not.toHaveBeenCalled();
  });

  // ── HAPPY PATH ───────────────────────────────────────────────────────────────

  it("ACTIVE → DISABLED: returns 200, calls setProviderEnabled(false), invalidates claims", async () => {
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue({ id: IDP_ID, status: "ACTIVE", cognitoIdpName: SAMPLE_IDP_ROW.cognitoIdpName });
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { status: "DISABLED" });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(200);
    expect(mockIdpSdk.setProviderEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        providerName: SAMPLE_IDP_ROW.cognitoIdpName,
        enabled: false,
        // The adapter serializes itself, so the caller must hand over its
        // transaction — a call without it would silently lose the lock.
        tx: expect.anything(),
      }),
    );
    expect(mockInvalidateClaimsForSubs).toHaveBeenCalledWith(expect.any(Array));
  });

  it("DISABLED → ACTIVE: returns 200, calls setProviderEnabled(true), does NOT invalidate claims", async () => {
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue({ id: IDP_ID, status: "DISABLED", cognitoIdpName: SAMPLE_IDP_ROW.cognitoIdpName });
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { status: "ACTIVE" });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(200);
    expect(mockIdpSdk.setProviderEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        providerName: SAMPLE_IDP_ROW.cognitoIdpName,
        enabled: true,
        tx: expect.anything(),
      }),
    );
    expect(mockInvalidateClaimsForSubs).not.toHaveBeenCalled();
  });

  it("status DISABLED: audit emitted with TENANT_IDP_DISABLED type", async () => {
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue({ id: IDP_ID, status: "ACTIVE", cognitoIdpName: SAMPLE_IDP_ROW.cognitoIdpName });
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { status: "DISABLED" });
    await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    await Promise.resolve();
    expect(mockAuditEmit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tenant.idp.disabled", tenantId: TENANT_ID }),
      mockPrisma,
    );
  });

  it("status ACTIVE (re-enable): audit emitted with TENANT_IDP_MODIFIED type", async () => {
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue({ id: IDP_ID, status: "DISABLED", cognitoIdpName: SAMPLE_IDP_ROW.cognitoIdpName });
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { status: "ACTIVE" });
    await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    await Promise.resolve();
    expect(mockAuditEmit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tenant.idp.modified", tenantId: TENANT_ID }),
      mockPrisma,
    );
  });

  it("Cognito setProviderEnabled error → 502 COGNITO_ERROR", async () => {
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue({ id: IDP_ID, status: "ACTIVE", cognitoIdpName: SAMPLE_IDP_ROW.cognitoIdpName });
    mockIdpSdk.setProviderEnabled.mockRejectedValue(new Error("Cognito down"));
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { status: "DISABLED" });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("COGNITO_ERROR");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handlePatch — config branch
// ═══════════════════════════════════════════════════════════════════════════════

describe("IdpHandler.handlePatch (config branch)", () => {
  beforeEach(() => {
    // For config tests, IdP exists
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue({
      ...SAMPLE_IDP_ROW,
    });
  });

  // ── VALIDATION ───────────────────────────────────────────────────────────────

  it("body with no recognized config field → 400 (at least one required)", async () => {
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, {
      unknownField: "value",
    });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(400);
    expect(mockIdpSdk.updateOidcProvider).not.toHaveBeenCalled();
  });

  it("clientSecret too long → 400 VALIDATION_ERROR", async () => {
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, {
      clientSecret: "x".repeat(2049),
    });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(400);
    expect(mockIdpSdk.updateOidcProvider).not.toHaveBeenCalled();
  });

  it("scopes too long → 400 VALIDATION_ERROR", async () => {
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, {
      scopes: "x".repeat(1025),
    });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(400);
    expect(mockIdpSdk.updateOidcProvider).not.toHaveBeenCalled();
  });

  // ── NOT FOUND ─────────────────────────────────────────────────────────────────

  it("IdP not found for config update → 404", async () => {
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue(null);
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { scopes: "openid email" });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(404);
  });

  it("SAML IdP → 501 SAML_NOT_AVAILABLE_IN_MVP on config update", async () => {
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue({
      ...SAMPLE_IDP_ROW,
      kind: "SAML" as IdpKind,
    });
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { scopes: "openid email" });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(501);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("SAML_NOT_AVAILABLE_IN_MVP");
  });

  // ── HAPPY PATHS ───────────────────────────────────────────────────────────────

  it("happy path: update scopes — calls Cognito update, persists to DB, returns 200", async () => {
    const updatedRow = { ...SAMPLE_IDP_ROW, scopes: "openid email" };
    (mockPrisma.tenantIdentityProvider as { update: ReturnType<typeof vi.fn> }).update.mockResolvedValue(updatedRow);
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { scopes: "openid email" });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(200);
    // The pool id is the ADAPTER's configuration now, not a per-call argument.
    expect(mockIdpSdk.updateOidcProvider).toHaveBeenCalledWith(
      expect.objectContaining({ details: { scopes: "openid email" } }),
    );
    expect((mockPrisma.tenantIdentityProvider as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalled();
  });

  it("happy path: update clientSecret — calls Cognito update then secrets.rotate, returns 200", async () => {
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { clientSecret: "new-secret" });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(200);
    expect(mockIdpSdk.updateOidcProvider).toHaveBeenCalled();
    expect(mockSecrets.rotate).toHaveBeenCalledWith(TENANT_ID, "new-secret");
  });

  it("SECURITY: clientSecretArn NOT in response after config update", async () => {
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { scopes: "openid email" });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    const body = await res.json() as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(body, "clientSecretArn")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, "clientSecret")).toBe(false);
  });

  it("Cognito updateOidcProvider error → 502, secrets.rotate NOT called (ordering)", async () => {
    mockIdpSdk.updateOidcProvider.mockRejectedValue(new Error("Cognito down"));
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { clientSecret: "new-secret" });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(502);
    // Cognito went first and failed — secret must NOT be rotated
    expect(mockSecrets.rotate).not.toHaveBeenCalled();
  });

  it("secrets.rotate fails after Cognito update → 502", async () => {
    mockSecrets.rotate.mockRejectedValue(new Error("SM down"));
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { clientSecret: "new-secret" });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(502);
  });

  it("happy path: update defaultRole to null — persists null and returns 200", async () => {
    const updatedRow = { ...SAMPLE_IDP_ROW, defaultRole: null };
    (mockPrisma.tenantIdentityProvider as { update: ReturnType<typeof vi.fn> }).update.mockResolvedValue(updatedRow);
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { defaultRole: null });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    expect(res.status).toBe(200);
    expect((mockPrisma.tenantIdentityProvider as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ defaultRole: null }) }),
    );
  });

  it("happy path: audit emitted with TENANT_IDP_MODIFIED type on config change", async () => {
    const h = makeHandler();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { scopes: "openid email" });
    await h.handlePatch(TENANT_ID, req, makeAuth(), mockEnv);

    await Promise.resolve();
    expect(mockAuditEmit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tenant.idp.modified", tenantId: TENANT_ID }),
      mockPrisma,
    );
  });

  it("missing Cognito pool id → 502 before any SDK call on config update", async () => {
    const envNoPool = { COGNITO_APP_CLIENT_ID: "client-id" } as unknown as Env;
    const h = makeHandlerWithoutIdp();
    const req = makeRequest("PATCH", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, { scopes: "openid email" });
    const res = await h.handlePatch(TENANT_ID, req, makeAuth(), envNoPool);

    expect(res.status).toBe(502);
    expect(mockIdpSdk.updateOidcProvider).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleDelete
// ═══════════════════════════════════════════════════════════════════════════════

describe("IdpHandler.handleDelete", () => {
  const makeUrl = (confirm?: string) =>
    new URL(
      confirm !== undefined
        ? `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider?confirm=${confirm}`
        : `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`,
    );

  beforeEach(() => {
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue({
      id: IDP_ID,
      cognitoIdpName: SAMPLE_IDP_ROW.cognitoIdpName,
      kind: "OIDC" as IdpKind,
    });
  });

  // ── AUTH GATING ──────────────────────────────────────────────────────────────

  it("AUTH DENY: requireActiveTenant → 403 — no DB, no SDK calls", async () => {
    mockRequireActiveTenant.mockReturnValue(DENIED_403);
    const h = makeHandler();
    const res = await h.handleDelete(TENANT_ID, makeUrl("true"), makeAuth(), mockEnv);

    expect(res.status).toBe(403);
    expect((mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique).not.toHaveBeenCalled();
    expect(mockIdpSdk.deleteProvider).not.toHaveBeenCalled();
  });

  it("AUTH DENY: requireCapability → 403 — no DB, no SDK calls", async () => {
    mockRequireCapability.mockReturnValue(DENIED_403);
    const h = makeHandler();
    const res = await h.handleDelete(TENANT_ID, makeUrl("true"), makeAuth(), mockEnv);

    expect(res.status).toBe(403);
    expect((mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique).not.toHaveBeenCalled();
    expect(mockIdpSdk.deleteProvider).not.toHaveBeenCalled();
  });

  // ── CONFIRM REQUIRED ─────────────────────────────────────────────────────────

  it("SECURITY: confirm param absent → 400 CONFIRM_REQUIRED, no DB access", async () => {
    const h = makeHandler();
    const res = await h.handleDelete(TENANT_ID, makeUrl(), makeAuth(), mockEnv);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("CONFIRM_REQUIRED");
    expect((mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique).not.toHaveBeenCalled();
  });

  it("SECURITY: confirm=false → 400 CONFIRM_REQUIRED, no DB access", async () => {
    const h = makeHandler();
    const res = await h.handleDelete(TENANT_ID, makeUrl("false"), makeAuth(), mockEnv);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("CONFIRM_REQUIRED");
    expect((mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique).not.toHaveBeenCalled();
  });

  // ── NOT FOUND ─────────────────────────────────────────────────────────────────

  it("IdP not found → 404 NOT_FOUND", async () => {
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue(null);
    const h = makeHandler();
    const res = await h.handleDelete(TENANT_ID, makeUrl("true"), makeAuth(), mockEnv);

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("NOT_FOUND");
    expect(mockIdpSdk.deleteProvider).not.toHaveBeenCalled();
  });

  // ── HAPPY PATH ───────────────────────────────────────────────────────────────

  it("happy path: returns 200 { ok: true }", async () => {
    const h = makeHandler();
    const res = await h.handleDelete(TENANT_ID, makeUrl("true"), makeAuth(), mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("happy path: calls setProviderEnabled(false), deleteProvider, DB delete", async () => {
    const h = makeHandler();
    await h.handleDelete(TENANT_ID, makeUrl("true"), makeAuth(), mockEnv);

    expect(mockIdpSdk.setProviderEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        providerName: SAMPLE_IDP_ROW.cognitoIdpName,
        enabled: false,
        // The adapter serializes itself, so the caller must hand over its
        // transaction — a call without it would silently lose the lock.
        tx: expect.anything(),
      }),
    );
    expect(mockIdpSdk.deleteProvider).toHaveBeenCalledWith(
      SAMPLE_IDP_ROW.cognitoIdpName,
    );
    expect((mockPrisma.tenantIdentityProvider as { delete: ReturnType<typeof vi.fn> }).delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: IDP_ID } }),
    );
  });

  it("happy path: secrets.delete is called after transaction", async () => {
    const h = makeHandler();
    await h.handleDelete(TENANT_ID, makeUrl("true"), makeAuth(), mockEnv);

    expect(mockSecrets.delete).toHaveBeenCalledWith(TENANT_ID);
  });

  it("happy path: invalidateAllMemberClaims called after transaction", async () => {
    const h = makeHandler();
    await h.handleDelete(TENANT_ID, makeUrl("true"), makeAuth(), mockEnv);

    expect(mockInvalidateClaimsForSubs).toHaveBeenCalledWith(expect.any(Array));
  });

  it("happy path: audit emitted with TENANT_IDP_DELETED type", async () => {
    const h = makeHandler();
    await h.handleDelete(TENANT_ID, makeUrl("true"), makeAuth(), mockEnv);

    await Promise.resolve();
    expect(mockAuditEmit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tenant.idp.deleted", tenantId: TENANT_ID }),
      mockPrisma,
    );
  });

  // ── ERROR MAPPING ─────────────────────────────────────────────────────────────

  it("transaction (Cognito/DB) error → 502 COGNITO_ERROR", async () => {
    (mockPrisma.$transaction as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("RDS timeout"));
    const h = makeHandler();
    const res = await h.handleDelete(TENANT_ID, makeUrl("true"), makeAuth(), mockEnv);

    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("COGNITO_ERROR");
  });

  it("secrets.delete error on delete is swallowed (best-effort), returns 200", async () => {
    mockSecrets.delete.mockRejectedValue(new Error("SM error"));
    const h = makeHandler();
    const res = await h.handleDelete(TENANT_ID, makeUrl("true"), makeAuth(), mockEnv);

    // secrets.delete is .catch(() => undefined) so it should not surface as 502
    expect(res.status).toBe(200);
  });

  it("missing Cognito pool config → 502 before transaction", async () => {
    const envNoPool = { COGNITO_APP_CLIENT_ID: "client-id" } as unknown as Env;
    const h = makeHandlerWithoutIdp();
    const res = await h.handleDelete(TENANT_ID, makeUrl("true"), makeAuth(), envNoPool);

    expect(res.status).toBe(502);
    expect(mockIdpSdk.deleteProvider).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-cutting: SUPER_ADMIN bypasses tenant scope
// ═══════════════════════════════════════════════════════════════════════════════

describe("SUPER_ADMIN passthrough", () => {
  it("requireActiveTenant does not block SUPER_ADMIN on handleCreate", async () => {
    // Real requireActiveTenant returns null for SUPER_ADMIN — simulate by
    // restoring the real impl and checking the SUPER_ADMIN path passes.
    // Since we mock requireActiveTenant, we just verify it's consulted and
    // returns null (default) — the real bypass logic is tested in auth-middleware tests.
    const h = makeHandler();
    // With mocks defaulting to null (pass), a SUPER_ADMIN auth should proceed
    // through to DB calls.
    const auth = makeAuth({ globalRole: "SUPER_ADMIN" as UserRole });
    (mockPrisma.tenant as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue({ id: TENANT_ID });
    (mockPrisma.tenantDomain as { findMany: ReturnType<typeof vi.fn> }).findMany.mockResolvedValue([{ domain: "example.org" }]);
    (mockPrisma.tenantIdentityProvider as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue(null);

    const req = makeRequest("POST", `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`, {
      kind: "OIDC",
      issuerUrl: "https://idp.example.org",
      clientId: "client-abc-123",
      clientSecret: "super-secret-value",
    });
    const res = await h.handleCreate(TENANT_ID, req, auth, mockEnv);

    // Auth guard (mocked to null) passes, so we reach DB/SDK.
    expect(mockRequireActiveTenant).toHaveBeenCalledWith(auth, TENANT_ID);
    expect(res.status).toBe(201);
  });
});
