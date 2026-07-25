/**
 * Tenant IdP CRUD handler — OIDC for MVP, SAML stubbed.
 *
 * Endpoints (wired in routes/tenant-idp.ts):
 *   POST   /api/tenants/:id/identity-provider  { kind:"OIDC"|"SAML", ... }
 *   GET    /api/tenants/:id/identity-provider
 *   PATCH  /api/tenants/:id/identity-provider  { ...updates | status }
 *   DELETE /api/tenants/:id/identity-provider?confirm=true
 *
 * Invariants enforced here:
 *  - Cross-tenant: every Prisma query filters on `tenantId: auth.activeTenantId`.
 *    Mismatch returns 404 (data endpoint) or 403 (mutation endpoint).
 *  - At least one verified domain is required to connect an IdP.
 *  - Client secret never logged, never returned in GET.
 *  - Atomic create: secrets-manager create + Cognito create wrapped so a
 *    Cognito failure rolls back the secret.
 *  - UpdateUserPoolClient is serialised across runs via a Postgres advisory
 *    lock keyed on the user pool id.
 *  - On delete or disable, the claims cache for every TenantMember of the
 *    tenant is invalidated so the next token refresh re-resolves.
 *  - SAML branch returns 501.
 */
import type { IdpKind, IdpStatus, TenantRole, Prisma, PrismaClient } from "@prisma/client";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import type { Env } from "../../env.js";
import type { AuthContext } from "../auth/auth-context.js";
import { requireActiveTenant, requireOwnTenant } from "../auth/auth-middleware.js";
import { Capability, requireCapability } from "../auth/require.js";
import { createClaimsCacheFromEnv } from "../auth/claims-cache.js";
import { TenantAuditEmitter } from "../audit-composer.js";
import { AuditEventType } from "../audit-actions.js";
import { cognitoIdpName } from "./idp-name.js";
import {
  CognitoIdpSdk,
  defaultOidcAttributeMapping,
  withUserPoolClientLock,
  type IdpAttributeMapping,
} from "../cognito/idp-sdk.js";
import { probeOidcIssuer } from "../cognito/issuer-probe.js";
import { IdpSecretsClient } from "../secrets/idp-secrets.js";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const JSON_HEADERS = { "content-type": "application/json" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function badRequest(message: string, code = "VALIDATION_ERROR"): Response {
  return jsonResponse(400, { error: code, message });
}

function unprocessable(message: string, remediation?: string): Response {
  return jsonResponse(422, {
    error: "UNPROCESSABLE",
    message,
    ...(remediation ? { remediation } : {}),
  });
}

function badGateway(): Response {
  return jsonResponse(502, {
    error: "COGNITO_ERROR",
    message: "Identity-provider service is unavailable. Try again in a few minutes.",
  });
}

function notFound(): Response {
  return jsonResponse(404, { error: "NOT_FOUND", message: "Identity provider not found" });
}

const auditEmitter = new TenantAuditEmitter();

export interface IdpHandlerDependencies {
  /** Override the Cognito SDK wrapper (tests). */
  idp?: CognitoIdpSdk;
  /** Override the Secrets Manager wrapper (tests). */
  secrets?: IdpSecretsClient;
  /**
   * Override the claims-cache invalidator (tests). Production calls
   * `createClaimsCacheFromEnv` lazily.
   */
  invalidateClaimsForSubs?: (subs: string[]) => Promise<void>;
}

interface OidcCreateBody {
  kind: "OIDC";
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  defaultRole?: TenantRole;
  scopes?: string;
  attributeMapping?: IdpAttributeMapping;
}

interface PatchBodyStatus {
  status: "ACTIVE" | "DISABLED";
}

interface PatchBodyConfig {
  clientSecret?: string;
  attributeMapping?: IdpAttributeMapping;
  defaultRole?: TenantRole | null;
  scopes?: string;
}

export class IdpHandler {
  constructor(private readonly deps: IdpHandlerDependencies = {}) {}

  // ── Helpers ────────────────────────────────────────────────────────────────
  private getIdp(env: Env): CognitoIdpSdk {
    if (this.deps.idp) return this.deps.idp;
    return new CognitoIdpSdk(
      new CognitoIdentityProviderClient({
        region: env.COGNITO_REGION ?? process.env.AWS_REGION,
      }),
    );
  }

  private getSecrets(env: Env): IdpSecretsClient {
    if (this.deps.secrets) return this.deps.secrets;
    return new IdpSecretsClient(
      new SecretsManagerClient({
        region: env.COGNITO_REGION ?? process.env.AWS_REGION,
      }),
    );
  }

  private async invalidateAllMemberClaims(tenantId: string, env: Env): Promise<void> {
    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);
    const members = await db.tenantMember.findMany({
      where: { tenantId },
      select: { user: { select: { subject: true } } },
    });
    const subs = members.map((m) => m.user.subject).filter((s): s is string => !!s);
    if (this.deps.invalidateClaimsForSubs) {
      await this.deps.invalidateClaimsForSubs(subs);
      return;
    }
    if (subs.length === 0) return;
    try {
      const cache = createClaimsCacheFromEnv();
      await Promise.all(subs.map((s) => cache.invalidate(s).catch(() => undefined)));
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "claims-cache invalidate-all failed",
          tenantId,
          error: String(err),
        }),
      );
    }
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  async handleCreate(
    tenantId: string,
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied =
      requireActiveTenant(auth, tenantId) ??
      requireCapability(auth, Capability.IdpConfigure);
    if (denied) return denied;

    const { z } = await import("zod");
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return badRequest("Body must be valid JSON", "INVALID_JSON");
    }

    const kind = (raw as { kind?: string } | null)?.kind;
    if (kind === "SAML") {
      return jsonResponse(501, {
        error: "SAML_NOT_AVAILABLE_IN_MVP",
        message: "SAML identity providers are not available in MVP. Use OIDC.",
      });
    }
    if (kind !== "OIDC") {
      return badRequest("kind must be 'OIDC'");
    }

    const schema = z.object({
      kind: z.literal("OIDC"),
      issuerUrl: z.string().url().max(2048),
      clientId: z.string().min(1).max(512),
      clientSecret: z.string().min(1).max(2048),
      defaultRole: z.enum(["ADMIN", "MEMBER", "GUEST"]).optional(),
      scopes: z.string().max(1024).optional(),
      attributeMapping: z.record(z.string(), z.string()).optional(),
    });
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
    }
    const body = parsed.data as OidcCreateBody;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) return notFound();

    const verifiedDomains = await db.tenantDomain.findMany({
      where: { tenantId, verifiedAt: { not: null } },
      select: { domain: true },
      orderBy: { domain: "asc" },
    });
    if (verifiedDomains.length === 0) {
      return unprocessable(
        "Tenant must have at least one verified domain before connecting an IdP",
        `POST /api/tenants/${tenantId}/domains`,
      );
    }

    const existing = await db.tenantIdentityProvider.findUnique({
      where: { tenantId },
      select: { id: true },
    });
    if (existing) {
      return jsonResponse(409, {
        error: "IDP_EXISTS",
        message: "Tenant already has an identity provider",
        remediation: `PATCH or DELETE /api/tenants/${tenantId}/identity-provider`,
      });
    }

    const probe = await probeOidcIssuer(body.issuerUrl);
    if (!probe.ok) {
      return jsonResponse(422, {
        error: "ISSUER_UNREACHABLE",
        message: probe.message,
        reason: probe.reason,
        remediation:
          "Confirm the issuer URL hosts a valid OIDC discovery document at /.well-known/openid-configuration",
      });
    }

    const userPoolId = env.COGNITO_USER_POOL_ID;
    const userPoolClientId = env.COGNITO_APP_CLIENT_ID;
    if (!userPoolId || !userPoolClientId) {
      return badGateway();
    }

    const providerName = cognitoIdpName(tenantId);
    const attributeMapping: IdpAttributeMapping = {
      ...defaultOidcAttributeMapping(),
      ...(body.attributeMapping ?? {}),
    };
    const idpIdentifiers = verifiedDomains.map((d) => d.domain);
    const secrets = this.getSecrets(env);
    const idp = this.getIdp(env);

    let secretArn: string;
    try {
      const secret = await secrets.create(tenantId, body.clientSecret);
      secretArn = secret.arn;
    } catch (err) {
      const errName = (err as { name?: string }).name;
      if (errName === "ResourceExistsException") {
        return jsonResponse(409, {
          error: "IDP_EXISTS",
          message: "An IdP secret already exists for this tenant",
          remediation: `PATCH or DELETE /api/tenants/${tenantId}/identity-provider`,
        });
      }
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "idp-secret create failed",
          tenantId,
          errName,
        }),
      );
      return badGateway();
    }

    try {
      await idp.createOidcProvider({
        userPoolId,
        providerName,
        details: {
          clientId: body.clientId,
          clientSecret: body.clientSecret,
          issuerUrl: body.issuerUrl,
          ...(body.scopes ? { scopes: body.scopes } : {}),
        },
        attributeMapping,
        idpIdentifiers,
      });
    } catch (err) {
      await secrets.delete(tenantId).catch(() => undefined);
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "Cognito CreateIdentityProvider failed; rolled back secret",
          tenantId,
          errName: (err as { name?: string }).name,
        }),
      );
      return badGateway();
    }

    let row: Prisma.TenantIdentityProviderGetPayload<{
      select: {
        id: true;
        tenantId: true;
        kind: true;
        status: true;
        cognitoIdpName: true;
        issuerUrl: true;
        clientId: true;
        defaultRole: true;
        attributeMapping: true;
        scopes: true;
        enabledAt: true;
        createdAt: true;
        updatedAt: true;
      };
    }>;
    try {
      // 15s — must outlast the Cognito Describe+Update round-trip held under
      // the advisory lock; default 5s is too short and would release the
      // lock while the Cognito mutation is still in-flight.
      row = await db.$transaction(
        async (tx) => {
          await withUserPoolClientLock(tx, userPoolId, async () => {
            await idp.setSupportedIdentityProvider(
              userPoolId,
              userPoolClientId,
              providerName,
              "add",
            );
          });
          return tx.tenantIdentityProvider.create({
            data: {
              tenantId,
              kind: "OIDC" as IdpKind,
              cognitoIdpName: providerName,
              issuerUrl: body.issuerUrl,
              clientId: body.clientId,
              clientSecretArn: secretArn,
              scopes: body.scopes ?? "openid email profile groups",
              attributeMapping: attributeMapping as Prisma.InputJsonValue,
              defaultRole: body.defaultRole ?? null,
              status: "ACTIVE" as IdpStatus,
              enabledAt: new Date(),
            },
            select: {
              id: true,
              tenantId: true,
              kind: true,
              status: true,
              cognitoIdpName: true,
              issuerUrl: true,
              clientId: true,
              defaultRole: true,
              attributeMapping: true,
              scopes: true,
              enabledAt: true,
              createdAt: true,
              updatedAt: true,
            },
          });
        },
        { timeout: 15000 },
      );
    } catch (err) {
      await idp.deleteProvider(userPoolId, providerName).catch(() => undefined);
      await secrets.delete(tenantId).catch(() => undefined);
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "RDS commit failed; rolled back Cognito + secret",
          tenantId,
          errName: (err as { name?: string }).name,
        }),
      );
      return badGateway();
    }

    void auditEmitter
      .emit(
        {
          type: AuditEventType.TENANT_IDP_CONNECTED,
          tenantId,
          actorUserId: auth.userId,
          payload: {
            idpKind: "OIDC",
            issuer: body.issuerUrl,
            idpStatus: "ACTIVE",
          },
        },
        db,
      )
      .catch((err: unknown) =>
        console.warn(
          JSON.stringify({
            event: "audit.emit_failed",
            error: (err as { message?: string })?.message ?? "unknown",
          }),
        ),
      );

    return jsonResponse(201, formatIdpRecord(row));
  }

  // ── GET ────────────────────────────────────────────────────────────────────
  async handleGet(tenantId: string, auth: AuthContext, env: Env): Promise<Response> {
    const denied =
      requireOwnTenant(auth, tenantId) ??
      requireCapability(auth, Capability.IdpView);
    if (denied) return denied;

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const row = await db.tenantIdentityProvider.findUnique({
      where: { tenantId },
      select: {
        id: true,
        tenantId: true,
        kind: true,
        status: true,
        cognitoIdpName: true,
        issuerUrl: true,
        clientId: true,
        defaultRole: true,
        attributeMapping: true,
        scopes: true,
        enabledAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!row) return notFound();
    return jsonResponse(200, formatIdpRecord(row));
  }

  // ── PATCH ──────────────────────────────────────────────────────────────────
  async handlePatch(
    tenantId: string,
    request: Request,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied =
      requireActiveTenant(auth, tenantId) ??
      requireCapability(auth, Capability.IdpConfigure);
    if (denied) return denied;

    const { z } = await import("zod");
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return badRequest("Body must be valid JSON", "INVALID_JSON");
    }

    const isStatus = typeof (raw as { status?: unknown })?.status === "string";

    if (isStatus) {
      const schema = z.object({ status: z.enum(["ACTIVE", "DISABLED"]) });
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        return badRequest("status must be ACTIVE or DISABLED");
      }
      return this.applyStatus(tenantId, parsed.data as PatchBodyStatus, auth, env);
    }

    const schema = z.object({
      clientSecret: z.string().min(1).max(2048).optional(),
      attributeMapping: z.record(z.string(), z.string()).optional(),
      defaultRole: z
        .enum(["ADMIN", "MEMBER", "GUEST"])
        .nullable()
        .optional(),
      scopes: z.string().max(1024).optional(),
    });
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message ?? "Invalid input");
    }
    const body = parsed.data as PatchBodyConfig;

    if (
      body.clientSecret === undefined &&
      body.attributeMapping === undefined &&
      body.defaultRole === undefined &&
      body.scopes === undefined
    ) {
      return badRequest("At least one of clientSecret, attributeMapping, defaultRole or scopes is required");
    }

    return this.applyConfig(tenantId, body, auth, env);
  }

  private async applyStatus(
    tenantId: string,
    body: PatchBodyStatus,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const row = await db.tenantIdentityProvider.findUnique({
      where: { tenantId },
      select: { id: true, status: true, cognitoIdpName: true },
    });
    if (!row) return notFound();

    if (row.status === body.status) {
      return jsonResponse(200, { id: row.id, status: row.status, unchanged: true });
    }

    const userPoolId = env.COGNITO_USER_POOL_ID;
    const userPoolClientId = env.COGNITO_APP_CLIENT_ID;
    if (!userPoolId || !userPoolClientId) return badGateway();

    const idp = this.getIdp(env);
    const op = body.status === "ACTIVE" ? "add" : "remove";
    try {
      // 15s — see handleCreate; the Cognito Describe+Update under the
      // advisory lock can exceed Prisma's default 5s.
      await db.$transaction(
        async (tx) => {
          await withUserPoolClientLock(tx, userPoolId, async () => {
            await idp.setSupportedIdentityProvider(
              userPoolId,
              userPoolClientId,
              row.cognitoIdpName,
              op,
            );
          });
          await tx.tenantIdentityProvider.update({
            where: { id: row.id },
            data: {
              status: body.status as IdpStatus,
              ...(body.status === "ACTIVE" ? { enabledAt: new Date() } : {}),
            },
          });
        },
        { timeout: 15000 },
      );
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "IdP status toggle failed",
          tenantId,
          errName: (err as { name?: string }).name,
        }),
      );
      return badGateway();
    }

    if (body.status === "DISABLED") {
      await this.invalidateAllMemberClaims(tenantId, env);
    }

    void auditEmitter
      .emit(
        {
          type:
            body.status === "DISABLED"
              ? AuditEventType.TENANT_IDP_DISABLED
              : AuditEventType.TENANT_IDP_MODIFIED,
          tenantId,
          actorUserId: auth.userId,
          payload: { idpStatus: body.status },
        },
        db,
      )
      .catch((err: unknown) =>
        console.warn(
          JSON.stringify({
            event: "audit.emit_failed",
            error: (err as { message?: string })?.message ?? "unknown",
          }),
        ),
      );

    return jsonResponse(200, { id: row.id, status: body.status });
  }

  private async applyConfig(
    tenantId: string,
    body: PatchBodyConfig,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const row = await db.tenantIdentityProvider.findUnique({
      where: { tenantId },
      select: {
        id: true,
        kind: true,
        cognitoIdpName: true,
        attributeMapping: true,
        scopes: true,
      },
    });
    if (!row) return notFound();
    if (row.kind !== "OIDC") {
      return jsonResponse(501, {
        error: "SAML_NOT_AVAILABLE_IN_MVP",
        message: "SAML providers cannot be modified in MVP",
      });
    }

    const userPoolId = env.COGNITO_USER_POOL_ID;
    if (!userPoolId) return badGateway();

    const idp = this.getIdp(env);
    const secrets = this.getSecrets(env);

    const newAttributeMapping = body.attributeMapping
      ? mergeAttributeMapping(row.attributeMapping, body.attributeMapping)
      : undefined;

    // Cognito UpdateIdentityProvider goes first. If it fails, Secrets Manager
    // is untouched and the old client secret remains the source of truth. The
    // create flow is structured the other way (secret first) because the
    // secret must exist before Cognito can reference it; rotation has no such
    // ordering constraint.
    try {
      await idp.updateOidcProvider({
        userPoolId,
        providerName: row.cognitoIdpName,
        ...(body.clientSecret !== undefined
          ? { details: { clientSecret: body.clientSecret, ...(body.scopes ? { scopes: body.scopes } : {}) } }
          : body.scopes
            ? { details: { scopes: body.scopes } }
            : {}),
        ...(newAttributeMapping ? { attributeMapping: newAttributeMapping } : {}),
      });
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "Cognito UpdateIdentityProvider failed",
          tenantId,
          errName: (err as { name?: string }).name,
        }),
      );
      return badGateway();
    }

    if (body.clientSecret !== undefined) {
      try {
        await secrets.rotate(tenantId, body.clientSecret);
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: "warn",
            msg: "idp-secret rotate failed",
            tenantId,
            errName: (err as { name?: string }).name,
          }),
        );
        return badGateway();
      }
    }

    const data: Prisma.TenantIdentityProviderUpdateInput = {};
    if (newAttributeMapping) data.attributeMapping = newAttributeMapping as Prisma.InputJsonValue;
    if (body.defaultRole !== undefined) data.defaultRole = body.defaultRole;
    if (body.scopes !== undefined) data.scopes = body.scopes;

    const updated = await db.tenantIdentityProvider.update({
      where: { id: row.id },
      data,
      select: {
        id: true,
        tenantId: true,
        kind: true,
        status: true,
        cognitoIdpName: true,
        issuerUrl: true,
        clientId: true,
        defaultRole: true,
        attributeMapping: true,
        scopes: true,
        enabledAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    void auditEmitter
      .emit(
        {
          type: AuditEventType.TENANT_IDP_MODIFIED,
          tenantId,
          actorUserId: auth.userId,
          payload: {
            idpKind: row.kind,
            changedAttributes: Object.keys(data),
          },
        },
        db,
      )
      .catch((err: unknown) =>
        console.warn(
          JSON.stringify({
            event: "audit.emit_failed",
            error: (err as { message?: string })?.message ?? "unknown",
          }),
        ),
      );

    return jsonResponse(200, formatIdpRecord(updated));
  }

  // ── DELETE ─────────────────────────────────────────────────────────────────
  async handleDelete(
    tenantId: string,
    url: URL,
    auth: AuthContext,
    env: Env,
  ): Promise<Response> {
    const denied =
      requireActiveTenant(auth, tenantId) ??
      requireCapability(auth, Capability.IdpConfigure);
    if (denied) return denied;

    if (url.searchParams.get("confirm") !== "true") {
      return jsonResponse(400, {
        error: "CONFIRM_REQUIRED",
        message: "Disconnecting an IdP requires confirm=true",
        remediation: `DELETE /api/tenants/${tenantId}/identity-provider?confirm=true`,
      });
    }

    const { createPrisma } = await import("../../db.js");
    const db = createPrisma(env);

    const row = await db.tenantIdentityProvider.findUnique({
      where: { tenantId },
      select: { id: true, cognitoIdpName: true, kind: true },
    });
    if (!row) return notFound();

    const userPoolId = env.COGNITO_USER_POOL_ID;
    const userPoolClientId = env.COGNITO_APP_CLIENT_ID;
    if (!userPoolId || !userPoolClientId) return badGateway();

    const idp = this.getIdp(env);
    const secrets = this.getSecrets(env);

    try {
      // 15s — see handleCreate; both Cognito calls happen under the advisory
      // lock and can exceed Prisma's default 5s.
      await db.$transaction(
        async (tx) => {
          await withUserPoolClientLock(tx, userPoolId, async () => {
            await idp.setSupportedIdentityProvider(
              userPoolId,
              userPoolClientId,
              row.cognitoIdpName,
              "remove",
            );
          });
          await idp.deleteProvider(userPoolId, row.cognitoIdpName);
          await tx.tenantIdentityProvider.delete({ where: { id: row.id } });
        },
        { timeout: 15000 },
      );
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "IdP delete failed",
          tenantId,
          errName: (err as { name?: string }).name,
        }),
      );
      return badGateway();
    }

    await secrets.delete(tenantId).catch(() => undefined);
    await this.invalidateAllMemberClaims(tenantId, env);

    await bestEffortGlobalSignOutAllMembers(env, tenantId, db);

    void auditEmitter
      .emit(
        {
          type: AuditEventType.TENANT_IDP_DELETED,
          tenantId,
          actorUserId: auth.userId,
          payload: { idpKind: row.kind },
        },
        db,
      )
      .catch((err: unknown) =>
        console.warn(
          JSON.stringify({
            event: "audit.emit_failed",
            error: (err as { message?: string })?.message ?? "unknown",
          }),
        ),
      );

    return jsonResponse(200, { ok: true });
  }
}

function mergeAttributeMapping(
  existing: unknown,
  incoming: IdpAttributeMapping,
): IdpAttributeMapping {
  const base: IdpAttributeMapping =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as IdpAttributeMapping)
      : defaultOidcAttributeMapping();
  return { ...base, ...incoming };
}

interface FormattedIdp {
  id: string;
  tenantId: string;
  kind: IdpKind;
  status: IdpStatus;
  cognitoIdpName: string;
  issuerUrl: string | null;
  clientId: string | null;
  defaultRole: TenantRole | null;
  attributeMapping: unknown;
  scopes: string;
  enabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function formatIdpRecord(row: FormattedIdp): Record<string, unknown> {
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    status: row.status,
    cognitoIdpName: row.cognitoIdpName,
    issuerUrl: row.issuerUrl,
    clientId: row.clientId,
    defaultRole: row.defaultRole,
    attributeMapping: row.attributeMapping,
    scopes: row.scopes,
    enabledAt: row.enabledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function bestEffortGlobalSignOutAllMembers(
  env: Env,
  tenantId: string,
  db: PrismaClient,
): Promise<void> {
  const userPoolId = env.COGNITO_USER_POOL_ID;
  if (!userPoolId) return;
  let usernames: string[] = [];
  try {
    const members = await db.tenantMember.findMany({
      where: { tenantId },
      select: { user: { select: { email: true } } },
    });
    usernames = members.map((m) => m.user.email).filter((e): e is string => !!e);
  } catch {
    return;
  }
  if (usernames.length === 0) return;
  try {
    const { CognitoIdentityProviderClient: CIP, AdminUserGlobalSignOutCommand } =
      await import("@aws-sdk/client-cognito-identity-provider");
    const client = new CIP({
      region: env.COGNITO_REGION ?? process.env.AWS_REGION,
    });
    await Promise.all(
      usernames.map((u) =>
        client
          .send(new AdminUserGlobalSignOutCommand({ UserPoolId: userPoolId, Username: u }))
          .catch((err) => {
            console.warn(
              JSON.stringify({
                level: "warn",
                msg: "AdminUserGlobalSignOut failed (best effort)",
                tenantId,
                errName: (err as { name?: string }).name,
              }),
            );
          }),
      ),
    );
  } catch {
    return;
  }
}
