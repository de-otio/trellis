/**
 * Unit tests for the PreTokenGeneration Lambda (T2 — Cognito Lambda Triggers).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockSecretsSend,
  mockGetSecret,
  mockUserFindUnique,
  mockTenantMemberFindMany,
  mockTenantMemberUpdate,
  mockRoleMappingFindMany,
  mockIdpFindUnique,
  mockDdbSend,
} = vi.hoisted(() => ({
  mockSecretsSend: vi.fn(),
  mockGetSecret: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockTenantMemberFindMany: vi.fn(),
  mockTenantMemberUpdate: vi.fn(),
  mockRoleMappingFindMany: vi.fn(),
  mockIdpFindUnique: vi.fn(),
  mockDdbSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-secrets-manager", () => {
  const SecretsManagerClient = vi.fn();
  SecretsManagerClient.prototype.send = mockSecretsSend;
  return {
    SecretsManagerClient,
    GetSecretValueCommand: vi.fn(function (this: any, input: any) {
      this.input = input;
    }),
  };
});

// The DB secret is now fetched via AWS Lambda Powertools getSecret (with
// transform:"json"), which returns the PARSED secret object directly.
vi.mock("@aws-lambda-powertools/parameters/secrets", () => ({
  getSecret: mockGetSecret,
}));

vi.mock("@aws-sdk/client-dynamodb", () => {
  const DynamoDBClient = vi.fn();
  DynamoDBClient.prototype.send = mockDdbSend;
  return {
    DynamoDBClient,
    GetItemCommand: vi.fn(function (this: any, input: any) {
      this.input = input;
      this.kind = "GET";
    }),
    PutItemCommand: vi.fn(function (this: any, input: any) {
      this.input = input;
      this.kind = "PUT";
    }),
    DeleteItemCommand: vi.fn(function (this: any, input: any) {
      this.input = input;
      this.kind = "DEL";
    }),
  };
});

vi.mock("@aws-sdk/util-dynamodb", () => ({
  marshall: vi.fn((obj: any) => {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") out[k] = { S: v };
      else if (typeof v === "number") out[k] = { N: String(v) };
    }
    return out;
  }),
  unmarshall: vi.fn((item: any) => {
    const out: any = {};
    for (const [k, v] of Object.entries(item) as any) {
      if (v.S !== undefined) out[k] = v.S;
      else if (v.N !== undefined) out[k] = parseInt(v.N, 10);
    }
    return out;
  }),
}));

vi.mock("@prisma/client", () => {
  const PrismaClient = vi.fn(function (this: any) {
    this.user = { findUnique: mockUserFindUnique };
    this.tenantMember = {
      findMany: mockTenantMemberFindMany,
      update: mockTenantMemberUpdate,
    };
    this.tenantRoleMapping = { findMany: mockRoleMappingFindMany };
    this.tenantIdentityProvider = { findUnique: mockIdpFindUnique };
  });
  return { PrismaClient };
});

function freshClaimsItem(overrides: Record<string, any> = {}) {
  const ttl = Math.floor(Date.now() / 1000) + 1800;
  return {
    Item: {
      pk: { S: "claims:cognito-sub-abc123" },
      sk: { S: "meta" },
      userId: { S: "u_clxxx" },
      globalRole: { S: "B2B_PARTNER" },
      activeTenantId: { S: "t_org" },
      tenantSlug: { S: "acme" },
      tenantRole: { S: "MEMBER" },
      handle: { S: "alice" },
      ttl: { N: String(ttl) },
      ...overrides,
    },
  };
}

function makeEvent(opts: { idpGroups?: string; identities?: string } = {}) {
  const attrs: Record<string, string> = { sub: "cognito-sub-abc123" };
  if (opts.idpGroups !== undefined) attrs["custom:idpGroups"] = opts.idpGroups;
  if (opts.identities !== undefined) attrs["identities"] = opts.identities;
  return {
    userName: "cognito-sub-abc123",
    request: { userAttributes: attrs },
    response: {},
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env.AWS_REGION = "eu-central-1";
  process.env.DB_SECRET_ARN = "arn:aws:secretsmanager:eu-central-1:123:secret:db";
  process.env.DYNAMODB_TABLE = "dev-trellis";

  mockSecretsSend.mockResolvedValue({
    SecretString: JSON.stringify({
      username: "u",
      password: "p",
      host: "h",
      port: 5432,
      dbname: "d",
    }),
  });
  // getSecret(arn, { transform: "json" }) returns the parsed credentials.
  mockGetSecret.mockResolvedValue({
    username: "u",
    password: "p",
    host: "h",
    port: 5432,
    dbname: "d",
  });
  mockDdbSend.mockResolvedValue({ Item: undefined });
  mockUserFindUnique.mockResolvedValue(null);
  mockTenantMemberFindMany.mockResolvedValue([]);
  mockTenantMemberUpdate.mockResolvedValue({});
  mockRoleMappingFindMany.mockResolvedValue([]);
  mockIdpFindUnique.mockResolvedValue(null);
});

async function loadHandler() {
  const mod = await import("../../src/lambda/pre-token-generation.js");
  return mod.handler;
}

describe("PreTokenGeneration — cache hit", () => {
  it("returns cached claims without RDS lookup", async () => {
    mockDdbSend.mockResolvedValueOnce(freshClaimsItem());
    const handler = await loadHandler();
    const event = makeEvent();
    const result = await handler(event, {} as any, () => {});
    expect(mockUserFindUnique).not.toHaveBeenCalled();
    expect(
      result!.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!
        .claimsToAddOrOverride,
    ).toEqual({
      "custom:userId": "u_clxxx",
      "custom:globalRole": "B2B_PARTNER",
      "custom:activeTenantId": "t_org",
      "custom:tenantSlug": "acme",
      "custom:tenantRole": "MEMBER",
      "custom:handle": "alice",
    });
  });

  it("does NOT write to cache on a hit (no refresh)", async () => {
    mockDdbSend.mockResolvedValueOnce(freshClaimsItem());
    const handler = await loadHandler();
    await handler(makeEvent(), {} as any, () => {});
    const puts = mockDdbSend.mock.calls.filter((c) => c[0].kind === "PUT");
    expect(puts.length).toBe(0);
  });
});

describe("PreTokenGeneration — cache miss", () => {
  it("queries RDS and writes the cache", async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });
    mockUserFindUnique.mockResolvedValueOnce({
      id: "u_clxxx",
      role: "END_USER",
      handle: "alice",
      suspendedAt: null,
      personalTenantId: "t_personal",
    });
    mockTenantMemberFindMany.mockResolvedValueOnce([
      {
        tenantId: "t_personal",
        role: "OWNER",
        tenant: {
          id: "t_personal",
          slug: "personal-u_clxxx",
          status: "ACTIVE",
          type: "PERSONAL",
        },
      },
    ]);
    mockDdbSend.mockResolvedValueOnce({});

    const handler = await loadHandler();
    const event = makeEvent();
    const result = await handler(event, {} as any, () => {});

    expect(mockUserFindUnique).toHaveBeenCalledTimes(1);
    const claims =
      result!.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!
        .claimsToAddOrOverride;
    expect(claims["custom:userId"]).toBe("u_clxxx");
    expect(claims["custom:activeTenantId"]).toBe("t_personal");
    expect(claims["custom:tenantSlug"]).toBe("personal-u_clxxx");
    expect(claims["custom:tenantRole"]).toBe("OWNER");
    const puts = mockDdbSend.mock.calls.filter((c) => c[0].kind === "PUT");
    expect(puts.length).toBe(1);
  });

  it("prefers an active ORGANIZATION tenant for federated users", async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });
    mockUserFindUnique.mockResolvedValueOnce({
      id: "u_clxxx",
      role: "B2B_PARTNER",
      handle: "alice",
      suspendedAt: null,
      personalTenantId: "t_personal",
    });
    mockTenantMemberFindMany.mockResolvedValueOnce([
      {
        tenantId: "t_personal",
        role: "OWNER",
        tenant: { id: "t_personal", slug: "personal-u", status: "ACTIVE", type: "PERSONAL" },
      },
      {
        tenantId: "t_org",
        role: "ADMIN",
        tenant: { id: "t_org", slug: "acme", status: "ACTIVE", type: "ORGANIZATION" },
      },
    ]);
    mockDdbSend.mockResolvedValueOnce({});

    const handler = await loadHandler();
    const result = await handler(
      makeEvent({ identities: JSON.stringify([{ providerName: "tenant-acme" }]) }),
      {} as any,
      () => {},
    );
    const claims =
      result!.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!
        .claimsToAddOrOverride;
    expect(claims["custom:activeTenantId"]).toBe("t_org");
    expect(claims["custom:tenantSlug"]).toBe("acme");
  });

  it("returns sentinel claims and does not throw on user drift", async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });
    mockUserFindUnique.mockResolvedValueOnce(null);
    const handler = await loadHandler();
    const result = await handler(makeEvent(), {} as any, () => {});
    const claims =
      result!.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!
        .claimsToAddOrOverride;
    expect(claims["custom:userId"]).toBe("");
    expect(claims["custom:activeTenantId"]).toBe("");
    expect(claims["custom:tenantRole"]).toBe("");
    const puts = mockDdbSend.mock.calls.filter((c) => c[0].kind === "PUT");
    expect(puts.length).toBe(0);
  });

  it("returns sentinel claims for a suspended user (suspended=true, past timestamp)", async () => {
    // C1 regression: real-world data sets `suspended: true` and
    // `suspendedAt = new Date()` (always a past value when read). The
    // earlier check `suspendedAt > now` was inverted and let suspended
    // users keep issuing tokens.
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });
    mockUserFindUnique.mockResolvedValueOnce({
      id: "u_clxxx",
      role: "END_USER",
      handle: "alice",
      suspended: true,
      suspendedAt: new Date(Date.now() - 60_000),
      personalTenantId: "t_personal",
    });
    const handler = await loadHandler();
    const result = await handler(makeEvent(), {} as any, () => {});
    const claims =
      result!.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!
        .claimsToAddOrOverride;
    expect(claims["custom:userId"]).toBe("");
  });

  it("returns sentinel when suspendedAt set but suspended=false (defense-in-depth)", async () => {
    // Either signal alone blocks issuance — protects against a writer
    // that forgets to set both columns.
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });
    mockUserFindUnique.mockResolvedValueOnce({
      id: "u_clxxx",
      role: "END_USER",
      handle: "alice",
      suspended: false,
      suspendedAt: new Date(Date.now() - 60_000),
      personalTenantId: "t_personal",
    });
    const handler = await loadHandler();
    const result = await handler(makeEvent(), {} as any, () => {});
    const claims =
      result!.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!
        .claimsToAddOrOverride;
    expect(claims["custom:userId"]).toBe("");
  });

  it("returns sentinel when suspended=true but suspendedAt is null", async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });
    mockUserFindUnique.mockResolvedValueOnce({
      id: "u_clxxx",
      role: "END_USER",
      handle: "alice",
      suspended: true,
      suspendedAt: null,
      personalTenantId: "t_personal",
    });
    const handler = await loadHandler();
    const result = await handler(makeEvent(), {} as any, () => {});
    const claims =
      result!.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!
        .claimsToAddOrOverride;
    expect(claims["custom:userId"]).toBe("");
  });

  it("treats expired cache TTL as a miss", async () => {
    const stale = Math.floor(Date.now() / 1000) - 100;
    mockDdbSend.mockResolvedValueOnce({
      Item: {
        pk: { S: "claims:cognito-sub-abc123" },
        sk: { S: "meta" },
        userId: { S: "u_old" },
        globalRole: { S: "END_USER" },
        activeTenantId: { S: "t_old" },
        tenantSlug: { S: "old" },
        tenantRole: { S: "MEMBER" },
        handle: { S: "old" },
        ttl: { N: String(stale) },
      },
    });
    mockUserFindUnique.mockResolvedValueOnce({
      id: "u_new",
      role: "END_USER",
      handle: "new",
      suspendedAt: null,
      personalTenantId: "t_new",
    });
    mockTenantMemberFindMany.mockResolvedValueOnce([
      {
        tenantId: "t_new",
        role: "OWNER",
        tenant: { id: "t_new", slug: "personal-new", status: "ACTIVE", type: "PERSONAL" },
      },
    ]);
    mockDdbSend.mockResolvedValueOnce({});

    const handler = await loadHandler();
    const result = await handler(makeEvent(), {} as any, () => {});
    expect(mockUserFindUnique).toHaveBeenCalled();
    const claims =
      result!.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!
        .claimsToAddOrOverride;
    expect(claims["custom:userId"]).toBe("u_new");
  });
});

describe("PreTokenGeneration — federated role refresh", () => {
  it("re-resolves role from current idpGroups on every issuance", async () => {
    mockDdbSend.mockResolvedValueOnce(freshClaimsItem());
    mockRoleMappingFindMany.mockResolvedValueOnce([
      { idpGroupName: "trellis-admins", tenantRole: "ADMIN", priority: 10 },
    ]);
    mockIdpFindUnique.mockResolvedValueOnce({ status: "ACTIVE", defaultRole: "MEMBER" });
    mockTenantMemberUpdate.mockResolvedValueOnce({});
    mockDdbSend.mockResolvedValueOnce({});

    const handler = await loadHandler();
    const result = await handler(
      makeEvent({
        identities: JSON.stringify([{ providerName: "tenant-acme" }]),
        idpGroups: "trellis-admins",
      }),
      {} as any,
      () => {},
    );

    const claims =
      result!.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!
        .claimsToAddOrOverride;
    expect(claims["custom:tenantRole"]).toBe("ADMIN");
    expect(mockTenantMemberUpdate).toHaveBeenCalledWith({
      where: { tenantId_userId: { tenantId: "t_org", userId: "u_clxxx" } },
      data: { role: "ADMIN" },
    });
    const puts = mockDdbSend.mock.calls.filter((c) => c[0].kind === "PUT");
    expect(puts.length).toBe(1);
  });

  it("does NOT refresh when idpGroups absent (defaults applied)", async () => {
    mockDdbSend.mockResolvedValueOnce(freshClaimsItem());
    const handler = await loadHandler();
    const result = await handler(
      makeEvent({ identities: JSON.stringify([{ providerName: "tenant-acme" }]) }),
      {} as any,
      () => {},
    );
    expect(mockRoleMappingFindMany).not.toHaveBeenCalled();
    expect(mockTenantMemberUpdate).not.toHaveBeenCalled();
    const claims =
      result!.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!
        .claimsToAddOrOverride;
    expect(claims["custom:tenantRole"]).toBe("MEMBER");
  });

  it("does NOT refresh for non-federated users even when claims have idpGroups", async () => {
    mockDdbSend.mockResolvedValueOnce(freshClaimsItem());
    const handler = await loadHandler();
    await handler(makeEvent({ idpGroups: "trellis-admins" }), {} as any, () => {});
    expect(mockRoleMappingFindMany).not.toHaveBeenCalled();
  });

  it("ignores refresh when IdP is not ACTIVE", async () => {
    mockDdbSend.mockResolvedValueOnce(freshClaimsItem());
    mockRoleMappingFindMany.mockResolvedValueOnce([
      { idpGroupName: "trellis-admins", tenantRole: "ADMIN", priority: 10 },
    ]);
    mockIdpFindUnique.mockResolvedValueOnce({ status: "DISABLED", defaultRole: "MEMBER" });

    const handler = await loadHandler();
    const result = await handler(
      makeEvent({
        identities: JSON.stringify([{ providerName: "tenant-acme" }]),
        idpGroups: "trellis-admins",
      }),
      {} as any,
      () => {},
    );
    expect(mockTenantMemberUpdate).not.toHaveBeenCalled();
    const claims =
      result!.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!
        .claimsToAddOrOverride;
    expect(claims["custom:tenantRole"]).toBe("MEMBER");
  });

  it("swallows refresh-path errors without failing the issuance", async () => {
    mockDdbSend.mockResolvedValueOnce(freshClaimsItem());
    mockRoleMappingFindMany.mockRejectedValueOnce(new Error("RDS down"));
    const handler = await loadHandler();
    const result = await handler(
      makeEvent({
        identities: JSON.stringify([{ providerName: "tenant-acme" }]),
        idpGroups: "trellis-admins",
      }),
      {} as any,
      () => {},
    );
    const claims =
      result!.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!
        .claimsToAddOrOverride;
    expect(claims["custom:tenantRole"]).toBe("MEMBER");
  });

  it("does NOT promote claims to refreshed role when DB persist fails (G2 H2)", async () => {
    // Cached claim is MEMBER. Resolver wants ADMIN. The TenantMember.update
    // throws (transient DB blip). The JWT must continue to carry MEMBER —
    // promoting it to ADMIN here would oscillate the user's effective role
    // between cached-old (MEMBER) and JWT-new (ADMIN) on alternating refreshes.
    mockDdbSend.mockResolvedValueOnce(freshClaimsItem());
    mockRoleMappingFindMany.mockResolvedValueOnce([
      { idpGroupName: "trellis-admins", tenantRole: "ADMIN", priority: 10 },
    ]);
    mockIdpFindUnique.mockResolvedValueOnce({ status: "ACTIVE", defaultRole: "MEMBER" });
    mockTenantMemberUpdate.mockRejectedValueOnce(new Error("DB connection lost"));

    const handler = await loadHandler();
    const result = await handler(
      makeEvent({
        identities: JSON.stringify([{ providerName: "tenant-acme" }]),
        idpGroups: "trellis-admins",
      }),
      {} as any,
      () => {},
    );

    const claims =
      result!.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!
        .claimsToAddOrOverride;
    expect(claims["custom:tenantRole"]).toBe("MEMBER");
    // No DDB cache write when the persist failed.
    const puts = mockDdbSend.mock.calls.filter((c) => c[0].kind === "PUT");
    expect(puts.length).toBe(0);
  });

  it("skips refresh when resolved role equals current role", async () => {
    mockDdbSend.mockResolvedValueOnce(freshClaimsItem());
    mockRoleMappingFindMany.mockResolvedValueOnce([
      { idpGroupName: "trellis-employees", tenantRole: "MEMBER", priority: 100 },
    ]);
    mockIdpFindUnique.mockResolvedValueOnce({ status: "ACTIVE", defaultRole: "MEMBER" });
    const handler = await loadHandler();
    await handler(
      makeEvent({
        identities: JSON.stringify([{ providerName: "tenant-acme" }]),
        idpGroups: "trellis-employees",
      }),
      {} as any,
      () => {},
    );
    expect(mockTenantMemberUpdate).not.toHaveBeenCalled();
  });
});

describe("PreTokenGeneration — federation detection", () => {
  it("treats invalid identities JSON as native (no role refresh) — G2 M2", async () => {
    // Malformed `identities` is not a federation signal we can act on.
    // Returning false avoids running the org-tenant role-resolution path
    // for what is effectively an indeterminate case.
    mockDdbSend.mockResolvedValueOnce(freshClaimsItem());
    const handler = await loadHandler();
    await handler(
      makeEvent({ identities: "not-json", idpGroups: "trellis-admins" }),
      {} as any,
      () => {},
    );
    expect(mockRoleMappingFindMany).not.toHaveBeenCalled();
  });

  it("treats empty identities JSON array as native (no refresh)", async () => {
    mockDdbSend.mockResolvedValueOnce(freshClaimsItem());
    const handler = await loadHandler();
    await handler(
      makeEvent({ identities: "[]", idpGroups: "trellis-admins" }),
      {} as any,
      () => {},
    );
    expect(mockRoleMappingFindMany).not.toHaveBeenCalled();
  });
});
