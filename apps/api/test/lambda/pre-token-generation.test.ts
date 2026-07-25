/**
 * Unit tests for the PreTokenGeneration Lambda (T2 — Cognito Lambda Triggers).
 *
 * Cache assertions are by OUTCOME against an injected `MemoryKvStore`-backed
 * `ClaimsCache` (WS-1 §3.6): reads/writes now happen inside
 * `@de-otio/saas-foundation`'s `KvStore` port, so a raw `@aws-sdk/client-dynamodb`
 * mock no longer observes them. We seed hits via `cache.put(...)`, treat an empty
 * store (or an expired entry) as a miss, and assert writes with `cache.get(...)`
 * plus a spy on the injected store's `putIfFresher` (the port's write primitive).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaimsCache, type CachedClaims } from "../../src/lib/auth/claims-cache.js";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";

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

// WS-2 §5.3: lambda-prisma resolves the DB secret via the foundation secrets
// port now (resolveSecret returns the raw JSON bytes as a Buffer).
vi.mock("@de-otio/saas-foundation/secrets", () => ({
  resolveSecret: mockGetSecret,
  resolveParameter: vi.fn(),
  secretRef: vi.fn((arn) => ({ arn })),
  SecretCache: class {
    get() {
      return null;
    }
    set() {}
    invalidate() {}
    clear() {}
  },
}));

// Kept so the module's (unused-in-tests) DynamoDB default path resolves without
// touching a real client. Claims reads/writes are asserted via the injected
// MemoryKvStore, not this mock.
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

const SUB = "cognito-sub-abc123";

/**
 * The claims a fresh cache hit carries — the outcome-equivalent of the old
 * `freshClaimsItem()` DynamoDB shape. `ClaimsCache` keys on the `sub` verbatim.
 */
const FRESH_CLAIMS: CachedClaims = {
  userId: "u_clxxx",
  globalRole: "B2B_PARTNER",
  activeTenantId: "t_org",
  tenantSlug: "acme",
  tenantRole: "MEMBER",
  handle: "alice",
};

function makeEvent(opts: { idpGroups?: string; identities?: string } = {}) {
  const attrs: Record<string, string> = { sub: SUB };
  if (opts.idpGroups !== undefined) attrs["custom:idpGroups"] = opts.idpGroups;
  if (opts.identities !== undefined) attrs["identities"] = opts.identities;
  return {
    userName: SUB,
    request: { userAttributes: attrs },
    response: {},
  } as any;
}

// Injected per-test: a MemoryKvStore-backed ClaimsCache the handler reads/writes.
let store: MemoryKvStore;
let cache: ClaimsCache;
let setClaimsCache: (c: ClaimsCache | null) => void;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env.AWS_REGION = "eu-central-1";
  process.env.DB_SECRET_ARN = "arn:aws:secretsmanager:eu-central-1:123:secret:db";
  process.env.DYNAMODB_TABLE = "dev-trellis";
  // Read-after-write retry knobs: a known retry budget and a zero backoff so
  // the retry-path tests run instantly (real default is 150ms between tries).
  process.env.PRETOKEN_RDS_RETRY_MAX = "4";
  process.env.PRETOKEN_RDS_RETRY_DELAY_MS = "0";

  mockSecretsSend.mockResolvedValue({
    SecretString: JSON.stringify({
      username: "u",
      password: "p",
      host: "h",
      port: 5432,
      dbname: "d",
    }),
  });
  // The foundation resolver returns the credential JSON as bytes.
  mockGetSecret.mockResolvedValue(
    Buffer.from(
      JSON.stringify({ username: "u", password: "p", host: "h", port: 5432, dbname: "d" }),
      "utf-8",
    ),
  );
  mockDdbSend.mockResolvedValue({ Item: undefined });
  mockUserFindUnique.mockResolvedValue(null);
  mockTenantMemberFindMany.mockResolvedValue([]);
  mockTenantMemberUpdate.mockResolvedValue({});
  mockRoleMappingFindMany.mockResolvedValue([]);
  mockIdpFindUnique.mockResolvedValue(null);

  // Inject a MemoryKvStore-backed ClaimsCache. Its clock and the module's
  // `Math.floor(Date.now()/1000)` share the real `Date.now`, so TTL decisions
  // agree. Import the module AFTER resetModules so loadHandler() (same call)
  // resolves the same instance and sees the injected cache.
  store = new MemoryKvStore({ now: () => Date.now() });
  cache = new ClaimsCache(store);
  const mod = await import("../../src/lambda/pre-token-generation.js");
  setClaimsCache = mod.__setClaimsCacheForTest;
  setClaimsCache(cache);
});

afterEach(() => {
  setClaimsCache(null);
});

async function loadHandler() {
  const mod = await import("../../src/lambda/pre-token-generation.js");
  return mod.handler;
}

describe("PreTokenGeneration — cache hit", () => {
  it("returns cached claims without RDS lookup", async () => {
    await cache.put(SUB, FRESH_CLAIMS, 1800);
    const handler = await loadHandler();
    const event = makeEvent();
    const result = await handler(event, {} as any, () => {});
    expect(mockUserFindUnique).not.toHaveBeenCalled();
    const expectedClaims = {
      "custom:userId": "u_clxxx",
      "custom:globalRole": "B2B_PARTNER",
      "custom:activeTenantId": "t_org",
      "custom:tenantSlug": "acme",
      "custom:tenantRole": "MEMBER",
      "custom:handle": "alice",
    };
    const details = result!.response.claimsAndScopeOverrideDetails!;
    // The API authenticates with the ID token, so the claims MUST be in it
    // (not just the access token).
    expect(details.idTokenGeneration!.claimsToAddOrOverride).toEqual(
      expectedClaims,
    );
    expect(details.accessTokenGeneration!.claimsToAddOrOverride).toEqual(
      expectedClaims,
    );
  });

  it("does NOT write to cache on a hit (no refresh)", async () => {
    await cache.put(SUB, FRESH_CLAIMS, 1800);
    // Spy AFTER seeding so only handler-initiated writes are counted.
    const putSpy = vi.spyOn(store, "putIfFresher");
    const handler = await loadHandler();
    await handler(makeEvent(), {} as any, () => {});
    expect(putSpy).not.toHaveBeenCalled();
    // The cached entry is served unchanged.
    expect(await cache.get(SUB)).toEqual(FRESH_CLAIMS);
  });
});

describe("PreTokenGeneration — cache miss", () => {
  it("queries RDS and writes the cache", async () => {
    // Empty store → miss.
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
    const putSpy = vi.spyOn(store, "putIfFresher");

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
    // The resolved claims were written back (empty store → now populated).
    expect(putSpy).toHaveBeenCalledTimes(1);
    const cached = await cache.get(SUB);
    expect(cached?.userId).toBe("u_clxxx");
    expect(cached?.activeTenantId).toBe("t_personal");
  });

  it("prefers an active ORGANIZATION tenant for federated users", async () => {
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
    mockUserFindUnique.mockResolvedValueOnce(null);
    const putSpy = vi.spyOn(store, "putIfFresher");
    const handler = await loadHandler();
    const result = await handler(makeEvent(), {} as any, () => {});
    const claims =
      result!.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!
        .claimsToAddOrOverride;
    expect(claims["custom:userId"]).toBe("");
    expect(claims["custom:activeTenantId"]).toBe("");
    expect(claims["custom:tenantRole"]).toBe("");
    // The drift sentinel is never cached.
    expect(putSpy).not.toHaveBeenCalled();
    expect(await cache.get(SUB)).toBeNull();
  });

  it("returns sentinel claims for a suspended user (suspended=true, past timestamp)", async () => {
    // C1 regression: real-world data sets `suspended: true` and
    // `suspendedAt = new Date()` (always a past value when read). The
    // earlier check `suspendedAt > now` was inverted and let suspended
    // users keep issuing tokens.
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
    // Seed an ALREADY-EXPIRED entry (negative ttl → expiresAt in the past). The
    // port's on-read expiry filter drops it, so `cache.get` returns null and the
    // handler falls through to RDS — the outcome-equivalent of the old stale-row.
    const stale: CachedClaims = {
      userId: "u_old",
      globalRole: "END_USER",
      activeTenantId: "t_old",
      tenantSlug: "old",
      tenantRole: "MEMBER",
      handle: "old",
    };
    await cache.put(SUB, stale, -100);
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

    const handler = await loadHandler();
    const result = await handler(makeEvent(), {} as any, () => {});
    expect(mockUserFindUnique).toHaveBeenCalled();
    const claims =
      result!.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!
        .claimsToAddOrOverride;
    expect(claims["custom:userId"]).toBe("u_new");
  });
});

describe("PreTokenGeneration — read-after-write race (RDS retry)", () => {
  it("retries the RDS lookup and recovers when the user row is not yet visible", async () => {
    // The brand-new signup's first token is minted before PostConfirmation's
    // provisioning transaction is visible: attempt 1 sees no row, attempt 2
    // does. The token MUST carry the real cuid, not the drift sentinel.
    mockUserFindUnique
      .mockResolvedValueOnce(null) // not yet committed
      .mockResolvedValueOnce({
        id: "u_clxxx",
        role: "END_USER",
        handle: "alice",
        suspended: false,
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
    const putSpy = vi.spyOn(store, "putIfFresher");

    const handler = await loadHandler();
    const result = await handler(makeEvent(), {} as any, () => {});

    expect(mockUserFindUnique.mock.calls.length).toBeGreaterThanOrEqual(2);
    const claims =
      result!.response.claimsAndScopeOverrideDetails!.idTokenGeneration!
        .claimsToAddOrOverride;
    expect(claims["custom:userId"]).toBe("u_clxxx");
    expect(claims["custom:activeTenantId"]).toBe("t_personal");
    // The recovered claims are cached so the next issuance is a clean hit.
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect((await cache.get(SUB))?.userId).toBe("u_clxxx");
  });

  it("falls through to the drift sentinel after exhausting RDS retries", async () => {
    // Genuine drift (post-RDS-restore): the row never appears. Behaviour is
    // unchanged from the single-shot case — empty claims, no cache write — but
    // now only after the bounded retry budget is spent.
    process.env.PRETOKEN_RDS_RETRY_MAX = "3";
    mockUserFindUnique.mockResolvedValue(null);
    const putSpy = vi.spyOn(store, "putIfFresher");

    const handler = await loadHandler();
    const result = await handler(makeEvent(), {} as any, () => {});

    expect(mockUserFindUnique.mock.calls.length).toBe(3);
    const claims =
      result!.response.claimsAndScopeOverrideDetails!.idTokenGeneration!
        .claimsToAddOrOverride;
    expect(claims["custom:userId"]).toBe("");
    expect(putSpy).not.toHaveBeenCalled();
    expect(await cache.get(SUB)).toBeNull();
  });

  it("treats a cached entry with an empty userId as a miss and recovers from RDS", async () => {
    // No path should ever cache an empty userId, but if one is ever present
    // (a poisoned/legacy row), serving it would mint a token with an empty
    // `custom:userId`. Defensive: treat it as a miss and fall back to RDS.
    await cache.put(SUB, { ...FRESH_CLAIMS, userId: "" }, 1800);
    mockUserFindUnique.mockResolvedValueOnce({
      id: "u_real",
      role: "END_USER",
      handle: "alice",
      suspended: false,
      suspendedAt: null,
      personalTenantId: "t_personal",
    });
    mockTenantMemberFindMany.mockResolvedValueOnce([
      {
        tenantId: "t_personal",
        role: "OWNER",
        tenant: {
          id: "t_personal",
          slug: "personal-u_real",
          status: "ACTIVE",
          type: "PERSONAL",
        },
      },
    ]);

    const handler = await loadHandler();
    const result = await handler(makeEvent(), {} as any, () => {});

    expect(mockUserFindUnique).toHaveBeenCalled();
    const claims =
      result!.response.claimsAndScopeOverrideDetails!.idTokenGeneration!
        .claimsToAddOrOverride;
    expect(claims["custom:userId"]).toBe("u_real");
  });
});

describe("PreTokenGeneration — federated role refresh", () => {
  it("re-resolves role from current idpGroups on every issuance", async () => {
    await cache.put(SUB, FRESH_CLAIMS, 1800);
    mockRoleMappingFindMany.mockResolvedValueOnce([
      { idpGroupName: "trellis-admins", tenantRole: "ADMIN", priority: 10 },
    ]);
    mockIdpFindUnique.mockResolvedValueOnce({ status: "ACTIVE", defaultRole: "MEMBER" });
    mockTenantMemberUpdate.mockResolvedValueOnce({});
    const putSpy = vi.spyOn(store, "putIfFresher");

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
    // The refreshed role was written back to the cache.
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect((await cache.get(SUB))?.tenantRole).toBe("ADMIN");
  });

  it("does NOT refresh when idpGroups absent (defaults applied)", async () => {
    await cache.put(SUB, FRESH_CLAIMS, 1800);
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
    await cache.put(SUB, FRESH_CLAIMS, 1800);
    const handler = await loadHandler();
    await handler(makeEvent({ idpGroups: "trellis-admins" }), {} as any, () => {});
    expect(mockRoleMappingFindMany).not.toHaveBeenCalled();
  });

  it("ignores refresh when IdP is not ACTIVE", async () => {
    await cache.put(SUB, FRESH_CLAIMS, 1800);
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
    await cache.put(SUB, FRESH_CLAIMS, 1800);
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
    await cache.put(SUB, FRESH_CLAIMS, 1800);
    mockRoleMappingFindMany.mockResolvedValueOnce([
      { idpGroupName: "trellis-admins", tenantRole: "ADMIN", priority: 10 },
    ]);
    mockIdpFindUnique.mockResolvedValueOnce({ status: "ACTIVE", defaultRole: "MEMBER" });
    mockTenantMemberUpdate.mockRejectedValueOnce(new Error("DB connection lost"));
    const putSpy = vi.spyOn(store, "putIfFresher");

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
    // No cache write when the persist failed; the entry keeps its MEMBER role.
    expect(putSpy).not.toHaveBeenCalled();
    expect((await cache.get(SUB))?.tenantRole).toBe("MEMBER");
  });

  it("skips refresh when resolved role equals current role", async () => {
    await cache.put(SUB, FRESH_CLAIMS, 1800);
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
    await cache.put(SUB, FRESH_CLAIMS, 1800);
    const handler = await loadHandler();
    await handler(
      makeEvent({ identities: "not-json", idpGroups: "trellis-admins" }),
      {} as any,
      () => {},
    );
    expect(mockRoleMappingFindMany).not.toHaveBeenCalled();
  });

  it("treats empty identities JSON array as native (no refresh)", async () => {
    await cache.put(SUB, FRESH_CLAIMS, 1800);
    const handler = await loadHandler();
    await handler(
      makeEvent({ identities: "[]", idpGroups: "trellis-admins" }),
      {} as any,
      () => {},
    );
    expect(mockRoleMappingFindMany).not.toHaveBeenCalled();
  });
});
