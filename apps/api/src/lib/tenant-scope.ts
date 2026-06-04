/**
 * Tenant scoping — WS2 of the multi-tenancy plan
 * (saas-foundation doc/14-multi-tenancy/06-implementation-plan.md).
 *
 * A Prisma client extension that scopes queries on tenant-owned models to the
 * **active tenant** carried in foundation's AsyncLocalStorage
 * (`getCurrentTenantId`, set by the auth seam — WS1). It is the Proxy-safe
 * first line of isolation; PostgreSQL RLS (WS3) is the fail-closed backstop for
 * paths this extension cannot cover (raw SQL, `findUnique`-by-id, nested writes).
 *
 * Modes:
 *  - `off`     — not attached (zero behavior change). The default.
 *  - `shadow`  — observe only: logs where a scoped query lacks a tenant filter
 *                or runs with no tenant context. Does NOT modify any query.
 *  - `enforce` — injects `tenantId = <active>` into where-mergeable reads/writes
 *                and sets `tenantId` on creates; throws on a scoped op with no
 *                tenant context (unless inside `runUnscoped`).
 *
 * `enforce` covers the where-mergeable operations (findMany/findFirst/count/
 * aggregate/groupBy/updateMany/deleteMany and create/createMany/upsert).
 * `findUnique`/`update`/`delete` by a unique selector cannot have a non-unique
 * `tenantId` merged into their `where`; those rely on the RLS backstop (WS3).
 * `shadow` logs all divergences regardless, so the gap is quantified first.
 *
 * SECURITY — `enforce` is a PARTIAL defense and must NOT be the sole isolation
 * mechanism (security review, doc/14). It does not cover: unique-selector reads/
 * writes (findUnique/update/delete by id), raw SQL ($queryRaw/$executeRaw), or
 * `by-relation` models without their own `tenantId`. Those are closed only by
 * the PostgreSQL RLS backstop (WS3). Do not enable `enforce` in production
 * before RLS is deployed; also note unauthenticated/public paths (federation)
 * that query scoped models must use `runUnscoped` or they fail closed (throw)
 * under `enforce` (review finding 2).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";
import { getCurrentTenantId } from "@de-otio/saas-foundation/tenant";
import { getLogger } from "./logger.js";

export type TenantScopeMode = "off" | "shadow" | "enforce";

/** Read `TENANT_SCOPE_MODE` (deploy flag); anything unrecognized → "off". */
export function resolveTenantScopeMode(
  raw: string | undefined = process.env.TENANT_SCOPE_MODE,
): TenantScopeMode {
  return raw === "shadow" || raw === "enforce" ? raw : "off";
}

/**
 * Models that carry their own `tenantId` and are safe to auto-scope by the
 * active tenant (doc/14 §04 group B). Keep in sync with the schema.
 */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
  "Post",
  "PostComment",
  "Entity",
  "Notification",
  "Group",
  "GroupMember",
  "EntityOwnership",
  "ConnectionCode",
  "ConnectionCodeRedemption",
  "TaxonomyDimension",
  "TaxonomyCategory",
  "TaxonomyTaxon",
  // Carries its own tenantId. Spatial reads/writes go through $queryRaw and so
  // bypass this middleware (scoped manually + RLS backstop), but classifying it
  // here keeps the model honest and auto-scopes any future Prisma-Client op.
  "EntityLocation",
  // Graph edge tables (graph-db revisit 2026-06: the social graph runs in
  // Postgres). Both carry tenantId; PostgresGraphService additionally scopes
  // its queries manually (and its recursive-CTE $queryRaw paths, which bypass
  // this middleware, always filter tenant_id explicitly).
  "Relationship",
  "EntityRelationship",
]);

/**
 * Every other model, with the reason it is NOT auto-scoped. Exhaustive on
 * purpose: the coverage test asserts every Prisma model is either here or in
 * TENANT_SCOPED_MODELS, so a newly added model fails CI until classified
 * (doc/14 §05 WS4 — "no silent holes").
 */
export const UNSCOPED_MODELS: ReadonlyMap<string, string> = new Map([
  // Tenant-admin: bespoke authz (requireActiveTenant/requireOwnTenant) plus the
  // cross-tenant membership loader (auth-middleware queries TenantMember across
  // tenants) — auto-filtering by active tenant would break it.
  ["Tenant", "tenant-admin"],
  ["TenantMember", "tenant-admin"],
  ["TenantDomain", "tenant-admin"],
  ["TenantIdentityProvider", "tenant-admin"],
  ["TenantRoleMapping", "tenant-admin"],
  ["TenantInvitation", "tenant-admin"],
  // Global by design.
  ["Activity", "global"],
  ["DomainReputation", "global"],
  ["EmailSuppression", "global"],
  ["FeatureToggle", "global"],
  ["IngestState", "global"],
  ["RoleMetadata", "global"],
  ["MediaFile", "global-content-addressed"],
  // User-scoped (boundary is userId, not tenant).
  ["User", "user"],
  ["CircleConfig", "user"],
  ["CircleReadState", "user"],
  ["CustomAudience", "user"],
  ["CustomAudienceMember", "user"],
  ["UploadSession", "user"],
  ["MfaEnrollment", "user"],
  ["UserEncryptionKey", "user"],
  ["Consent", "user"],
  ["NotificationPreference", "user"],
  ["LinkReport", "user"],
  ["ParentalLink", "user"],
  ["DeletionAuditLog", "user"],
  ["Invitation", "user"],
  ["DirectMessage", "user-pair"],
  // Scoped-by-relation: no own tenantId yet (doc/14 §04 C / WS0). Rely on the
  // parent's scope + the RLS backstop until tenantId is denormalized onto them.
  ["PostMedia", "by-relation"],
  ["PostSentiment", "by-relation"],
  ["PostSubject", "by-relation"],
  ["PostCommentMedia", "by-relation"],
  ["CommentSentiment", "by-relation"],
  ["EntityTaxonomyTag", "by-relation"],
  ["PostTaxonomyTag", "by-relation"],
  ["ProductTaxonomyTag", "by-relation-orphan"],
  ["LinkCheck", "by-relation"],
  ["PostGeoIndex", "by-relation"],
  // Audit: nullable tenantId (system rows) — handled by an RLS policy (WS3),
  // not the auto-scope filter.
  ["SecurityEvent", "audit-nullable"],
  ["AuditEvent", "audit-nullable"],
]);

// Operations whose `where` can safely have `{ tenantId }` AND-merged in.
const WHERE_MERGEABLE = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);
// `create`/`createMany`/`upsert` are stamped with the active tenant, and
// unique-selector ops (`findUnique`/`update`/`delete`) fall through to the RLS
// backstop (WS3) — both handled inline in `planTenantScope`.

// Escape hatch for legitimate cross-tenant work (super-admin tooling, the
// ActivityPub federation graph, operator analytics, the membership loader).
const unscopedStorage = new AsyncLocalStorage<true>();

/**
 * Run `fn` with tenant scoping disabled (cross-tenant/operator paths: super-admin
 * tooling, the federation graph, operator analytics, the membership loader).
 * Requires a `reason` and logs every entry, so disabling isolation is always
 * auditable (security review finding 5).
 */
export function runUnscoped<T>(reason: string, fn: () => T): T {
  getLogger().warn("[tenant-scope] unscoped (cross-tenant) execution", { reason });
  return unscopedStorage.run(true, fn);
}
function isUnscoped(): boolean {
  return unscopedStorage.getStore() === true;
}

function andWhere(where: unknown, tenantId: string): Record<string, unknown> {
  if (where && typeof where === "object") {
    return { AND: [where as Record<string, unknown>, { tenantId }] };
  }
  return { tenantId };
}

/** Outcome of the pure scoping decision; the extension maps it onto Prisma. */
export type ScopePlan =
  | { action: "passthrough" } // not scoped / off / unscoped / unique-op
  | { action: "throw"; message: string } // enforce, no tenant context
  | { action: "observe"; wouldScope: boolean } // shadow, tenant present
  | { action: "observe-no-context" } // shadow, no tenant context
  | { action: "rewrite"; args: Record<string, unknown> }; // enforce rewrite

/**
 * Pure decision for one Prisma operation — no I/O, no Prisma types. The
 * extension supplies the ambient `tenantId` and `unscoped` flag. Unit-tested
 * exhaustively; the extension is the thin imperative shell around it.
 */
export function planTenantScope(input: {
  mode: TenantScopeMode;
  model: string;
  operation: string;
  args: Record<string, unknown> | undefined;
  tenantId: string | undefined;
  unscoped: boolean;
}): ScopePlan {
  const { mode, model, operation, args, tenantId, unscoped } = input;

  if (mode === "off" || unscoped || !TENANT_SCOPED_MODELS.has(model)) {
    return { action: "passthrough" };
  }

  if (!tenantId) {
    return mode === "enforce"
      ? {
          action: "throw",
          message: `[tenant-scope] ${model}.${operation} ran with no tenant context`,
        }
      : { action: "observe-no-context" };
  }

  if (mode === "shadow") {
    const w = (args?.where as Record<string, unknown> | undefined) ?? undefined;
    const wouldScope = !(
      w && Object.prototype.hasOwnProperty.call(w, "tenantId")
    );
    return { action: "observe", wouldScope };
  }

  // enforce
  const a = args ?? {};
  if (WHERE_MERGEABLE.has(operation)) {
    return { action: "rewrite", args: { ...a, where: andWhere(a.where, tenantId) } };
  }
  if (operation === "create") {
    return { action: "rewrite", args: { ...a, data: { ...(a.data as object), tenantId } } };
  }
  if (operation === "createMany") {
    const data = a.data;
    const stamped = Array.isArray(data)
      ? data.map((d) => ({ ...(d as object), tenantId }))
      : { ...(data as object), tenantId };
    return { action: "rewrite", args: { ...a, data: stamped } };
  }
  if (operation === "upsert") {
    return {
      action: "rewrite",
      args: {
        ...a,
        where: andWhere(a.where, tenantId),
        create: { ...(a.create as object), tenantId },
        update: a.update,
      },
    };
  }
  // UNIQUE_OPS and anything else: cannot merge a non-unique tenantId — rely on
  // the RLS backstop (WS3).
  return { action: "passthrough" };
}

/**
 * Build the tenant-scoping Prisma extension for the given mode. Attach with
 * `prisma.$extends(tenantScopeExtension(mode))`. The imperative shell around
 * `planTenantScope`: gathers ambient state, logs (shadow), throws/rewrites
 * (enforce). `args` is strongly typed per-model by Prisma; a generic extension
 * rewrites uniformly, so the rewritten shape passes through `query` with a cast
 * (the documented pattern for `$allModels.$allOperations`).
 */
export function tenantScopeExtension(mode: TenantScopeMode) {
  return Prisma.defineExtension({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const plan = planTenantScope({
            mode,
            model,
            operation,
            args: args as Record<string, unknown> | undefined,
            tenantId: getCurrentTenantId(),
            unscoped: isUnscoped(),
          });

          switch (plan.action) {
            case "passthrough":
              return query(args);
            case "throw":
              throw new Error(plan.message);
            case "observe-no-context":
              getLogger().warn(
                "[tenant-scope:shadow] scoped op with no tenant context",
                { model, operation },
              );
              return query(args);
            case "observe":
              if (plan.wouldScope) {
                getLogger().info("[tenant-scope:shadow] would scope query", {
                  model,
                  operation,
                });
              }
              return query(args);
            case "rewrite":
              return query(plan.args as typeof args);
          }
        },
      },
    },
  });
}
