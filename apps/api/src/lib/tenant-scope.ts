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
import {
  getExtensionModelRegistry,
  type ExtensionModelRegistryEntry,
} from "./extension-model-registry.js";
import { getLogger } from "./logger.js";

export type TenantScopeMode = "off" | "shadow" | "enforce";

/** Read `TENANT_SCOPE_MODE` (deploy flag); anything unrecognized → "off". */
export function resolveTenantScopeMode(
  raw: string | undefined = process.env.TENANT_SCOPE_MODE,
): TenantScopeMode {
  return raw === "shadow" || raw === "enforce" ? raw : "off";
}

/**
 * Convert a camelCase Prisma delegate key to its PascalCase model name, e.g.
 * `"dogReminder"` → `"DogReminder"`. Prisma lower-cases only the first character
 * of the model name to form the delegate key, so the inverse upper-cases it.
 */
export function delegateKeyToModelName(key: string): string {
  return key.length === 0 ? key : key[0].toUpperCase() + key.slice(1);
}

/**
 * The PascalCase model NAMES of the composed extension-owned (`ext_*`) models
 * that MUST be tenant-scoped (O-1 design §12.3 H1). Derived from the generated
 * {@link EXTENSION_MODEL_REGISTRY} (empty today — dogs owns no tables yet). Once
 * L2's composer populates the registry these join {@link TENANT_SCOPED_MODELS},
 * which (i) keeps the coverage tripwire green and (ii) gives defense-in-depth if
 * core ever flips to `enforce` (the L1 proxy's injection is idempotent under a
 * second AND-merge).
 */
export function extensionScopedModelNames(
  registry: readonly ExtensionModelRegistryEntry[] = getExtensionModelRegistry(),
): string[] {
  return registry.map((entry) => delegateKeyToModelName(entry.model));
}

/**
 * Models that carry their own `tenantId` and are safe to auto-scope by the
 * active tenant (doc/14 §04 group B). Keep in sync with the schema. The
 * composed `ext_*` models (O-1) are appended from the registry so an extension
 * table is never an unclassified hole in the coverage meta-test.
 */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set<string>([
  "Post",
  "PostComment",
  "Entity",
  "Notification",
  "BlockedUser",
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
  // D18: MediaFile is now tenant-scoped (carries its own tenantId). Dedup is
  // within-tenant via @@unique([tenantId, contentHash]). PostMedia is
  // "by-relation" (no own tenantId) and crosses the scope boundary via
  // the post→media join — flagged for T9/integration.
  "MediaFile",
  // Events primitive (R1 — HIGH-3 fix). All four carry their OWN denormalized
  // tenantId, so they are auto-scoped here (NOT by-relation). Handlers ALSO
  // filter tenantId explicitly (§4.4 belt-and-suspenders — the auto-scope
  // middleware is a no-op when TENANT_SCOPE_MODE is off, the default deploy).
  "Event",
  "Rsvp",
  "EventShift",
  "ShiftSignup",
  // Domain-event outbox (plan 034 lane E). Carries its own denormalized
  // tenantId, set explicitly at every emission point — an event is *about* a
  // tenant and must never be readable from another one, so it is classified
  // here rather than as a global log table. Nothing reads it yet, which is
  // exactly why classifying it now is cheap.
  "DomainEvent",
  // Composed extension-owned (`ext_*`) models — appended from the generated
  // registry (O-1 design §12.3 H1). Empty today; L2's composer populates it.
  ...extensionScopedModelNames(),
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
  ["RoleMetadata", "global"],
  // P0b moderation-message dedupe ledger: a system-global exactly-once table
  // keyed on an opaque messageDedupeKey. No tenantId column; identical bytes
  // share fan-in across tenants by design — never auto-scoped.
  ["ProcessedModerationMessage", "global"],
  // Note: MediaFile was here as "global-content-addressed" prior to D18.
  // It now carries its own tenantId and is in TENANT_SCOPED_MODELS above.
  // User-scoped (boundary is userId, not tenant).
  ["User", "user"],
  ["CircleConfig", "user"],
  ["CircleReadState", "user"],
  ["CustomAudience", "user"],
  ["CustomAudienceMember", "user"],
  ["UploadSession", "user"],
  ["MfaEnrollment", "user"],
  // T8 push device tokens: a device belongs to the ACCOUNT, not a tenant —
  // the wakeup dispatcher looks up by userId and devices follow the user
  // across tenants (lib/doc/push-device-contract.md §1).
  ["PushDevice", "user"],
  ["EncryptedUserSetting", "user"],
  ["Consent", "user"],
  ["NotificationPreference", "user"],
  // Generalized report model (Surveillance-hardening Phase 0, E3; folds in the
  // former LinkReport in P4). No own tenantId column; boundary is
  // reporterUserId. ACCOUNT reports key on an opaque resourceId, not a tenant.
  ["Report", "user"],
  ["ParentalLink", "user"],
  ["DeletionAuditLog", "user"],
  ["Invitation", "user"],
  ["DirectMessage", "user-pair"],
  // Scoped-by-relation: no own tenantId yet (doc/14 §04 C / WS0). Rely on the
  // parent's scope + the RLS backstop until tenantId is denormalized onto them.
  // P0b moderation job: tenant-scoped through its parent MediaFile via mediaId
  // (onDelete: Cascade). No own tenantId column, so it cannot be auto-scoped by
  // the where-merge/create-stamp extension — same posture as the other
  // by-relation child tables (parent scope + RLS backstop).
  ["MediaModerationJob", "by-relation"],
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
  // Append-only behavioral event log (Surveillance-hardening Phase 0, E1).
  // Nullable tenantId (single-tenant deployments write NULL); P2 stamps it
  // explicitly from the graph context. Not auto-scoped — same posture as the
  // other audit-nullable event tables (RLS backstop, retention-bound).
  ["InteractionEvent", "audit-nullable"],
  // Org classification + directory (org-classification-and-discovery T1).
  // PlatformCategory: no tenantId column — a platform-global curated
  // taxonomy table, written only by platform admins and read everywhere.
  ["PlatformCategory", "global"],
  // TenantClassification / TenantDirectoryProfile: each carries
  // tenantId @unique (1:1 with Tenant). Classified as tenant-admin for
  // the same reasons as TenantDomain / TenantIdentityProvider: the
  // platform-admin handler (platform-category-admin-handler) issues
  // cross-tenant `count` and `updateMany` to reclassify affected tenants
  // on category deactivation / reparent, and the directory-search path
  // queries TenantDirectoryProfile across ALL tenants. Auto-scoping by
  // the active tenant would silently break both. Authz (requireActiveTenant
  // / requireOwnTenant / admin role guard) enforces isolation at the
  // handler boundary; RLS backstop (WS3) is the second line.
  ["TenantClassification", "tenant-admin"],
  ["TenantDirectoryProfile", "tenant-admin"],
  // TenantClassificationTag: child of TenantClassification; carries a
  // denormalized tenantId for the index, but isolation flows through the
  // parent (same posture as EntityTaxonomyTag, PostTaxonomyTag).
  ["TenantClassificationTag", "by-relation"],
  // Open Social Web (follow-by-email + collections). EmailSubscription carries
  // its own tenantId for attribution but is NOT auto-scoped: the subscribe /
  // confirm / unsubscribe endpoints are ANONYMOUS (no active-tenant context)
  // and resolve rows by primary key or capability token; create stamps tenantId
  // explicitly via the composite unique. Collection is owner-scoped (boundary is
  // ownerUserId; public reads are anonymous, no tenant context). CollectionItem
  // has no tenantId — isolation flows through its parent Collection.
  ["EmailSubscription", "anonymous-capability"],
  ["Collection", "user"],
  ["CollectionItem", "by-relation"],
  // WS-1 KV port: the PostgresKvStore backing table. GLOBAL, never tenant-scoped
  // — every key is (namespace, key)-scoped, and the dedicated KV pool bypasses
  // the tenant Prisma extension entirely (it must not be auto-filtered by an
  // active tenant). See ws1-kv-port-plan §4.2.
  ["KvEntry", "global"],
  // WS-1 rate-limit port: the PostgresTokenBucketLimiter backing table. GLOBAL,
  // never tenant-scoped — every bucket_key is `<namespace>#<key>`-scoped, and the
  // dedicated rate-limit/KV pool bypasses the tenant Prisma extension. See
  // ws1-kv-port-plan §3.10/§4.2, security fix F5.
  ["RateLimitBucket", "global"],
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
