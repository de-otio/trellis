/**
 * Unit tests for DomainHandler
 *
 * Covers: handleClaim, handleList, handleDelete, handleVerify
 *
 * NOTE: emitTenantAudit is NOT imported by domain-handler.ts (unlike
 * role-mapping-handler). There is no audit instrumentation in this handler.
 * This is called out in the findings section at the bottom of this file.
 *
 * domain-validator.ts is used real (no mock) so the handler's integration
 * with domain validation is exercised end-to-end.
 *
 * verifyDomainToken is mocked to prevent live DNS lookups.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainHandler } from "../../../src/lib/tenant/domain-handler.js";
import type { AuthContext } from "../../../src/lib/auth/auth-context.js";
import type { TenantRole, UserRole } from "@prisma/client";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockDb, mockVerifyDomainToken } = vi.hoisted(() => ({
  mockDb: {
    tenantDomain: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    tenantIdentityProvider: {
      findUnique: vi.fn(),
    },
  },
  mockVerifyDomainToken: vi.fn(),
}));

// Mock createPrisma — matched to the dynamic import path used in the handler.
vi.mock("../../../src/db", () => ({
  createPrisma: () => mockDb,
}));

// Mock domain-verifier to avoid live DNS lookups.
vi.mock("../../../src/lib/tenant/domain-verifier", () => ({
  verifyDomainToken: mockVerifyDomainToken,
}));

// ─── Spread-actual mocks for auth guards ──────────────────────────────────────
// requireActiveTenant and requireRole are spread-actual mocks.
// Default: return null (allowed). Override per test to simulate denial.

const { mockRequireActiveTenant, mockRequireRole } = vi.hoisted(() => ({
  mockRequireActiveTenant: vi.fn().mockReturnValue(null),
  mockRequireRole: vi.fn().mockReturnValue(null),
}));

vi.mock("../../../src/lib/auth/auth-middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/auth/auth-middleware.js")>();
  return {
    ...actual,
    requireActiveTenant: mockRequireActiveTenant,
  };
});

vi.mock("../../../src/lib/auth/require", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/auth/require.js")>();
  return {
    ...actual,
    requireRole: mockRequireRole,
  };
});

// ─── Test fixtures ────────────────────────────────────────────────────────────

const TENANT_ID = "tenant-aaa-001";
const OTHER_TENANT_ID = "tenant-bbb-002";
const DOMAIN_ID = "domain-id-001";
const VALID_DOMAIN = "acme.example.org";

/** A domain row that is unverified with a valid (non-expired) token. */
function makeUnverifiedDomainRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DOMAIN_ID,
    tenantId: TENANT_ID,
    domain: VALID_DOMAIN,
    verificationToken: "aabbccddeeff00112233445566778899",
    tokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
    verifiedAt: null,
    verifyAttemptedAt: null,
    verifyAttempts: 0,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** A domain row that has been verified. */
function makeVerifiedDomainRow(overrides: Record<string, unknown> = {}) {
  return makeUnverifiedDomainRow({
    verifiedAt: new Date("2025-02-01T00:00:00Z"),
    ...overrides,
  });
}

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    cognitoSub: "cognito-sub-1",
    userId: "user-admin-1",
    globalRole: "END_USER" as UserRole,
    activeTenantId: TENANT_ID,
    tenantSlug: "acme",
    tenantRole: "ADMIN" as TenantRole,
    handle: "alice",
    membershipsLoader: async () => [],
    ...overrides,
  };
}

/** Minimal env: exposes RATE_LIMIT_KV for the verify path. */
function makeEnv(kvOverrides: Record<string, unknown> = {}) {
  return {
    RATE_LIMIT_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      ...kvOverrides,
    },
  } as unknown as import("../../../src/env.js").Env;
}

function makeRequest(method: string, body?: unknown): Request {
  return new Request("https://api.example.org/api/tenants/t1/domains", {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DomainHandler", () => {
  let handler: DomainHandler;
  let auth: AuthContext;
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset guard mocks to "allowed" (null = pass)
    mockRequireActiveTenant.mockReturnValue(null);
    mockRequireRole.mockReturnValue(null);

    handler = new DomainHandler();
    auth = makeAuth();
    env = makeEnv();
  });

  // ─── handleList ─────────────────────────────────────────────────────────────

  describe("handleList", () => {
    it("returns 200 with domain list scoped to tenantId", async () => {
      const rows = [makeUnverifiedDomainRow(), makeVerifiedDomainRow({ id: "domain-id-002" })];
      mockDb.tenantDomain.findMany.mockResolvedValue(rows);

      const res = await handler.handleList(TENANT_ID, auth, env);

      expect(res.status).toBe(200);
      const body = await res.json() as { domains: unknown[] };
      expect(Array.isArray(body.domains)).toBe(true);
      expect(body.domains).toHaveLength(2);

      // findMany must be scoped to the correct tenantId
      expect(mockDb.tenantDomain.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: TENANT_ID } }),
      );
    });

    it("includes verificationToken and txtRecord for unverified domains", async () => {
      const row = makeUnverifiedDomainRow();
      mockDb.tenantDomain.findMany.mockResolvedValue([row]);

      const res = await handler.handleList(TENANT_ID, auth, env);
      const body = await res.json() as { domains: Record<string, unknown>[] };
      const d = body.domains[0];

      expect(d.verificationToken).toBe(row.verificationToken);
      expect(d.txtRecord).toBe(`trellis-verify=${row.verificationToken}`);
      expect(d.txtHost).toBe(`_trellis-verify.${row.domain}`);
    });

    it("omits verificationToken and txtRecord for verified domains", async () => {
      const row = makeVerifiedDomainRow();
      mockDb.tenantDomain.findMany.mockResolvedValue([row]);

      const res = await handler.handleList(TENANT_ID, auth, env);
      const body = await res.json() as { domains: Record<string, unknown>[] };
      const d = body.domains[0];

      expect(d.verificationToken).toBeUndefined();
      expect(d.txtRecord).toBeUndefined();
      expect(d.verifiedAt).toBeDefined();
    });

    it("returns 200 with empty array when tenant has no domains", async () => {
      mockDb.tenantDomain.findMany.mockResolvedValue([]);

      const res = await handler.handleList(TENANT_ID, auth, env);
      const body = await res.json() as { domains: unknown[] };

      expect(res.status).toBe(200);
      expect(body.domains).toHaveLength(0);
    });

    it("returns guard response and skips DB when requireActiveTenant denies", async () => {
      const denied = new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 });
      mockRequireActiveTenant.mockReturnValue(denied);

      const res = await handler.handleList(TENANT_ID, auth, env);

      expect(res.status).toBe(403);
      expect(mockDb.tenantDomain.findMany).not.toHaveBeenCalled();
    });
  });

  // ─── handleClaim ─────────────────────────────────────────────────────────────

  describe("handleClaim", () => {
    it("creates a new domain record and returns 201 with token", async () => {
      const created = makeUnverifiedDomainRow();
      mockDb.tenantDomain.findUnique.mockResolvedValue(null); // no existing record
      mockDb.tenantDomain.create.mockResolvedValue(created);

      const req = makeRequest("POST", { domain: VALID_DOMAIN });
      const res = await handler.handleClaim(TENANT_ID, req, auth, env);

      expect(res.status).toBe(201);
      const body = await res.json() as Record<string, unknown>;
      expect(body.id).toBe(DOMAIN_ID);
      expect(body.domain).toBe(VALID_DOMAIN);
      // Token is present for unverified records
      expect(body.verificationToken).toBeDefined();
      expect(typeof body.verificationToken).toBe("string");
      // TXT hints are present
      expect(body.txtRecord).toMatch(/^trellis-verify=/);
      expect(body.txtHost).toBe(`_trellis-verify.${VALID_DOMAIN}`);

      // DB create was called with the right tenantId and domain
      expect(mockDb.tenantDomain.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tenantId: TENANT_ID, domain: VALID_DOMAIN }),
        }),
      );
    });

    it("returns 400 for a public suffix domain (e.g. 'com')", async () => {
      const req = makeRequest("POST", { domain: "com" });
      const res = await handler.handleClaim(TENANT_ID, req, auth, env);

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("PUBLIC_SUFFIX");
      expect(mockDb.tenantDomain.create).not.toHaveBeenCalled();
    });

    it("returns 400 for a reserved example.com subdomain", async () => {
      const req = makeRequest("POST", { domain: "mycompany.example.com" });
      const res = await handler.handleClaim(TENANT_ID, req, auth, env);

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("RESERVED_DOMAIN");
      expect(mockDb.tenantDomain.create).not.toHaveBeenCalled();
    });

    it("returns 400 for a URL-style input (contains protocol)", async () => {
      const req = makeRequest("POST", { domain: "https://acme.example.org/foo" });
      const res = await handler.handleClaim(TENANT_ID, req, auth, env);

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("INVALID_DOMAIN");
      expect(mockDb.tenantDomain.create).not.toHaveBeenCalled();
    });

    it("returns 400 when domain field is missing from body", async () => {
      const req = makeRequest("POST", { name: "not-a-domain" });
      const res = await handler.handleClaim(TENANT_ID, req, auth, env);

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(mockDb.tenantDomain.create).not.toHaveBeenCalled();
    });

    it("returns 400 for malformed JSON body", async () => {
      const req = new Request("https://api.example.org/api/tenants/t1/domains", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{invalid json",
      });
      const res = await handler.handleClaim(TENANT_ID, req, auth, env);

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("INVALID_JSON");
    });

    it("returns 409 when domain is already claimed by another tenant", async () => {
      const existing = makeUnverifiedDomainRow({ tenantId: OTHER_TENANT_ID });
      mockDb.tenantDomain.findUnique.mockResolvedValue(existing);

      const req = makeRequest("POST", { domain: VALID_DOMAIN });
      const res = await handler.handleClaim(TENANT_ID, req, auth, env);

      expect(res.status).toBe(409);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("DOMAIN_CONFLICT");
      // Must not leak which tenant owns the domain
      expect(JSON.stringify(body)).not.toContain(OTHER_TENANT_ID);
      expect(mockDb.tenantDomain.create).not.toHaveBeenCalled();
    });

    it("returns 200 (idempotent) when same tenant re-claims an already-claimed domain", async () => {
      const existing = makeUnverifiedDomainRow({ verifiedAt: null });
      mockDb.tenantDomain.findUnique.mockResolvedValue(existing);

      const req = makeRequest("POST", { domain: VALID_DOMAIN });
      const res = await handler.handleClaim(TENANT_ID, req, auth, env);

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.id).toBe(DOMAIN_ID);
      // No new create call
      expect(mockDb.tenantDomain.create).not.toHaveBeenCalled();
    });

    it("rotates expired unverified token on re-claim and returns 200", async () => {
      const expired = makeUnverifiedDomainRow({
        verifiedAt: null,
        tokenExpiresAt: new Date(Date.now() - 1000), // expired
      });
      mockDb.tenantDomain.findUnique.mockResolvedValue(expired);
      mockDb.tenantDomain.update.mockResolvedValue({
        ...expired,
        verificationToken: "rotated-token-abc",
        tokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        verifyAttempts: 0,
      });

      const req = makeRequest("POST", { domain: VALID_DOMAIN });
      const res = await handler.handleClaim(TENANT_ID, req, auth, env);

      expect(res.status).toBe(200);
      expect(mockDb.tenantDomain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: expired.id },
          data: expect.objectContaining({ verifyAttempts: 0 }),
        }),
      );
      expect(mockDb.tenantDomain.create).not.toHaveBeenCalled();
    });

    it("returns 200 (idempotent) when same tenant re-claims a verified domain", async () => {
      const verifiedRow = makeVerifiedDomainRow();
      mockDb.tenantDomain.findUnique.mockResolvedValue(verifiedRow);

      const req = makeRequest("POST", { domain: VALID_DOMAIN });
      const res = await handler.handleClaim(TENANT_ID, req, auth, env);

      expect(res.status).toBe(200);
      // Already verified — token must NOT be included in response
      const body = await res.json() as Record<string, unknown>;
      expect(body.verificationToken).toBeUndefined();
    });

    it("returns guard response and skips DB when requireActiveTenant denies on claim", async () => {
      const denied = new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 });
      mockRequireActiveTenant.mockReturnValue(denied);

      const req = makeRequest("POST", { domain: VALID_DOMAIN });
      const res = await handler.handleClaim(TENANT_ID, req, auth, env);

      expect(res.status).toBe(403);
      expect(mockDb.tenantDomain.create).not.toHaveBeenCalled();
    });

    it("returns guard response and skips DB when requireRole denies on claim", async () => {
      const denied = new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 });
      mockRequireRole.mockReturnValue(denied);

      const req = makeRequest("POST", { domain: VALID_DOMAIN });
      const res = await handler.handleClaim(TENANT_ID, req, auth, env);

      expect(res.status).toBe(403);
      expect(mockDb.tenantDomain.create).not.toHaveBeenCalled();
    });

    it("normalises domain to lowercase before validation and create", async () => {
      mockDb.tenantDomain.findUnique.mockResolvedValue(null);
      const created = makeUnverifiedDomainRow({ domain: "acme.example.org" });
      mockDb.tenantDomain.create.mockResolvedValue(created);

      const req = makeRequest("POST", { domain: "ACME.EXAMPLE.ORG" });
      const res = await handler.handleClaim(TENANT_ID, req, auth, env);

      expect(res.status).toBe(201);
      expect(mockDb.tenantDomain.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ domain: "acme.example.org" }),
        }),
      );
    });
  });

  // ─── handleDelete ────────────────────────────────────────────────────────────

  describe("handleDelete", () => {
    it("deletes an unverified domain and returns 200 ok", async () => {
      const row = makeUnverifiedDomainRow();
      mockDb.tenantDomain.findUnique.mockResolvedValue(row);

      const res = await handler.handleDelete(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean };
      expect(body.ok).toBe(true);
      expect(mockDb.tenantDomain.delete).toHaveBeenCalledWith({ where: { id: DOMAIN_ID } });
    });

    it("returns 404 when domain not found for this tenant", async () => {
      mockDb.tenantDomain.findUnique.mockResolvedValue(null);

      const res = await handler.handleDelete(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("NOT_FOUND");
      expect(mockDb.tenantDomain.delete).not.toHaveBeenCalled();
    });

    it("allows deleting a verified domain when there are multiple verified domains", async () => {
      const row = makeVerifiedDomainRow();
      mockDb.tenantDomain.findUnique.mockResolvedValue(row);
      mockDb.tenantDomain.count.mockResolvedValue(2); // still 1 left after deletion

      const res = await handler.handleDelete(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(200);
      expect(mockDb.tenantDomain.delete).toHaveBeenCalled();
    });

    it("blocks deleting the last verified domain when an active IdP exists", async () => {
      const row = makeVerifiedDomainRow();
      mockDb.tenantDomain.findUnique.mockResolvedValue(row);
      mockDb.tenantDomain.count.mockResolvedValue(1); // this is the last one
      mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({ status: "ACTIVE" });

      const res = await handler.handleDelete(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(409);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("DOMAIN_IN_USE");
      expect(mockDb.tenantDomain.delete).not.toHaveBeenCalled();
    });

    it("allows deleting the last verified domain when no active IdP exists", async () => {
      const row = makeVerifiedDomainRow();
      mockDb.tenantDomain.findUnique.mockResolvedValue(row);
      mockDb.tenantDomain.count.mockResolvedValue(1);
      mockDb.tenantIdentityProvider.findUnique.mockResolvedValue(null); // no IdP

      const res = await handler.handleDelete(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(200);
      expect(mockDb.tenantDomain.delete).toHaveBeenCalled();
    });

    it("allows deleting the last verified domain when IdP is not ACTIVE", async () => {
      const row = makeVerifiedDomainRow();
      mockDb.tenantDomain.findUnique.mockResolvedValue(row);
      mockDb.tenantDomain.count.mockResolvedValue(1);
      mockDb.tenantIdentityProvider.findUnique.mockResolvedValue({ status: "DISABLED" });

      const res = await handler.handleDelete(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(200);
      expect(mockDb.tenantDomain.delete).toHaveBeenCalled();
    });

    it("returns guard response and skips DB when requireActiveTenant denies on delete", async () => {
      const denied = new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 });
      mockRequireActiveTenant.mockReturnValue(denied);

      const res = await handler.handleDelete(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(403);
      expect(mockDb.tenantDomain.findUnique).not.toHaveBeenCalled();
      expect(mockDb.tenantDomain.delete).not.toHaveBeenCalled();
    });

    it("returns guard response and skips DB when requireRole denies on delete", async () => {
      const denied = new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 });
      mockRequireRole.mockReturnValue(denied);

      const res = await handler.handleDelete(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(403);
      expect(mockDb.tenantDomain.findUnique).not.toHaveBeenCalled();
      expect(mockDb.tenantDomain.delete).not.toHaveBeenCalled();
    });

    it("scopes findUnique to tenantId to prevent cross-tenant deletion", async () => {
      mockDb.tenantDomain.findUnique.mockResolvedValue(null);

      await handler.handleDelete(TENANT_ID, DOMAIN_ID, auth, env);

      expect(mockDb.tenantDomain.findUnique).toHaveBeenCalledWith({
        where: { id: DOMAIN_ID, tenantId: TENANT_ID },
      });
    });
  });

  // ─── handleVerify ─────────────────────────────────────────────────────────────

  describe("handleVerify", () => {
    it("marks domain verified when DNS lookup succeeds and returns 200 with verifiedAt", async () => {
      const row = makeUnverifiedDomainRow();
      mockDb.tenantDomain.findUnique.mockResolvedValue(row);
      mockVerifyDomainToken.mockResolvedValue({ verified: true });
      const updatedRow = { ...row, verifiedAt: new Date("2025-03-01T00:00:00Z") };
      mockDb.tenantDomain.update.mockResolvedValue(updatedRow);

      const res = await handler.handleVerify(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; domain: string; verifiedAt: unknown };
      expect(body.ok).toBe(true);
      expect(body.domain).toBe(VALID_DOMAIN);
      expect(body.verifiedAt).toBeDefined();

      // DB update must set verifiedAt
      expect(mockDb.tenantDomain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: DOMAIN_ID },
          data: expect.objectContaining({ verifiedAt: expect.any(Date) }),
        }),
      );
    });

    it("returns 422 VERIFICATION_FAILED with TOKEN_MISMATCH reason when DNS has wrong token", async () => {
      const row = makeUnverifiedDomainRow();
      mockDb.tenantDomain.findUnique.mockResolvedValue(row);
      mockVerifyDomainToken.mockResolvedValue({ verified: false, reason: "TOKEN_MISMATCH" });
      mockDb.tenantDomain.update.mockResolvedValue({ ...row, verifyAttempts: 1 });
      env.RATE_LIMIT_KV.get = vi.fn().mockResolvedValue(null);

      const res = await handler.handleVerify(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(422);
      const body = await res.json() as { error: string; message: string };
      expect(body.error).toBe("VERIFICATION_FAILED");
      expect(body.message).toContain("TXT record found");

      // Must NOT mark as verified on failure
      expect(mockDb.tenantDomain.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ verifiedAt: expect.anything() }),
        }),
      );
    });

    it("returns 422 VERIFICATION_FAILED with NO_RECORDS reason when no TXT record exists", async () => {
      const row = makeUnverifiedDomainRow();
      mockDb.tenantDomain.findUnique.mockResolvedValue(row);
      mockVerifyDomainToken.mockResolvedValue({ verified: false, reason: "NO_RECORDS" });
      mockDb.tenantDomain.update.mockResolvedValue({ ...row, verifyAttempts: 1 });
      env.RATE_LIMIT_KV.get = vi.fn().mockResolvedValue(null);

      const res = await handler.handleVerify(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(422);
      const body = await res.json() as { error: string; message: string; remediation: string };
      expect(body.error).toBe("VERIFICATION_FAILED");
      expect(body.message).toContain("No TXT record");
      // Remediation includes the TXT hint with the token
      expect(body.remediation).toContain("_trellis-verify.");
      expect(body.remediation).toContain("trellis-verify=");
    });

    it("returns 422 VERIFICATION_FAILED with DNS_ERROR reason on network failure", async () => {
      const row = makeUnverifiedDomainRow();
      mockDb.tenantDomain.findUnique.mockResolvedValue(row);
      mockVerifyDomainToken.mockResolvedValue({ verified: false, reason: "DNS_ERROR" });
      mockDb.tenantDomain.update.mockResolvedValue({ ...row, verifyAttempts: 1 });
      env.RATE_LIMIT_KV.get = vi.fn().mockResolvedValue(null);

      const res = await handler.handleVerify(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(422);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("VERIFICATION_FAILED");
    });

    it("returns 404 when domain not found for tenant", async () => {
      mockDb.tenantDomain.findUnique.mockResolvedValue(null);

      const res = await handler.handleVerify(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("NOT_FOUND");
      expect(mockVerifyDomainToken).not.toHaveBeenCalled();
    });

    it("returns 200 immediately when domain is already verified without re-doing DNS", async () => {
      const row = makeVerifiedDomainRow();
      mockDb.tenantDomain.findUnique.mockResolvedValue(row);

      const res = await handler.handleVerify(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; verifiedAt: unknown };
      expect(body.ok).toBe(true);
      expect(body.verifiedAt).toBeDefined();
      expect(mockVerifyDomainToken).not.toHaveBeenCalled();
    });

    it("returns 422 TOKEN_EXPIRED when token has expired before DNS check", async () => {
      const row = makeUnverifiedDomainRow({
        tokenExpiresAt: new Date(Date.now() - 1000), // expired
      });
      mockDb.tenantDomain.findUnique.mockResolvedValue(row);

      const res = await handler.handleVerify(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(422);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("TOKEN_EXPIRED");
      expect(mockVerifyDomainToken).not.toHaveBeenCalled();
    });

    it("returns 429 RATE_LIMITED when verify attempts exceed limit", async () => {
      const row = makeUnverifiedDomainRow();
      mockDb.tenantDomain.findUnique.mockResolvedValue(row);
      // Simulate rate limit: KV shows 10+ attempts
      env.RATE_LIMIT_KV.get = vi.fn().mockResolvedValue("10");

      const res = await handler.handleVerify(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(429);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("RATE_LIMITED");
      expect(res.headers.get("Retry-After")).toBeDefined();
      expect(mockVerifyDomainToken).not.toHaveBeenCalled();
    });

    it("rotates token and returns tokenRotated flag after 10 failures in 24h", async () => {
      const row = makeUnverifiedDomainRow();
      mockDb.tenantDomain.findUnique.mockResolvedValue(row);
      mockVerifyDomainToken.mockResolvedValue({ verified: false, reason: "TOKEN_MISMATCH" });
      mockDb.tenantDomain.update.mockResolvedValue({ ...row, verifyAttempts: 1 });

      // Rate limit KV: under limit (so request proceeds)
      // Failure count KV: returns 9 (will become 10 = threshold)
      let putCallCount = 0;
      env.RATE_LIMIT_KV.get = vi.fn().mockImplementation(async (key: string) => {
        if (key.startsWith("domain-rate:")) return "0"; // rate limit not hit
        if (key.startsWith("domain-fail:")) return "9"; // one below threshold, increment = 10
        return null;
      });
      env.RATE_LIMIT_KV.put = vi.fn().mockImplementation(async () => {
        putCallCount++;
      });

      const res = await handler.handleVerify(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(422);
      const body = await res.json() as { tokenRotated?: boolean; remediation: string };
      expect(body.tokenRotated).toBe(true);
      // Remediation must use the new rotated token hint, not the old one
      expect(body.remediation).toContain("Token rotated");
      // Token rotation update must have been called
      const updateCalls = mockDb.tenantDomain.update.mock.calls;
      const rotationCall = updateCalls.find((call: unknown[]) =>
        call[0] &&
        typeof call[0] === "object" &&
        (call[0] as { data?: { verificationToken?: unknown } }).data?.verificationToken !== undefined,
      );
      expect(rotationCall).toBeDefined();
    });

    it("scopes findUnique to tenantId to prevent cross-tenant verification", async () => {
      mockDb.tenantDomain.findUnique.mockResolvedValue(null);

      await handler.handleVerify(TENANT_ID, DOMAIN_ID, auth, env);

      expect(mockDb.tenantDomain.findUnique).toHaveBeenCalledWith({
        where: { id: DOMAIN_ID, tenantId: TENANT_ID },
      });
    });

    it("returns guard response and skips all DB+DNS when requireActiveTenant denies", async () => {
      const denied = new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 });
      mockRequireActiveTenant.mockReturnValue(denied);

      const res = await handler.handleVerify(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(403);
      expect(mockDb.tenantDomain.findUnique).not.toHaveBeenCalled();
      expect(mockVerifyDomainToken).not.toHaveBeenCalled();
    });

    it("returns guard response and skips all DB+DNS when requireRole denies", async () => {
      const denied = new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 });
      mockRequireRole.mockReturnValue(denied);

      const res = await handler.handleVerify(TENANT_ID, DOMAIN_ID, auth, env);

      expect(res.status).toBe(403);
      expect(mockDb.tenantDomain.findUnique).not.toHaveBeenCalled();
      expect(mockVerifyDomainToken).not.toHaveBeenCalled();
    });
  });
});

/*
 * ─── FINDINGS ────────────────────────────────────────────────────────────────
 *
 * FINDING 1 (GAP — no audit trail): DomainHandler does NOT call emitTenantAudit
 * for any of its mutating operations (claim, delete, verify). The
 * role-mapping-handler, member-handler, and transfer-handler all emit audit
 * events on mutations. Domain claim/verify/remove are security-sensitive
 * (domain ownership gates SSO logins) and should be audited. This is a missing
 * feature, not a bug that breaks existing behavior.
 *
 * FINDING 2 (OBSERVATION — delete returns 200, not 204): handleDelete returns
 * json({ ok: true }, 200), unlike role-mapping-handler's handleDelete which
 * returns HTTP 204 (no content). Both are valid, but inconsistent across the
 * codebase. Noted for API design review.
 *
 * FINDING 3 (OBSERVATION — handleList has no role gate): handleList only checks
 * requireActiveTenant (any tenant member can list domains). The write operations
 * (claim/delete/verify) require ADMIN role. This is likely intentional (read is
 * open to all tenant members) but worth confirming against the API spec.
 * ─────────────────────────────────────────────────────────────────────────────
 */
