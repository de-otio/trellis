/**
 * Tenant Domain Handler Tests
 *
 * Covers all 4 endpoints + cross-tenant isolation + token expiry + rotation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainHandler } from "../../src/lib/tenant/domain-handler.js";
import { buildTwoTenantFixture } from "../_helpers/multi-tenant-fixture.js";
import type { Env } from "../../src/env.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { mockDb, mockKv } = vi.hoisted(() => ({
  mockDb: {
    tenantDomain: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    tenantIdentityProvider: {
      findUnique: vi.fn(),
    },
  },
  mockKv: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../../src/db", () => ({
  createPrisma: () => mockDb,
}));

const { mockVerifyDomainToken } = vi.hoisted(() => ({
  mockVerifyDomainToken: vi.fn(),
}));

vi.mock("../../src/lib/tenant/domain-verifier", () => ({
  verifyDomainToken: (...args: unknown[]) => mockVerifyDomainToken(...args),
}));

const mockEnv = {
  DATABASE_URL: "postgresql://test",
  RATE_LIMIT_KV: mockKv,
} as unknown as Env;

// ─── Fixture ──────────────────────────────────────────────────────────────────

const { tenantA, tenantB, authA, authB } = buildTwoTenantFixture();

function makeRequest(
  url: string,
  method = "GET",
  body?: unknown,
): Request {
  return new Request(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

const DOMAIN_ID = "domain-id-1";
const DOMAIN = "example.org";
const TOKEN = "abcdef1234567890abcdef1234567890";
const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000);
const PAST = new Date(Date.now() - 1000);

function mockDomainRecord(overrides: Partial<{
  id: string;
  tenantId: string;
  domain: string;
  verificationToken: string;
  tokenExpiresAt: Date;
  verifiedAt: Date | null;
  verifyAttemptedAt: Date | null;
  verifyAttempts: number;
  createdAt: Date;
}> = {}) {
  return {
    id: DOMAIN_ID,
    tenantId: tenantA.id,
    domain: DOMAIN,
    verificationToken: TOKEN,
    tokenExpiresAt: FUTURE,
    verifiedAt: null,
    verifyAttemptedAt: null,
    verifyAttempts: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

// ─── handleClaim ──────────────────────────────────────────────────────────────

describe("DomainHandler.handleClaim", () => {
  let handler: DomainHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new DomainHandler();
    mockKv.get.mockResolvedValue(null);
  });

  it("creates a new domain record and returns 201 with token", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(null);
    const record = mockDomainRecord();
    mockDb.tenantDomain.create.mockResolvedValue(record);

    const req = makeRequest("https://api/", "POST", { domain: DOMAIN });
    const res = await handler.handleClaim(tenantA.id, req, authA, mockEnv);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.domain).toBe(DOMAIN);
    expect(body.verificationToken).toBe(TOKEN);
    expect(body.txtRecord).toBe(`trellis-verify=${TOKEN}`);
    expect(body.txtHost).toBe(`_trellis-verify.${DOMAIN}`);
  });

  it("returns 200 idempotent when same tenant re-claims (not expired, not verified)", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(mockDomainRecord());

    const req = makeRequest("https://api/", "POST", { domain: DOMAIN });
    const res = await handler.handleClaim(tenantA.id, req, authA, mockEnv);

    expect(res.status).toBe(200);
    expect(mockDb.tenantDomain.create).not.toHaveBeenCalled();
  });

  it("rotates expired token on re-claim and returns 200", async () => {
    const expiredRecord = mockDomainRecord({ tokenExpiresAt: PAST });
    mockDb.tenantDomain.findUnique.mockResolvedValue(expiredRecord);
    const updatedRecord = mockDomainRecord({ verificationToken: "newtoken123" });
    mockDb.tenantDomain.update.mockResolvedValue(updatedRecord);

    const req = makeRequest("https://api/", "POST", { domain: DOMAIN });
    const res = await handler.handleClaim(tenantA.id, req, authA, mockEnv);

    expect(res.status).toBe(200);
    expect(mockDb.tenantDomain.update).toHaveBeenCalled();
  });

  it("returns 200 (not token) when domain is already verified by same tenant", async () => {
    const verifiedRecord = mockDomainRecord({ verifiedAt: new Date() });
    mockDb.tenantDomain.findUnique.mockResolvedValue(verifiedRecord);

    const req = makeRequest("https://api/", "POST", { domain: DOMAIN });
    const res = await handler.handleClaim(tenantA.id, req, authA, mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json();
    // Verified record should NOT expose the token
    expect(body.verificationToken).toBeUndefined();
  });

  it("returns 409 when domain is claimed by another tenant", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(
      mockDomainRecord({ tenantId: tenantB.id }),
    );

    const req = makeRequest("https://api/", "POST", { domain: DOMAIN });
    const res = await handler.handleClaim(tenantA.id, req, authA, mockEnv);

    expect(res.status).toBe(409);
    const body = await res.json();
    // Must not leak which tenant owns it
    expect(JSON.stringify(body)).not.toContain(tenantB.id);
  });

  it("returns 400 for public suffix domain", async () => {
    const req = makeRequest("https://api/", "POST", { domain: "co.uk" });
    const res = await handler.handleClaim(tenantA.id, req, authA, mockEnv);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("PUBLIC_SUFFIX");
  });

  it("returns 400 for invalid domain", async () => {
    const req = makeRequest("https://api/", "POST", { domain: "not a domain" });
    const res = await handler.handleClaim(tenantA.id, req, authA, mockEnv);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_DOMAIN");
  });

  it("returns 400 when domain field is missing", async () => {
    const req = makeRequest("https://api/", "POST", {});
    const res = await handler.handleClaim(tenantA.id, req, authA, mockEnv);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("https://api/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await handler.handleClaim(tenantA.id, req, authA, mockEnv);
    expect(res.status).toBe(400);
  });

  it("returns 403 when caller has MEMBER role (not ADMIN/OWNER)", async () => {
    const memberAuth = { ...authA, tenantRole: "MEMBER" as const };
    const req = makeRequest("https://api/", "POST", { domain: DOMAIN });
    const res = await handler.handleClaim(tenantA.id, req, memberAuth, mockEnv);
    expect(res.status).toBe(403);
  });
});

// ─── handleList ───────────────────────────────────────────────────────────────

describe("DomainHandler.handleList", () => {
  let handler: DomainHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new DomainHandler();
  });

  it("returns 200 with empty array when no domains", async () => {
    mockDb.tenantDomain.findMany.mockResolvedValue([]);

    const res = await handler.handleList(tenantA.id, authA, mockEnv);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.domains).toEqual([]);
  });

  it("returns list of domains for tenant", async () => {
    const records = [
      mockDomainRecord({ id: "d1", domain: "example.org" }),
      mockDomainRecord({ id: "d2", domain: "acme.net", verifiedAt: new Date() }),
    ];
    mockDb.tenantDomain.findMany.mockResolvedValue(records);

    const res = await handler.handleList(tenantA.id, authA, mockEnv);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.domains).toHaveLength(2);
  });

  it("does not expose token on verified domains in list", async () => {
    mockDb.tenantDomain.findMany.mockResolvedValue([
      mockDomainRecord({ verifiedAt: new Date() }),
    ]);

    const res = await handler.handleList(tenantA.id, authA, mockEnv);
    const body = await res.json();
    expect(body.domains[0].verificationToken).toBeUndefined();
  });

  it("exposes token on unverified domains in list", async () => {
    mockDb.tenantDomain.findMany.mockResolvedValue([mockDomainRecord()]);

    const res = await handler.handleList(tenantA.id, authA, mockEnv);
    const body = await res.json();
    expect(body.domains[0].verificationToken).toBe(TOKEN);
  });

  it("queries with tenantId scoping", async () => {
    mockDb.tenantDomain.findMany.mockResolvedValue([]);

    await handler.handleList(tenantA.id, authA, mockEnv);
    expect(mockDb.tenantDomain.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: tenantA.id } }),
    );
  });
});

// ─── handleDelete ─────────────────────────────────────────────────────────────

describe("DomainHandler.handleDelete", () => {
  let handler: DomainHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new DomainHandler();
  });

  it("deletes unverified domain and returns 200", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(mockDomainRecord());
    mockDb.tenantDomain.delete.mockResolvedValue({});

    const res = await handler.handleDelete(tenantA.id, DOMAIN_ID, authA, mockEnv);
    expect(res.status).toBe(200);
    expect(mockDb.tenantDomain.delete).toHaveBeenCalledWith({ where: { id: DOMAIN_ID } });
  });

  it("deletes verified domain when no active IdP", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(
      mockDomainRecord({ verifiedAt: new Date() }),
    );
    mockDb.tenantDomain.count.mockResolvedValue(2); // >1 verified domain
    mockDb.tenantDomain.delete.mockResolvedValue({});

    const res = await handler.handleDelete(tenantA.id, DOMAIN_ID, authA, mockEnv);
    expect(res.status).toBe(200);
  });

  it("returns 409 when deleting the only verified domain with ACTIVE IdP", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(
      mockDomainRecord({ verifiedAt: new Date() }),
    );
    mockDb.tenantDomain.count.mockResolvedValue(1);
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({ status: "ACTIVE" });

    const res = await handler.handleDelete(tenantA.id, DOMAIN_ID, authA, mockEnv);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("DOMAIN_IN_USE");
    expect(body.remediation).toBeTruthy();
    expect(mockDb.tenantDomain.delete).not.toHaveBeenCalled();
  });

  it("allows deleting last verified domain when IdP is DISABLED", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(
      mockDomainRecord({ verifiedAt: new Date() }),
    );
    mockDb.tenantDomain.count.mockResolvedValue(1);
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({ status: "DISABLED" });
    mockDb.tenantDomain.delete.mockResolvedValue({});

    const res = await handler.handleDelete(tenantA.id, DOMAIN_ID, authA, mockEnv);
    expect(res.status).toBe(200);
  });

  it("allows deleting last verified domain when no IdP exists", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(
      mockDomainRecord({ verifiedAt: new Date() }),
    );
    mockDb.tenantDomain.count.mockResolvedValue(1);
    mockDb.tenantIdentityProvider.findUnique.mockResolvedValue(null);
    mockDb.tenantDomain.delete.mockResolvedValue({});

    const res = await handler.handleDelete(tenantA.id, DOMAIN_ID, authA, mockEnv);
    expect(res.status).toBe(200);
  });

  it("returns 404 when domain not found in this tenant", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(null);

    const res = await handler.handleDelete(tenantA.id, DOMAIN_ID, authA, mockEnv);
    expect(res.status).toBe(404);
  });

  it("returns 403 when caller has MEMBER role", async () => {
    const memberAuth = { ...authA, tenantRole: "MEMBER" as const };
    const res = await handler.handleDelete(tenantA.id, DOMAIN_ID, memberAuth, mockEnv);
    expect(res.status).toBe(403);
    expect(mockDb.tenantDomain.findUnique).not.toHaveBeenCalled();
  });
});

// ─── handleVerify ─────────────────────────────────────────────────────────────

describe("DomainHandler.handleVerify", () => {
  let handler: DomainHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new DomainHandler();
    mockKv.get.mockResolvedValue(null);
    mockKv.put.mockResolvedValue(undefined);
    mockKv.delete.mockResolvedValue(undefined);
  });

  it("returns 200 when DNS check succeeds", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(mockDomainRecord());
    mockVerifyDomainToken.mockResolvedValue({ verified: true });
    mockDb.tenantDomain.update.mockResolvedValue(
      mockDomainRecord({ verifiedAt: new Date(), verifyAttempts: 1 }),
    );

    const res = await handler.handleVerify(tenantA.id, DOMAIN_ID, authA, mockEnv);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.verifiedAt).toBeTruthy();
  });

  it("returns 200 immediately when domain already verified", async () => {
    const verifiedAt = new Date();
    mockDb.tenantDomain.findUnique.mockResolvedValue(
      mockDomainRecord({ verifiedAt }),
    );

    const res = await handler.handleVerify(tenantA.id, DOMAIN_ID, authA, mockEnv);
    expect(res.status).toBe(200);
    expect(mockVerifyDomainToken).not.toHaveBeenCalled();
  });

  it("returns 422 with remediation when TXT record missing", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(mockDomainRecord());
    mockVerifyDomainToken.mockResolvedValue({ verified: false, reason: "NO_RECORDS" });
    mockDb.tenantDomain.update.mockResolvedValue(mockDomainRecord({ verifyAttempts: 1 }));

    const res = await handler.handleVerify(tenantA.id, DOMAIN_ID, authA, mockEnv);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("VERIFICATION_FAILED");
    expect(body.remediation).toContain(`_trellis-verify.${DOMAIN}`);
  });

  it("returns 422 when TXT record has wrong token", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(mockDomainRecord());
    mockVerifyDomainToken.mockResolvedValue({ verified: false, reason: "TOKEN_MISMATCH" });
    mockDb.tenantDomain.update.mockResolvedValue(mockDomainRecord({ verifyAttempts: 1 }));

    const res = await handler.handleVerify(tenantA.id, DOMAIN_ID, authA, mockEnv);
    expect(res.status).toBe(422);
  });

  it("returns 422 on DNS error (not 500)", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(mockDomainRecord());
    mockVerifyDomainToken.mockResolvedValue({ verified: false, reason: "DNS_ERROR" });
    mockDb.tenantDomain.update.mockResolvedValue(mockDomainRecord({ verifyAttempts: 1 }));

    const res = await handler.handleVerify(tenantA.id, DOMAIN_ID, authA, mockEnv);
    expect(res.status).toBe(422);
    expect(res.status).not.toBe(500);
  });

  it("returns 422 TOKEN_EXPIRED when token has expired (sec finding #5)", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(
      mockDomainRecord({ tokenExpiresAt: PAST }),
    );

    const res = await handler.handleVerify(tenantA.id, DOMAIN_ID, authA, mockEnv);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("TOKEN_EXPIRED");
    expect(body.remediation).toBeTruthy();
    expect(mockVerifyDomainToken).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After on 11th attempt within an hour", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(mockDomainRecord());
    // Simulate 10 previous attempts stored in KV
    mockKv.get.mockResolvedValue("10");

    const res = await handler.handleVerify(tenantA.id, DOMAIN_ID, authA, mockEnv);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(mockVerifyDomainToken).not.toHaveBeenCalled();
  });

  it("rotates token after 10 failed attempts in 24h", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(mockDomainRecord());
    mockVerifyDomainToken.mockResolvedValue({ verified: false, reason: "TOKEN_MISMATCH" });
    mockDb.tenantDomain.update.mockResolvedValue(mockDomainRecord({ verifyAttempts: 1 }));
    // Rate limit KV: within rate limit (attempts < 10)
    mockKv.get
      .mockResolvedValueOnce(null) // rate limit key: 0 attempts
      .mockResolvedValueOnce("9");  // failure count: 9 previous failures

    const res = await handler.handleVerify(tenantA.id, DOMAIN_ID, authA, mockEnv);
    expect(res.status).toBe(422);
    const body = await res.json();
    // 9 previous + 1 new = 10 → triggers rotation
    expect(body.tokenRotated).toBe(true);
    expect(body.remediation).toContain("Token rotated");
    expect(mockDb.tenantDomain.update).toHaveBeenCalledTimes(2);
  });

  it("returns 404 when domain not found", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(null);

    const res = await handler.handleVerify(tenantA.id, DOMAIN_ID, authA, mockEnv);
    expect(res.status).toBe(404);
  });

  it("returns 403 when caller has MEMBER role", async () => {
    const memberAuth = { ...authA, tenantRole: "MEMBER" as const };
    const res = await handler.handleVerify(tenantA.id, DOMAIN_ID, memberAuth, mockEnv);
    expect(res.status).toBe(403);
  });
});

// ─── Cross-tenant isolation ───────────────────────────────────────────────────

describe("Cross-tenant isolation — domain endpoints", () => {
  let handler: DomainHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new DomainHandler();
    mockKv.get.mockResolvedValue(null);
    mockKv.put.mockResolvedValue(undefined);
  });

  it("handleClaim: auth-A cannot claim domain as tenant-B (403)", async () => {
    const req = makeRequest("https://api/", "POST", { domain: DOMAIN });
    const res = await handler.handleClaim(tenantB.id, req, authA, mockEnv);
    expect(res.status).toBe(403);
    expect(mockDb.tenantDomain.create).not.toHaveBeenCalled();
  });

  it("handleList: auth-A requesting tenant-B domains returns 403", async () => {
    const res = await handler.handleList(tenantB.id, authA, mockEnv);
    expect(res.status).toBe(403);
    expect(mockDb.tenantDomain.findMany).not.toHaveBeenCalled();
  });

  it("handleDelete: auth-A cannot delete tenant-B domain (403)", async () => {
    const res = await handler.handleDelete(tenantB.id, DOMAIN_ID, authA, mockEnv);
    expect(res.status).toBe(403);
    expect(mockDb.tenantDomain.findUnique).not.toHaveBeenCalled();
  });

  it("handleVerify: auth-A cannot verify tenant-B domain (403)", async () => {
    const res = await handler.handleVerify(tenantB.id, DOMAIN_ID, authA, mockEnv);
    expect(res.status).toBe(403);
    expect(mockDb.tenantDomain.findUnique).not.toHaveBeenCalled();
  });

  it("handleDelete: auth-A querying nonexistent domain in own tenant returns 404 (no existence leak)", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(null);
    const res = await handler.handleDelete(tenantA.id, "nonexistent-id", authA, mockEnv);
    expect(res.status).toBe(404);
  });

  it("handleVerify: auth-A querying nonexistent domain in own tenant returns 404 (no existence leak)", async () => {
    mockDb.tenantDomain.findUnique.mockResolvedValue(null);
    const res = await handler.handleVerify(tenantA.id, "nonexistent-id", authA, mockEnv);
    expect(res.status).toBe(404);
  });

  it("handleDelete: findUnique uses tenantId filter (cross-tenant domain returns null)", async () => {
    // Simulate: domain exists but belongs to different tenant — findUnique returns null
    // because the query includes tenantId: tenantA.id
    mockDb.tenantDomain.findUnique.mockResolvedValue(null);
    const res = await handler.handleDelete(tenantA.id, DOMAIN_ID, authA, mockEnv);
    expect(res.status).toBe(404);
    const call = mockDb.tenantDomain.findUnique.mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ tenantId: tenantA.id });
  });
});
