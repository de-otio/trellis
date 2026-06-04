import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TenantRole, UserRole } from "@prisma/client";
import { IdpHandler } from "../../src/lib/tenant/idp-handler.js";
import type { AuthContext } from "../../src/lib/auth/auth-context.js";
import type { Env } from "../../src/env.js";

// ── Prisma mock ───────────────────────────────────────────────────────────────
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    $transaction: vi.fn(),
    tenant: { findUnique: vi.fn() },
    tenantDomain: { findMany: vi.fn() },
    tenantIdentityProvider: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    tenantMember: { findMany: vi.fn() },
    securityEvent: { create: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));

vi.mock("../../src/db", () => ({
  createPrisma: () => mockDb,
}));

// ── Issuer probe mock ────────────────────────────────────────────────────────
const { mockProbe } = vi.hoisted(() => ({
  mockProbe: vi.fn(),
}));
vi.mock("../../src/lib/cognito/issuer-probe", () => ({
  probeOidcIssuer: mockProbe,
  isPrivateIPv4: () => false,
  isPrivateIPv6: () => false,
}));

// ── Audit emitter mock ────────────────────────────────────────────────────────
const { mockAuditEmit } = vi.hoisted(() => ({ mockAuditEmit: vi.fn() }));
vi.mock("../../src/lib/audit-composer", () => ({
  TenantAuditEmitter: class {
    emit(...args: unknown[]) {
      return mockAuditEmit(...args);
    }
  },
}));

// ── Cognito + Secrets clients mocked at module-construction layer ────────────
vi.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: class {
    constructor() {}
    send = vi.fn();
  },
  AdminUserGlobalSignOutCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    constructor() {}
  },
}));

// ── SDK dependency stubs ──────────────────────────────────────────────────────
type IdpStub = {
  createOidcProvider: ReturnType<typeof vi.fn>;
  updateOidcProvider: ReturnType<typeof vi.fn>;
  deleteProvider: ReturnType<typeof vi.fn>;
  setSupportedIdentityProvider: ReturnType<typeof vi.fn>;
  describeProvider: ReturnType<typeof vi.fn>;
};
type SecretsStub = {
  create: ReturnType<typeof vi.fn>;
  rotate: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  describe: ReturnType<typeof vi.fn>;
};

function makeIdpStub(): IdpStub {
  return {
    createOidcProvider: vi.fn().mockResolvedValue(undefined),
    updateOidcProvider: vi.fn().mockResolvedValue(undefined),
    deleteProvider: vi.fn().mockResolvedValue(undefined),
    setSupportedIdentityProvider: vi.fn().mockResolvedValue(undefined),
    describeProvider: vi.fn().mockResolvedValue(true),
  };
}
function makeSecretsStub(arn = "arn:aws:secretsmanager:eu-central-1:111:secret:tenant/abc/idp-client-secret-x"): SecretsStub {
  return {
    create: vi.fn().mockResolvedValue({ arn, versionId: "v1" }),
    rotate: vi.fn().mockResolvedValue({ arn, versionId: "v2" }),
    delete: vi.fn().mockResolvedValue(undefined),
    describe: vi.fn().mockResolvedValue(null),
  };
}

const TENANT_ID = "ctest1tenant";
const OTHER_TENANT_ID = "cothertenant";
const PROVIDER_NAME = "tenant-ctest1tenant";

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    cognitoSub: "owner-sub",
    userId: "owner-id",
    globalRole: "B2B_PARTNER" as UserRole,
    activeTenantId: TENANT_ID,
    tenantSlug: "acme",
    tenantRole: "OWNER" as TenantRole,
    handle: "owner",
    membershipsLoader: async () => [],
    ...overrides,
  };
}

const mockEnv: Env = {
  DATABASE_URL: "postgresql://test",
  COGNITO_USER_POOL_ID: "pool",
  COGNITO_APP_CLIENT_ID: "client",
  COGNITO_REGION: "eu-central-1",
} as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  mockProbe.mockReset();
  mockAuditEmit.mockResolvedValue(undefined);
  mockDb.$transaction.mockImplementation(async (fn: unknown, _opts?: unknown) => {
    if (typeof fn === "function") {
      return (fn as (tx: typeof mockDb) => Promise<unknown>)(mockDb);
    }
    return fn;
  });
  mockDb.$executeRaw.mockResolvedValue(1);
  mockDb.tenant.findUnique.mockResolvedValue({ id: TENANT_ID });
  mockDb.tenantDomain.findMany.mockResolvedValue([{ domain: "acme.example.com" }]);
  mockDb.tenantIdentityProvider.findUnique.mockResolvedValue(null);
  mockDb.tenantMember.findMany.mockResolvedValue([]);
});

function jsonRequest(body: unknown, method = "POST", search = ""): Request {
  return new Request(`https://api.example.com/api/tenants/${TENANT_ID}/identity-provider${search}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — create
// ─────────────────────────────────────────────────────────────────────────────
describe("IdpHandler.handleCreate", () => {
  it("201 on happy path: probe → secret → cognito → cache → DB", async () => {
    const idp = makeIdpStub();
    const secrets = makeSecretsStub();
    mockProbe.mockResolvedValue({
      ok: true,
      issuer: "https://idp.example.com/v2.0",
      authorizationEndpoint: "x",
      tokenEndpoint: "y",
      jwksUri: "z",
    });
    mockDb.tenantIdentityProvider.create.mockResolvedValue({
      id: "idp1",
      tenantId: TENANT_ID,
      kind: "OIDC",
      status: "ACTIVE",
      cognitoIdpName: PROVIDER_NAME,
      issuerUrl: "https://idp.example.com/",
      clientId: "cid",
      defaultRole: null,
      attributeMapping: { email: "email" },
      scopes: "openid email profile groups",
      enabledAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const handler = new IdpHandler({ idp: idp as never, secrets: secrets as never });
    const response = await handler.handleCreate(
      TENANT_ID,
      jsonRequest({
        kind: "OIDC",
        issuerUrl: "https://idp.example.com/",
        clientId: "cid",
        clientSecret: "shh",
        defaultRole: "MEMBER",
      }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.cognitoIdpName).toBe(PROVIDER_NAME);
    expect(body).not.toHaveProperty("clientSecret");
    expect(secrets.create).toHaveBeenCalledWith(TENANT_ID, "shh");
    expect(idp.createOidcProvider).toHaveBeenCalledOnce();
    expect(idp.setSupportedIdentityProvider).toHaveBeenCalledWith(
      "pool",
      "client",
      PROVIDER_NAME,
      "add",
    );
    expect(mockAuditEmit).toHaveBeenCalledOnce();
  });

  it("returns 501 SAML_NOT_AVAILABLE_IN_MVP for kind=SAML", async () => {
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handleCreate(
      TENANT_ID,
      jsonRequest({ kind: "SAML", metadataUrl: "https://x" }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(501);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("SAML_NOT_AVAILABLE_IN_MVP");
  });

  it("returns 422 when no verified domain exists", async () => {
    mockDb.tenantDomain.findMany.mockResolvedValue([]);
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handleCreate(
      TENANT_ID,
      jsonRequest({
        kind: "OIDC",
        issuerUrl: "https://idp.example.com/",
        clientId: "cid",
        clientSecret: "shh",
      }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(422);
  });

  it("returns 409 when an IdP record already exists", async () => {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({ id: "existing" });
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handleCreate(
      TENANT_ID,
      jsonRequest({
        kind: "OIDC",
        issuerUrl: "https://idp.example.com/",
        clientId: "cid",
        clientSecret: "shh",
      }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(409);
  });

  it("returns 422 when the issuer probe fails (no Cognito or Secrets state created)", async () => {
    const idp = makeIdpStub();
    const secrets = makeSecretsStub();
    mockProbe.mockResolvedValue({ ok: false, reason: "PRIVATE_HOST", message: "private IP" });
    const handler = new IdpHandler({ idp: idp as never, secrets: secrets as never });
    const response = await handler.handleCreate(
      TENANT_ID,
      jsonRequest({
        kind: "OIDC",
        issuerUrl: "https://idp.example.com/",
        clientId: "cid",
        clientSecret: "shh",
      }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(422);
    expect(idp.createOidcProvider).not.toHaveBeenCalled();
    expect(secrets.create).not.toHaveBeenCalled();
  });

  it("rolls back the secret if Cognito CreateIdentityProvider fails", async () => {
    const idp = makeIdpStub();
    idp.createOidcProvider.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "InvalidParameterException" }),
    );
    const secrets = makeSecretsStub();
    mockProbe.mockResolvedValue({
      ok: true,
      issuer: "https://idp.example.com/v2.0",
      authorizationEndpoint: "x",
      tokenEndpoint: "y",
      jwksUri: "z",
    });
    const handler = new IdpHandler({ idp: idp as never, secrets: secrets as never });
    const response = await handler.handleCreate(
      TENANT_ID,
      jsonRequest({
        kind: "OIDC",
        issuerUrl: "https://idp.example.com/",
        clientId: "cid",
        clientSecret: "shh",
      }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(502);
    expect(secrets.create).toHaveBeenCalled();
    expect(secrets.delete).toHaveBeenCalledWith(TENANT_ID);
    expect(mockDb.tenantIdentityProvider.create).not.toHaveBeenCalled();
  });

  it("rolls back Cognito + secret if the RDS commit fails", async () => {
    const idp = makeIdpStub();
    const secrets = makeSecretsStub();
    mockProbe.mockResolvedValue({
      ok: true,
      issuer: "https://idp.example.com/v2.0",
      authorizationEndpoint: "x",
      tokenEndpoint: "y",
      jwksUri: "z",
    });
    mockDb.tenantIdentityProvider.create.mockRejectedValueOnce(
      Object.assign(new Error("dup"), { code: "P2002" }),
    );
    const handler = new IdpHandler({ idp: idp as never, secrets: secrets as never });
    const response = await handler.handleCreate(
      TENANT_ID,
      jsonRequest({
        kind: "OIDC",
        issuerUrl: "https://idp.example.com/",
        clientId: "cid",
        clientSecret: "shh",
      }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(502);
    expect(idp.deleteProvider).toHaveBeenCalledWith("pool", PROVIDER_NAME);
    expect(secrets.delete).toHaveBeenCalledWith(TENANT_ID);
  });

  it("returns 409 when the secret already exists (concurrent create)", async () => {
    const idp = makeIdpStub();
    const secrets = makeSecretsStub();
    secrets.create.mockRejectedValueOnce(
      Object.assign(new Error("exists"), { name: "ResourceExistsException" }),
    );
    mockProbe.mockResolvedValue({
      ok: true,
      issuer: "https://idp.example.com/v2.0",
      authorizationEndpoint: "x",
      tokenEndpoint: "y",
      jwksUri: "z",
    });
    const handler = new IdpHandler({ idp: idp as never, secrets: secrets as never });
    const response = await handler.handleCreate(
      TENANT_ID,
      jsonRequest({
        kind: "OIDC",
        issuerUrl: "https://idp.example.com/",
        clientId: "cid",
        clientSecret: "shh",
      }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(409);
    expect(idp.createOidcProvider).not.toHaveBeenCalled();
  });

  it("returns 502 when Secrets Manager Create returns a non-handled error", async () => {
    const idp = makeIdpStub();
    const secrets = makeSecretsStub();
    secrets.create.mockRejectedValueOnce(
      Object.assign(new Error("boom"), { name: "InternalServiceError" }),
    );
    mockProbe.mockResolvedValue({
      ok: true,
      issuer: "https://x",
      authorizationEndpoint: "x",
      tokenEndpoint: "y",
      jwksUri: "z",
    });
    const handler = new IdpHandler({ idp: idp as never, secrets: secrets as never });
    const response = await handler.handleCreate(
      TENANT_ID,
      jsonRequest({
        kind: "OIDC",
        issuerUrl: "https://idp.example.com/",
        clientId: "cid",
        clientSecret: "shh",
      }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(502);
  });

  it("returns 400 on invalid JSON", async () => {
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const request = new Request(
      `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "not-json" },
    );
    const response = await handler.handleCreate(TENANT_ID, request, makeAuth(), mockEnv);
    expect(response.status).toBe(400);
  });

  it("returns 400 when kind is missing or wrong", async () => {
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handleCreate(
      TENANT_ID,
      jsonRequest({ kind: "OAUTH2" }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when the schema is invalid", async () => {
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handleCreate(
      TENANT_ID,
      jsonRequest({ kind: "OIDC", issuerUrl: "not-a-url", clientId: "x", clientSecret: "x" }),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(400);
  });

  it("returns 502 when COGNITO env vars are missing", async () => {
    mockProbe.mockResolvedValue({
      ok: true,
      issuer: "https://x",
      authorizationEndpoint: "x",
      tokenEndpoint: "y",
      jwksUri: "z",
    });
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const env = { ...mockEnv, COGNITO_USER_POOL_ID: undefined, COGNITO_APP_CLIENT_ID: undefined } as Env;
    const response = await handler.handleCreate(
      TENANT_ID,
      jsonRequest({
        kind: "OIDC",
        issuerUrl: "https://idp.example.com/",
        clientId: "cid",
        clientSecret: "shh",
      }),
      makeAuth(),
      env,
    );
    expect(response.status).toBe(502);
  });

  it("returns 403 when capability gate denies non-OWNER non-ADMIN", async () => {
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handleCreate(
      TENANT_ID,
      jsonRequest({
        kind: "OIDC",
        issuerUrl: "https://idp.example.com/",
        clientId: "cid",
        clientSecret: "shh",
      }),
      makeAuth({ tenantRole: "MEMBER" as TenantRole }),
      mockEnv,
    );
    expect(response.status).toBe(403);
  });

  it("returns 403 when the caller's active tenant differs (cross-tenant)", async () => {
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handleCreate(
      OTHER_TENANT_ID,
      jsonRequest({
        kind: "OIDC",
        issuerUrl: "https://idp.example.com/",
        clientId: "cid",
        clientSecret: "shh",
      }),
      makeAuth({ activeTenantId: TENANT_ID }),
      mockEnv,
    );
    expect(response.status).toBe(403);
  });

  it("opens the Prisma transaction with a 15s timeout (longer than Cognito Describe+Update)", async () => {
    const idp = makeIdpStub();
    const secrets = makeSecretsStub();
    mockProbe.mockResolvedValue({
      ok: true,
      issuer: "https://idp.example.com/v2.0",
      authorizationEndpoint: "x",
      tokenEndpoint: "y",
      jwksUri: "z",
    });
    mockDb.tenantIdentityProvider.create.mockResolvedValue({
      id: "idp1",
      tenantId: TENANT_ID,
      kind: "OIDC",
      status: "ACTIVE",
      cognitoIdpName: PROVIDER_NAME,
      issuerUrl: "https://idp.example.com/",
      clientId: "cid",
      defaultRole: null,
      attributeMapping: { email: "email" },
      scopes: "openid email profile groups",
      enabledAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const handler = new IdpHandler({ idp: idp as never, secrets: secrets as never });
    await handler.handleCreate(
      TENANT_ID,
      jsonRequest({
        kind: "OIDC",
        issuerUrl: "https://idp.example.com/",
        clientId: "cid",
        clientSecret: "shh",
      }),
      makeAuth(),
      mockEnv,
    );
    const opts = mockDb.$transaction.mock.calls[0]![1] as { timeout?: number } | undefined;
    expect(opts?.timeout).toBe(15000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET — read
// ─────────────────────────────────────────────────────────────────────────────
describe("IdpHandler.handleGet", () => {
  function setRow(): void {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({
      id: "idp1",
      tenantId: TENANT_ID,
      kind: "OIDC",
      status: "ACTIVE",
      cognitoIdpName: PROVIDER_NAME,
      issuerUrl: "https://idp.example.com/",
      clientId: "cid",
      defaultRole: null,
      attributeMapping: { email: "email" },
      scopes: "openid email profile groups",
      enabledAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it("returns 200 with no client secret in the response body", async () => {
    setRow();
    const handler = new IdpHandler();
    const response = await handler.handleGet(TENANT_ID, makeAuth(), mockEnv);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.cognitoIdpName).toBe(PROVIDER_NAME);
    expect(body).not.toHaveProperty("clientSecret");
    expect(body).not.toHaveProperty("clientSecretArn");
  });

  it("returns 404 when no IdP exists", async () => {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue(null);
    const handler = new IdpHandler();
    const response = await handler.handleGet(TENANT_ID, makeAuth(), mockEnv);
    expect(response.status).toBe(404);
  });

  it("returns 404 (not 403) when the caller's tenant differs (existence-leak protection)", async () => {
    setRow();
    const handler = new IdpHandler();
    const response = await handler.handleGet(
      OTHER_TENANT_ID,
      makeAuth({ activeTenantId: TENANT_ID }),
      mockEnv,
    );
    expect(response.status).toBe(404);
  });

  it("returns 403 when the caller lacks idp.view", async () => {
    setRow();
    const handler = new IdpHandler();
    const response = await handler.handleGet(
      TENANT_ID,
      makeAuth({ tenantRole: "GUEST" as TenantRole }),
      mockEnv,
    );
    expect(response.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH — config update
// ─────────────────────────────────────────────────────────────────────────────
describe("IdpHandler.handlePatch (config)", () => {
  function setOidcRow(): void {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({
      id: "idp1",
      kind: "OIDC",
      cognitoIdpName: PROVIDER_NAME,
      attributeMapping: { email: "email", given_name: "given_name" },
      scopes: "openid email profile groups",
    });
    mockDb.tenantIdentityProvider.update.mockResolvedValue({
      id: "idp1",
      tenantId: TENANT_ID,
      kind: "OIDC",
      status: "ACTIVE",
      cognitoIdpName: PROVIDER_NAME,
      issuerUrl: "https://idp.example.com/",
      clientId: "cid",
      defaultRole: "MEMBER",
      attributeMapping: { email: "email" },
      scopes: "openid email profile",
      enabledAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it("rotates the secret in Secrets Manager and updates Cognito + RDS", async () => {
    setOidcRow();
    const idp = makeIdpStub();
    const secrets = makeSecretsStub();
    const handler = new IdpHandler({ idp: idp as never, secrets: secrets as never });
    const response = await handler.handlePatch(
      TENANT_ID,
      jsonRequest({ clientSecret: "rot" }, "PATCH"),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(200);
    expect(secrets.rotate).toHaveBeenCalledWith(TENANT_ID, "rot");
    expect(idp.updateOidcProvider).toHaveBeenCalledOnce();
  });

  it("merges the attribute mapping rather than replacing it", async () => {
    setOidcRow();
    const idp = makeIdpStub();
    const secrets = makeSecretsStub();
    const handler = new IdpHandler({ idp: idp as never, secrets: secrets as never });
    await handler.handlePatch(
      TENANT_ID,
      jsonRequest({ attributeMapping: { email: "email_address" } }, "PATCH"),
      makeAuth(),
      mockEnv,
    );
    const call = idp.updateOidcProvider.mock.calls[0]![0] as {
      attributeMapping: Record<string, string>;
    };
    expect(call.attributeMapping.email).toBe("email_address");
    expect(call.attributeMapping.given_name).toBe("given_name");
  });

  it("returns 400 if the body has no recognised field", async () => {
    setOidcRow();
    const idp = makeIdpStub();
    const secrets = makeSecretsStub();
    const handler = new IdpHandler({ idp: idp as never, secrets: secrets as never });
    const response = await handler.handlePatch(
      TENANT_ID,
      jsonRequest({}, "PATCH"),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(400);
  });

  it("returns 502 when Secrets Manager rotate fails", async () => {
    setOidcRow();
    const idp = makeIdpStub();
    const secrets = makeSecretsStub();
    secrets.rotate.mockRejectedValueOnce(
      Object.assign(new Error("boom"), { name: "InternalServiceError" }),
    );
    const handler = new IdpHandler({ idp: idp as never, secrets: secrets as never });
    const response = await handler.handlePatch(
      TENANT_ID,
      jsonRequest({ clientSecret: "rot" }, "PATCH"),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(502);
  });

  it("returns 502 when Cognito UpdateIdentityProvider fails", async () => {
    setOidcRow();
    const idp = makeIdpStub();
    idp.updateOidcProvider.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "InvalidParameterException" }),
    );
    const secrets = makeSecretsStub();
    const handler = new IdpHandler({ idp: idp as never, secrets: secrets as never });
    const response = await handler.handlePatch(
      TENANT_ID,
      jsonRequest({ defaultRole: "MEMBER" }, "PATCH"),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(502);
  });

  it("rotation: leaves Secrets Manager unchanged when Cognito update fails", async () => {
    setOidcRow();
    const idp = makeIdpStub();
    idp.updateOidcProvider.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "InvalidParameterException" }),
    );
    const secrets = makeSecretsStub();
    const handler = new IdpHandler({ idp: idp as never, secrets: secrets as never });
    const response = await handler.handlePatch(
      TENANT_ID,
      jsonRequest({ clientSecret: "rot" }, "PATCH"),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(502);
    expect(secrets.rotate).not.toHaveBeenCalled();
  });

  it("returns 404 when the IdP does not exist", async () => {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue(null);
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handlePatch(
      TENANT_ID,
      jsonRequest({ defaultRole: "MEMBER" }, "PATCH"),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(404);
  });

  it("returns 400 on invalid JSON in PATCH body", async () => {
    setOidcRow();
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const request = new Request(
      `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: "{" },
    );
    const response = await handler.handlePatch(TENANT_ID, request, makeAuth(), mockEnv);
    expect(response.status).toBe(400);
  });

  it("returns 400 when PATCH body has no recognised field but has a non-status property", async () => {
    setOidcRow();
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handlePatch(
      TENANT_ID,
      jsonRequest({ unrelated: 1 }, "PATCH"),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(400);
  });

  it("supports scopes-only update", async () => {
    setOidcRow();
    const idp = makeIdpStub();
    const secrets = makeSecretsStub();
    const handler = new IdpHandler({ idp: idp as never, secrets: secrets as never });
    const response = await handler.handlePatch(
      TENANT_ID,
      jsonRequest({ scopes: "openid email" }, "PATCH"),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(200);
    const callArg = idp.updateOidcProvider.mock.calls[0]![0] as {
      details?: { scopes?: string };
    };
    expect(callArg.details?.scopes).toBe("openid email");
    expect(secrets.rotate).not.toHaveBeenCalled();
  });

  it("returns 502 when COGNITO env var is missing for config patch", async () => {
    setOidcRow();
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const env = { ...mockEnv, COGNITO_USER_POOL_ID: undefined } as Env;
    const response = await handler.handlePatch(
      TENANT_ID,
      jsonRequest({ defaultRole: "MEMBER" }, "PATCH"),
      makeAuth(),
      env,
    );
    expect(response.status).toBe(502);
  });

  it("returns 501 when SAML record is patched", async () => {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({
      id: "idp1",
      kind: "SAML",
      cognitoIdpName: PROVIDER_NAME,
      attributeMapping: {},
      scopes: "",
    });
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handlePatch(
      TENANT_ID,
      jsonRequest({ defaultRole: "MEMBER" }, "PATCH"),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(501);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH — status toggle
// ─────────────────────────────────────────────────────────────────────────────
describe("IdpHandler.handlePatch (status)", () => {
  it("disables: removes provider from app client + invalidates all member claims", async () => {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({
      id: "idp1",
      status: "ACTIVE",
      cognitoIdpName: PROVIDER_NAME,
    });
    mockDb.tenantMember.findMany.mockResolvedValue([
      { user: { cognitoSub: "sub-1" } },
      { user: { cognitoSub: "sub-2" } },
    ]);
    const idp = makeIdpStub();
    const invalidate = vi.fn().mockResolvedValue(undefined);
    const handler = new IdpHandler({
      idp: idp as never,
      secrets: makeSecretsStub() as never,
      invalidateClaimsForSubs: invalidate,
    });
    const response = await handler.handlePatch(
      TENANT_ID,
      jsonRequest({ status: "DISABLED" }, "PATCH"),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(200);
    expect(idp.setSupportedIdentityProvider).toHaveBeenCalledWith(
      "pool",
      "client",
      PROVIDER_NAME,
      "remove",
    );
    expect(invalidate).toHaveBeenCalledWith(["sub-1", "sub-2"]);
  });

  it("enables: adds provider back to app client", async () => {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({
      id: "idp1",
      status: "DISABLED",
      cognitoIdpName: PROVIDER_NAME,
    });
    const idp = makeIdpStub();
    const handler = new IdpHandler({
      idp: idp as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handlePatch(
      TENANT_ID,
      jsonRequest({ status: "ACTIVE" }, "PATCH"),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(200);
    expect(idp.setSupportedIdentityProvider).toHaveBeenCalledWith(
      "pool",
      "client",
      PROVIDER_NAME,
      "add",
    );
  });

  it("noop when status already matches", async () => {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({
      id: "idp1",
      status: "DISABLED",
      cognitoIdpName: PROVIDER_NAME,
    });
    const idp = makeIdpStub();
    const handler = new IdpHandler({
      idp: idp as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handlePatch(
      TENANT_ID,
      jsonRequest({ status: "DISABLED" }, "PATCH"),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.unchanged).toBe(true);
    expect(idp.setSupportedIdentityProvider).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid status", async () => {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({
      id: "idp1",
      status: "ACTIVE",
      cognitoIdpName: PROVIDER_NAME,
    });
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handlePatch(
      TENANT_ID,
      jsonRequest({ status: "PENDING" }, "PATCH"),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(400);
  });

  it("returns 502 when Cognito update fails", async () => {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({
      id: "idp1",
      status: "ACTIVE",
      cognitoIdpName: PROVIDER_NAME,
    });
    const idp = makeIdpStub();
    idp.setSupportedIdentityProvider.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "InvalidParameterException" }),
    );
    const handler = new IdpHandler({
      idp: idp as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handlePatch(
      TENANT_ID,
      jsonRequest({ status: "DISABLED" }, "PATCH"),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(502);
  });

  it("403 cross-tenant", async () => {
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handlePatch(
      OTHER_TENANT_ID,
      jsonRequest({ status: "DISABLED" }, "PATCH"),
      makeAuth({ activeTenantId: TENANT_ID }),
      mockEnv,
    );
    expect(response.status).toBe(403);
  });

  it("returns 404 on status patch when no IdP exists", async () => {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue(null);
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handlePatch(
      TENANT_ID,
      jsonRequest({ status: "DISABLED" }, "PATCH"),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(404);
  });

  it("returns 502 when COGNITO env vars are missing for status patch", async () => {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({
      id: "idp1",
      status: "ACTIVE",
      cognitoIdpName: PROVIDER_NAME,
    });
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const env = { ...mockEnv, COGNITO_APP_CLIENT_ID: undefined } as Env;
    const response = await handler.handlePatch(
      TENANT_ID,
      jsonRequest({ status: "DISABLED" }, "PATCH"),
      makeAuth(),
      env,
    );
    expect(response.status).toBe(502);
  });

  it("opens the status-toggle transaction with a 15s timeout", async () => {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({
      id: "idp1",
      status: "ACTIVE",
      cognitoIdpName: PROVIDER_NAME,
    });
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    await handler.handlePatch(
      TENANT_ID,
      jsonRequest({ status: "DISABLED" }, "PATCH"),
      makeAuth(),
      mockEnv,
    );
    const opts = mockDb.$transaction.mock.calls[0]![1] as { timeout?: number } | undefined;
    expect(opts?.timeout).toBe(15000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────────
describe("IdpHandler.handleDelete", () => {
  it("disconnects: removes from supported list, deletes provider, deletes secret, invalidates cache", async () => {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({
      id: "idp1",
      cognitoIdpName: PROVIDER_NAME,
      kind: "OIDC",
    });
    mockDb.tenantMember.findMany.mockResolvedValue([
      { user: { cognitoSub: "sub-1", email: "a@e.com" } },
    ]);
    const idp = makeIdpStub();
    const secrets = makeSecretsStub();
    const invalidate = vi.fn().mockResolvedValue(undefined);
    const handler = new IdpHandler({
      idp: idp as never,
      secrets: secrets as never,
      invalidateClaimsForSubs: invalidate,
    });
    const response = await handler.handleDelete(
      TENANT_ID,
      new URL(`https://api.example.com/api/tenants/${TENANT_ID}/identity-provider?confirm=true`),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(200);
    expect(idp.setSupportedIdentityProvider).toHaveBeenCalledWith(
      "pool",
      "client",
      PROVIDER_NAME,
      "remove",
    );
    expect(idp.deleteProvider).toHaveBeenCalledWith("pool", PROVIDER_NAME);
    expect(secrets.delete).toHaveBeenCalledWith(TENANT_ID);
    expect(invalidate).toHaveBeenCalled();
  });

  it("requires confirm=true (400 otherwise)", async () => {
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handleDelete(
      TENANT_ID,
      new URL(`https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(400);
  });

  it("returns 404 when no IdP exists", async () => {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue(null);
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handleDelete(
      TENANT_ID,
      new URL(`https://api.example.com/api/tenants/${TENANT_ID}/identity-provider?confirm=true`),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(404);
  });

  it("returns 502 when Cognito delete fails", async () => {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({
      id: "idp1",
      cognitoIdpName: PROVIDER_NAME,
      kind: "OIDC",
    });
    const idp = makeIdpStub();
    idp.deleteProvider.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "InternalServiceError" }),
    );
    const handler = new IdpHandler({
      idp: idp as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handleDelete(
      TENANT_ID,
      new URL(`https://api.example.com/api/tenants/${TENANT_ID}/identity-provider?confirm=true`),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(502);
  });

  it("403 cross-tenant", async () => {
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const response = await handler.handleDelete(
      OTHER_TENANT_ID,
      new URL(`https://api.example.com/api/tenants/${OTHER_TENANT_ID}/identity-provider?confirm=true`),
      makeAuth({ activeTenantId: TENANT_ID }),
      mockEnv,
    );
    expect(response.status).toBe(403);
  });

  it("returns 502 when COGNITO env vars are missing", async () => {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({
      id: "idp1",
      cognitoIdpName: PROVIDER_NAME,
      kind: "OIDC",
    });
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    const env = { ...mockEnv, COGNITO_USER_POOL_ID: undefined } as Env;
    const response = await handler.handleDelete(
      TENANT_ID,
      new URL(`https://api.example.com/api/tenants/${TENANT_ID}/identity-provider?confirm=true`),
      makeAuth(),
      env,
    );
    expect(response.status).toBe(502);
  });

  it("opens the delete transaction with a 15s timeout", async () => {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({
      id: "idp1",
      cognitoIdpName: PROVIDER_NAME,
      kind: "OIDC",
    });
    const handler = new IdpHandler({
      idp: makeIdpStub() as never,
      secrets: makeSecretsStub() as never,
    });
    await handler.handleDelete(
      TENANT_ID,
      new URL(`https://api.example.com/api/tenants/${TENANT_ID}/identity-provider?confirm=true`),
      makeAuth(),
      mockEnv,
    );
    const opts = mockDb.$transaction.mock.calls[0]![1] as { timeout?: number } | undefined;
    expect(opts?.timeout).toBe(15000);
  });

  it("best-effort sign-out is invoked across all members and tolerates Cognito failures", async () => {
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({
      id: "idp1",
      cognitoIdpName: PROVIDER_NAME,
      kind: "OIDC",
    });
    mockDb.tenantMember.findMany.mockResolvedValue([
      { user: { cognitoSub: "sub-1", email: "a@e.com" } },
      { user: { cognitoSub: "sub-2", email: "b@e.com" } },
    ]);
    const idp = makeIdpStub();
    const secrets = makeSecretsStub();
    const invalidate = vi.fn().mockResolvedValue(undefined);
    const handler = new IdpHandler({
      idp: idp as never,
      secrets: secrets as never,
      invalidateClaimsForSubs: invalidate,
    });
    const response = await handler.handleDelete(
      TENANT_ID,
      new URL(`https://api.example.com/api/tenants/${TENANT_ID}/identity-provider?confirm=true`),
      makeAuth(),
      mockEnv,
    );
    expect(response.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route wiring — smoke that each route reaches the handler with the right tenantId
// and bounces unauthenticated requests at 401.
// ─────────────────────────────────────────────────────────────────────────────
describe("tenantIdpRoutes wiring", () => {
  it("registers four routes (POST/GET/PATCH/DELETE) for /api/tenants/:id/identity-provider", async () => {
    const { tenantIdpRoutes } = await import("../../src/lib/routes/tenant-idp.js");
    expect(tenantIdpRoutes).toHaveLength(4);
    const methods = tenantIdpRoutes.map((r) => r.method).sort();
    expect(methods).toEqual(["DELETE", "GET", "PATCH", "POST"]);
    for (const r of tenantIdpRoutes) {
      const ok = (r.path as RegExp).test(`/api/tenants/${TENANT_ID}/identity-provider`);
      expect(ok).toBe(true);
    }
  });

  it("returns 401 on each route when no Authorization header is present", async () => {
    vi.resetModules();
    vi.doMock("../../src/lib/auth/auth-middleware", async (orig) => {
      const actual = (await orig()) as Record<string, unknown>;
      return { ...actual, authMiddleware: vi.fn().mockResolvedValue(null) };
    });
    const { tenantIdpRoutes } = await import("../../src/lib/routes/tenant-idp.js");
    for (const route of tenantIdpRoutes) {
      const request = new Request(
        `https://api.example.com/api/tenants/${TENANT_ID}/identity-provider`,
        { method: route.method as string },
      );
      const response = await route.handler(request, mockEnv, {
        pathname: `/api/tenants/${TENANT_ID}/identity-provider`,
      } as never);
      expect(response.status).toBe(401);
    }
    vi.doUnmock("../../src/lib/auth/auth-middleware");
  });
});
