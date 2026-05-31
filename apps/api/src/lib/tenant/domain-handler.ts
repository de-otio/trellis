/**
 * Tenant Domain Handler
 *
 * Handles CRUD + DNS verification for tenant-claimed domains.
 *
 * Routes:
 *   POST   /api/tenants/:id/domains              — claim domain
 *   GET    /api/tenants/:id/domains              — list domains
 *   DELETE /api/tenants/:id/domains/:domainId    — remove domain
 *   POST   /api/tenants/:id/domains/:domainId/verify — trigger DNS check
 */

import type { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import type { Env } from "../../env.js";
import type { AuthContext } from "../auth/auth-context.js";
import { requireActiveTenant } from "../auth/auth-middleware.js";
import { requireRole } from "../auth/require.js";
import { validateDomain } from "./domain-validator.js";
import { verifyDomainToken } from "./domain-verifier.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const TOKEN_EXPIRY_DAYS = 7;
const RATE_LIMIT_WINDOW_SECONDS = 3600; // 1 hour
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const FAILURE_ROTATION_WINDOW_SECONDS = 86400; // 24 hours
const FAILURE_ROTATION_THRESHOLD = 10;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateToken(): string {
  return randomBytes(16).toString("hex");
}

function tokenExpiresAt(): Date {
  const d = new Date();
  d.setDate(d.getDate() + TOKEN_EXPIRY_DAYS);
  return d;
}

function makeRateLimitKey(tenantId: string, domainId: string): string {
  return `domain-rate:${tenantId}:${domainId}`;
}

function makeFailureCountKey(tenantId: string, domainId: string): string {
  return `domain-fail:${tenantId}:${domainId}`;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export class DomainHandler {
  /**
   * POST /api/tenants/:id/domains
   * Claim a domain. Returns 201 + token on first claim, 200 + existing record
   * if the same tenant re-claims the same domain (idempotent).
   * Returns 409 if the domain is already claimed by another tenant.
   */
  async handleClaim(
    tenantId: string,
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied =
      requireActiveTenant(auth, tenantId) ??
      requireRole(auth, "ADMIN");
    if (denied) return denied;

    const { z } = await import("zod");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "INVALID_JSON", message: "Request body must be valid JSON" }, 400);
    }

    const schema = z.object({ domain: z.string() });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return json({ error: "VALIDATION_ERROR", message: "domain is required" }, 400);
    }

    const validation = validateDomain(parsed.data.domain);
    if (!validation.ok) {
      return json({ error: validation.code, message: validation.message }, 400);
    }

    const { domain } = validation;
    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    // Check for existing record globally (without tenantId filter) to enforce
    // the "domain can only belong to one tenant" rule.
    const existing = await db.tenantDomain.findUnique({
      where: { domain },
    });

    if (existing) {
      if (existing.tenantId === tenantId) {
        // Idempotent re-claim: check if token has expired and re-issue if so.
        if (!existing.verifiedAt && existing.tokenExpiresAt < new Date()) {
          // Expired unverified token — rotate it.
          const updated = await db.tenantDomain.update({
            where: { id: existing.id },
            data: {
              verificationToken: generateToken(),
              tokenExpiresAt: tokenExpiresAt(),
              verifyAttempts: 0,
            },
          });
          return json(formatDomainRecord(updated), 200);
        }
        // Return existing record as-is.
        return json(formatDomainRecord(existing), 200);
      }
      // Another tenant owns it — don't leak which tenant.
      return json({ error: "DOMAIN_CONFLICT", message: "Domain is already claimed" }, 409);
    }

    // Create new record.
    const record = await db.tenantDomain.create({
      data: {
        tenantId,
        domain,
        verificationToken: generateToken(),
        tokenExpiresAt: tokenExpiresAt(),
      },
    });

    return json(formatDomainRecord(record), 201);
  }

  /**
   * GET /api/tenants/:id/domains
   * Lists tenant's domains. Tokens are included for unverified records
   * (so the admin can copy the required TXT value).
   */
  async handleList(
    tenantId: string,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied = requireActiveTenant(auth, tenantId);
    if (denied) return denied;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const domains = await db.tenantDomain.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
    });

    return json({ domains: domains.map(formatDomainRecord) }, 200);
  }

  /**
   * DELETE /api/tenants/:id/domains/:domainId
   * Removes a domain. Blocked if the domain is the only verified domain and
   * the tenant has an ACTIVE IdP (removing it would break SSO logins).
   */
  async handleDelete(
    tenantId: string,
    domainId: string,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied =
      requireActiveTenant(auth, tenantId) ??
      requireRole(auth, "ADMIN");
    if (denied) return denied;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const record = await db.tenantDomain.findUnique({
      where: { id: domainId, tenantId },
    });

    if (!record) {
      return json({ error: "NOT_FOUND", message: "Domain not found" }, 404);
    }

    if (record.verifiedAt) {
      // Check whether this is the last verified domain and there's an active IdP.
      const verifiedCount = await db.tenantDomain.count({
        where: { tenantId, verifiedAt: { not: null } },
      });

      if (verifiedCount === 1) {
        const idp = await db.tenantIdentityProvider.findUnique({
          where: { tenantId },
          select: { status: true },
        });
        if (idp?.status === "ACTIVE") {
          return json(
            {
              error: "DOMAIN_IN_USE",
              message: "Cannot remove the only verified domain while an IdP is active",
              remediation: "Disable the identity provider first, or add another verified domain",
            },
            409,
          );
        }
      }
    }

    await db.tenantDomain.delete({ where: { id: domainId } });
    return json({ ok: true }, 200);
  }

  /**
   * POST /api/tenants/:id/domains/:domainId/verify
   * Performs a DNS TXT lookup to verify domain ownership.
   */
  async handleVerify(
    tenantId: string,
    domainId: string,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied =
      requireActiveTenant(auth, tenantId) ??
      requireRole(auth, "ADMIN");
    if (denied) return denied;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const record = await db.tenantDomain.findUnique({
      where: { id: domainId, tenantId },
    });

    if (!record) {
      return json({ error: "NOT_FOUND", message: "Domain not found" }, 404);
    }

    // Already verified — return success immediately.
    if (record.verifiedAt) {
      return json({ ok: true, domain: record.domain, verifiedAt: record.verifiedAt }, 200);
    }

    // Check token expiry (sec finding #5).
    if (record.tokenExpiresAt < new Date()) {
      return json(
        {
          error: "TOKEN_EXPIRED",
          message: "Verification token has expired",
          remediation: "Re-claim the domain to get a new token",
        },
        422,
      );
    }

    // Rate limit: 10 verify attempts per hour per (tenantId, domainId).
    const rateLimitKey = makeRateLimitKey(tenantId, domainId);
    const rateLimitCheckResult = await this.checkAndIncrementRateLimit(
      env,
      rateLimitKey,
      RATE_LIMIT_MAX_ATTEMPTS,
      RATE_LIMIT_WINDOW_SECONDS,
    );
    if (rateLimitCheckResult.limited) {
      return new Response(
        JSON.stringify({ error: "RATE_LIMITED", message: "Too many verify attempts" }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "Retry-After": String(rateLimitCheckResult.retryAfter),
          },
        },
      );
    }

    // Perform DNS lookup.
    const dnsResult = await verifyDomainToken(record.domain, record.verificationToken);

    if (dnsResult.verified) {
      const updated = await db.tenantDomain.update({
        where: { id: domainId },
        data: {
          verifiedAt: new Date(),
          verifyAttemptedAt: new Date(),
          verifyAttempts: { increment: 1 },
        },
      });
      return json({ ok: true, domain: updated.domain, verifiedAt: updated.verifiedAt }, 200);
    }

    // Failed — increment failure counter in DynamoDB.
    await db.tenantDomain.update({
      where: { id: domainId },
      data: {
        verifyAttemptedAt: new Date(),
        verifyAttempts: { increment: 1 },
      },
    });

    // Check for auto-rotation after 10 failures in 24h.
    const failKey = makeFailureCountKey(tenantId, domainId);
    const newFailCount = await this.incrementFailureCount(
      env,
      failKey,
      FAILURE_ROTATION_WINDOW_SECONDS,
    );

    let rotated = false;
    let newToken: string | undefined;
    if (newFailCount >= FAILURE_ROTATION_THRESHOLD) {
      newToken = generateToken();
      await db.tenantDomain.update({
        where: { id: domainId },
        data: {
          verificationToken: newToken,
          tokenExpiresAt: tokenExpiresAt(),
          verifyAttempts: 0,
        },
      });
      await env.RATE_LIMIT_KV.delete(failKey);
      rotated = true;
    }

    const reason = dnsResult.reason;
    const messages: Record<string, string> = {
      TOKEN_MISMATCH: "TXT record found but token did not match",
      NO_RECORDS: "No TXT record found at the verification hostname",
      DNS_ERROR: "DNS lookup failed — please try again later",
    };

    const body: Record<string, unknown> = {
      error: "VERIFICATION_FAILED",
      message: messages[reason] ?? "DNS verification failed",
      remediation: `Add TXT record: _trellis-verify.${record.domain} = trellis-verify=${record.verificationToken}`,
    };
    if (rotated && newToken) {
      body.tokenRotated = true;
      body.remediation = `Token rotated after repeated failures. Add TXT record: _trellis-verify.${record.domain} = trellis-verify=${newToken}`;
    }

    return json(body, 422);
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  private async checkAndIncrementRateLimit(
    env: Env,
    key: string,
    maxAttempts: number,
    windowSeconds: number,
  ): Promise<{ limited: false } | { limited: true; retryAfter: number }> {
    const raw = await env.RATE_LIMIT_KV.get(key);
    const current = raw ? parseInt(raw, 10) : 0;

    if (current >= maxAttempts) {
      return { limited: true, retryAfter: windowSeconds };
    }

    await env.RATE_LIMIT_KV.put(key, String(current + 1), {
      expirationTtl: windowSeconds,
    });

    return { limited: false };
  }

  private async incrementFailureCount(
    env: Env,
    key: string,
    windowSeconds: number,
  ): Promise<number> {
    const raw = await env.RATE_LIMIT_KV.get(key);
    const current = raw ? parseInt(raw, 10) : 0;
    const next = current + 1;
    await env.RATE_LIMIT_KV.put(key, String(next), {
      expirationTtl: windowSeconds,
    });
    return next;
  }
}

// ─── Formatter ───────────────────────────────────────────────────────────────

type TenantDomainRow = Prisma.TenantDomainGetPayload<object>;

function formatDomainRecord(r: TenantDomainRow): Record<string, unknown> {
  return {
    id: r.id,
    tenantId: r.tenantId,
    domain: r.domain,
    verifiedAt: r.verifiedAt,
    tokenExpiresAt: r.tokenExpiresAt,
    verifyAttempts: r.verifyAttempts,
    createdAt: r.createdAt,
    // Only include token for unverified records so admin knows the TXT value to set.
    ...(r.verifiedAt ? {} : {
      verificationToken: r.verificationToken,
      txtRecord: `trellis-verify=${r.verificationToken}`,
      txtHost: `_trellis-verify.${r.domain}`,
    }),
  };
}
