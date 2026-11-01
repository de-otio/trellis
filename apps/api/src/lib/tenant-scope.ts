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
 *  - `shadow`  — observe only: logs where a scoped query lacks a tenant filter,
 *                runs with no tenant context, or carries a write payload that
 *                `enforce` would reject. Does NOT modify any query.
 *  - `enforce` — injects `tenantId = <active>` into where-mergeable reads/writes
 *                and sets `tenantId` on creates; throws on a scoped op with no
 *                tenant context (unless inside `runUnscoped`) and on a write
 *                that would reassign a row's tenant (below).
 *
 * `enforce` covers the where-mergeable operations (findMany/findFirst/count/
 * aggregate/groupBy/updateMany/updateManyAndReturn/deleteMany and create/
 * createMany/createManyAndReturn/upsert). `findUnique`/`update`/`delete` by a
 * unique selector cannot have a non-unique `tenantId` merged into their
 * `where`; those rely on the RLS backstop (WS3). `shadow` logs all divergences
 * regardless, so the gap is quantified first.
 *
 * Tenant reassignment on writes: `enforce` rejects, rather than rewrites, any
 * write payload (`data` of create/createMany/update/updateMany and their
 * `*AndReturn` forms, both halves of `upsert`, and nested relation writes inside
 * them) that sets `tenantId` to anything but the active tenant or writes the
 * `tenant` relation. Merging `tenantId` into the `where` only proves the row
 * starts in the active tenant; this check keeps it there. This matches the
 * ext_* proxy (`extension-scoped-db.ts`), except that an explicit `tenantId`
 * equal to the active tenant is allowed. Creates are still stamped with the
 * active tenant when `tenantId` is absent.
 *
 * Nested rows and links are held to the active tenant whenever their model has
 * its own `tenantId` column: the scoped models above and the by-relation
 * children that denormalize it (PostMedia, LinkCheck, …), but not the
 * tenant-admin tables. `enforce` narrows every nested `connect`, `set`,
 * `disconnect` and `connectOrCreate.where` into such a model to the active
 * tenant (adds `tenantId` to the unique selector), so a link to another
 * tenant's row matches nothing and the write fails. `shadow` cannot tell
 * which tenant a selector points at, so it does not report these.
 *
 * Unscoped roots: a write on an unscoped model (`user.update`, …) run with an
 * active tenant gets the same checks and link narrowing for its nested rows.
 * The unscoped root row's own `tenantId` is not checked, and with no active
 * tenant the op passes through.
 *
 * SECURITY — `enforce` is a PARTIAL defense and must NOT be the sole isolation
 * mechanism (security review, doc/14). It does not cover: unique-selector reads/
 * deletes and the `where` of a by-id `update` (findUnique/update/delete by id),
 * raw SQL ($queryRaw/$executeRaw), `by-relation` models without their own
 * `tenantId`. Those are closed only by the PostgreSQL RLS backstop (WS3).
 * Neither layer checks the target of a scalar foreign key (`postId`): Postgres
 * FK checks bypass RLS. The schema closes that for FKs between tenant-holding
 * tables with tenant-qualified keys (`(tenant_id, post_id) -> posts(tenant_id,
 * id)`, test/integration/schema/tenant-qualified-fk-shape). A pointer with no
 * FK (polymorphic ids, bare scalars) is still unchecked, so a handler that
 * takes one from a request must load it through a scoped read first. Do
 * not enable `enforce` in production before RLS is deployed; also note
 * unauthenticated/public paths (federation) that query scoped models must use
 * `runUnscoped` or they fail closed (throw) under `enforce` (review finding 2).
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
  // "by-relation" (with a denormalized tenantId) and crosses the scope
  // boundary via the post→media join — flagged for T9/integration.
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
  // Scoped-by-relation (doc/14 §04 C / WS0): isolation flows through the
  // parent. Several now carry a denormalized tenantId (PostMedia,
  // PostSentiment, LinkCheck, PostGeoIndex, ProductTaxonomyTag); those have
  // their own RLS policy and are held to the active tenant when written as
  // nested rows. The rest rely on the parent's scope.
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
  // ReportCategory (compliance plan 08 §2.1): no tenantId column — a
  // platform-global, deployment-seeded vocabulary written only by SUPER_ADMIN
  // (report-category-admin) and read everywhere the report path routes. Global,
  // exactly like PlatformCategory.
  ["ReportCategory", "global"],
  // StatementOfReasons (compliance plan 08 §2.4) + AuthorityReport (§2.6):
  // compliance-enforcement records keyed by affectedUserId / evidenceId, not a
  // tenant. No tenantId column; written by the takedown/authority core and read
  // by the operator surface. Global-platform posture (like Report), never
  // auto-scoped by tenant.
  ["StatementOfReasons", "user"],
  ["AuthorityReport", "global"],
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
  "updateManyAndReturn",
  "deleteMany",
]);
// `create`/`createMany`/`createManyAndReturn`/`upsert` are stamped with the
// active tenant, and unique-selector ops (`findUnique`/`update`/`delete`) keep
// their `where` and fall through to the RLS backstop (WS3) — both handled
// inline in `planTenantScope`.

/**
 * The row-data payloads each write operation carries. These are what the
 * tenant-reassignment guard inspects; `where` selectors are never inspected
 * (a filter on another tenant matches nothing once the where is merged).
 */
function writePayloads(operation: string, a: Record<string, unknown>): unknown[] {
  switch (operation) {
    case "create":
    case "createMany":
    case "createManyAndReturn":
    case "update":
    case "updateMany":
    case "updateManyAndReturn":
      return [a.data];
    case "upsert":
      return [a.create, a.update];
    default:
      return [];
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    !(v instanceof Uint8Array)
  );
}

/**
 * Nested relation-write operators that carry row data of their own, mapped to
 * where in their payload the rows sit. `connect`/`disconnect`/`set`/`delete`/
 * `deleteMany` carry only selectors, so they are not listed.
 */
const NESTED_ROW_DATA: ReadonlyMap<string, (op: Record<string, unknown>) => unknown[]> = new Map([
  ["create", (op) => [op]],
  ["createMany", (op) => [op.data]],
  ["connectOrCreate", (op) => [op.create]],
  // To-many `update` is `{ where, data }`; to-one `update` is the row itself
  // or `{ where?, data }`. A row whose only keys are `where`/`data` is
  // indistinguishable from the wrapper by value, so both readings are checked.
  ["update", (op) => (isWhereDataWrapper(op) ? [op.data, op] : [op])],
  ["updateMany", (op) => [op.data]],
  ["upsert", (op) => [op.create, op.update]],
]);

function isWhereDataWrapper(op: Record<string, unknown>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(op, "data") &&
    Object.keys(op).every((k) => k === "where" || k === "data")
  );
}

/** A `tenantId` write that keeps the row in the active tenant (or is omitted). */
function isSameTenantValue(value: unknown, tenantId: string): boolean {
  if (value === undefined || value === tenantId) return true;
  // Prisma's scalar update form `{ set: <value> }`.
  return isPlainObject(value) && Object.keys(value).length === 1 && value.set === tenantId;
}

/**
 * Relation fields per model (field name → target model), from the generated
 * schema. The guard recurses only through these, so a Json column whose
 * content happens to contain `create`/`update`/`tenantId` keys is data, not a
 * nested write. Built on first use, so importing this module does not touch
 * the generated client (several unit suites mock `@prisma/client` without it).
 */
let relationFields: ReadonlyMap<string, ReadonlyMap<string, string>> | undefined;
function relationFieldsOf(model: string): ReadonlyMap<string, string> | undefined {
  relationFields ??= new Map(
    Prisma.dmmf.datamodel.models.map((m) => [
      m.name,
      new Map(m.fields.filter((f) => f.kind === "object").map((f) => [f.name, f.type])),
    ]),
  );
  return relationFields.get(model);
}

let tenantColumnModels: ReadonlySet<string> | undefined;
/**
 * Whether a row of `model`, written as a NESTED row or linked from another
 * row, is held to the active tenant: every model with its own `tenantId`
 * column, including the by-relation children that denormalize it (PostMedia,
 * LinkCheck, …), except tenant-admin tables, where pointing at another tenant
 * is the point (a membership in another tenant). A model missing from the
 * schema (not expected) is held, so the guard fails closed.
 */
function holdsTenant(model: string): boolean {
  tenantColumnModels ??= new Set(
    Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === "tenantId" && f.kind === "scalar"))
      .map((m) => m.name),
  );
  if (relationFieldsOf(model) === undefined) return true;
  return tenantColumnModels.has(model) && UNSCOPED_MODELS.get(model) !== "tenant-admin";
}

/**
 * Find a write that would place a row in a tenant other than the active one:
 * a `tenantId` that differs from it, or any write to the `tenant` relation.
 * Recurses through nested relation writes. Returns the path of the first
 * offending field, or `null`. The value itself is never echoed (it is
 * caller-supplied).
 *
 * `held` says whether this row's own `tenantId`/`tenant` is checked: for the
 * root row, whether its model is scoped (an unscoped root such as
 * TenantMember may name another tenant); for nested rows, {@link holdsTenant}.
 *
 * Mirrors the ext_* proxy's tenant-field guard (`extension-scoped-db.ts`),
 * with one difference: core callers commonly pass the active tenant's id
 * explicitly, so an equal `tenantId` is allowed here rather than rejected.
 */
function findTenantReassignment(
  rows: unknown,
  model: string,
  held: boolean,
  tenantId: string,
  path: string,
): string | null {
  if (Array.isArray(rows)) {
    for (const [i, row] of rows.entries()) {
      const hit = findTenantReassignment(row, model, held, tenantId, `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (!isPlainObject(rows)) return null;
  const relations = relationFieldsOf(model);
  for (const [key, value] of Object.entries(rows)) {
    if (held && key === "tenantId") {
      if (!isSameTenantValue(value, tenantId)) return `${path}.tenantId`;
      continue;
    }
    if (held && key === "tenant") {
      if (value !== undefined) return `${path}.tenant`;
      continue;
    }
    // A nested relation write: a relation field holding an object keyed by
    // relation-write operators. Scalars, Json columns and `{ increment: 1 }`
    // are data. A model missing from the schema (not expected) is walked
    // without that filter, so the guard fails closed.
    const target = relations ? relations.get(key) : model;
    if (target === undefined || !isPlainObject(value)) continue;
    for (const [op, payload] of Object.entries(value)) {
      const rowsOf = NESTED_ROW_DATA.get(op);
      if (!rowsOf) continue;
      const wrappers = Array.isArray(payload) ? payload : [payload];
      for (const [i, wrapper] of wrappers.entries()) {
        if (!isPlainObject(wrapper)) continue;
        const at = Array.isArray(payload) ? `${path}.${key}.${op}[${i}]` : `${path}.${key}.${op}`;
        for (const nested of rowsOf(wrapper)) {
          const hit = findTenantReassignment(nested, target, holdsTenant(target), tenantId, at);
          if (hit) return hit;
        }
      }
    }
  }
  return null;
}

/** The guard for one operation: the offending field path, or `null`. */
function tenantReassignment(
  model: string,
  operation: string,
  a: Record<string, unknown>,
  tenantId: string,
): string | null {
  const labels = operation === "upsert" ? ["create", "update"] : ["data"];
  const payloads = writePayloads(operation, a);
  for (const [i, payload] of payloads.entries()) {
    const hit = findTenantReassignment(
      payload,
      model,
      TENANT_SCOPED_MODELS.has(model),
      tenantId,
      labels[i],
    );
    if (hit) return hit;
  }
  return null;
}

/** The payload keys of `a` that carry row data for `operation`. */
function writePayloadKeys(operation: string): readonly string[] {
  if (operation === "upsert") return ["create", "update"];
  return writePayloads(operation, {}).length > 0 ? ["data"] : [];
}

/** Narrow a unique selector to the active tenant (`{ id }` → `{ id, tenantId }`). */
function scopeSelector(selector: unknown, tenantId: string): unknown {
  return isPlainObject(selector) ? { ...selector, tenantId } : selector;
}

function scopeSelectors(selectors: unknown, tenantId: string): unknown {
  return Array.isArray(selectors)
    ? selectors.map((s) => scopeSelector(s, tenantId))
    : scopeSelector(selectors, tenantId);
}

/** Apply `fn` to one item or to each item of an array. */
function eachOf(value: unknown, fn: (item: unknown) => unknown): unknown {
  return Array.isArray(value) ? value.map(fn) : fn(value);
}

/**
 * Rewrite one nested relation write (`{ connect: …, create: … }`) on a field
 * whose target is `target`. Links to an existing row (`connect`, `set`,
 * `disconnect`, the `where` of `connectOrCreate`) into a model that
 * {@link holdsTenant} gain `tenantId: <active>`, so a row in another tenant
 * matches nothing and Prisma fails the write. Row data (`create`, `update`,
 * `upsert`, the `create` of `connectOrCreate`) is walked for further nested
 * links.
 */
function scopeRelationWrite(
  ops: Record<string, unknown>,
  target: string,
  tenantId: string,
): Record<string, unknown> {
  const scoped = holdsTenant(target);
  const rows = (v: unknown) => scopeNestedLinks(v, target, tenantId);
  return Object.fromEntries(
    Object.entries(ops).map(([op, payload]) => {
      switch (op) {
        case "connect":
        case "set":
        case "disconnect":
          return [op, scoped ? scopeSelectors(payload, tenantId) : payload];
        case "connectOrCreate":
          return [
            op,
            eachOf(payload, (c) =>
              isPlainObject(c)
                ? {
                    ...c,
                    where: scoped ? scopeSelector(c.where, tenantId) : c.where,
                    create: rows(c.create),
                  }
                : c,
            ),
          ];
        case "create":
          return [op, eachOf(payload, rows)];
        case "update":
          return [
            op,
            eachOf(payload, (u) =>
              isPlainObject(u) && isWhereDataWrapper(u) ? { ...u, data: rows(u.data) } : rows(u),
            ),
          ];
        case "upsert":
          return [
            op,
            eachOf(payload, (u) =>
              isPlainObject(u) ? { ...u, create: rows(u.create), update: rows(u.update) } : u,
            ),
          ];
        default:
          // createMany/updateMany rows cannot nest relation writes; the rest are
          // selectors relative to the parent row.
          return [op, payload];
      }
    }),
  );
}

/**
 * Return a copy of a write payload in which every nested link into a scoped
 * model is narrowed to the active tenant (see {@link scopeRelationWrite}).
 * Follows relation fields only, like the reassignment guard. Never mutates
 * the input.
 */
function scopeNestedLinks(rows: unknown, model: string, tenantId: string): unknown {
  if (Array.isArray(rows)) return rows.map((r) => scopeNestedLinks(r, model, tenantId));
  if (!isPlainObject(rows)) return rows;
  const relations = relationFieldsOf(model);
  return Object.fromEntries(
    Object.entries(rows).map(([key, value]) => {
      const target = relations ? relations.get(key) : model;
      return target !== undefined && isPlainObject(value)
        ? [key, scopeRelationWrite(value, target, tenantId)]
        : [key, value];
    }),
  );
}

/**
 * Whether a write payload holds a selector link (not `disconnect: true`) into
 * a model that {@link holdsTenant}, at any depth.
 */
function hasNestedLink(rows: unknown, model: string): boolean {
  if (Array.isArray(rows)) return rows.some((r) => hasNestedLink(r, model));
  if (!isPlainObject(rows)) return false;
  const relations = relationFieldsOf(model);
  return Object.entries(rows).some(([key, value]) => {
    const target = relations ? relations.get(key) : model;
    if (target === undefined || !isPlainObject(value)) return false;
    return Object.entries(value).some(([op, payload]) => {
      if (
        holdsTenant(target) &&
        (op === "connect" || op === "set" || op === "disconnect" || op === "connectOrCreate") &&
        (isPlainObject(payload) || Array.isArray(payload))
      ) {
        return true;
      }
      // createMany/updateMany rows cannot nest relation writes.
      const rowsOf =
        op === "createMany" || op === "updateMany" ? undefined : NESTED_ROW_DATA.get(op);
      if (!rowsOf) return false;
      return (Array.isArray(payload) ? payload : [payload]).some(
        (w) => isPlainObject(w) && rowsOf(w).some((r) => hasNestedLink(r, target)),
      );
    });
  });
}

/**
 * `a` with nested links in its write payloads narrowed to the active tenant,
 * or `a` itself (same reference) when it has none, so callers can pass the
 * operation through untouched.
 */
function scopeWriteLinks(
  model: string,
  operation: string,
  a: Record<string, unknown>,
  tenantId: string,
): Record<string, unknown> {
  const keys = writePayloadKeys(operation).filter((k) => hasNestedLink(a[k], model));
  if (keys.length === 0) return a;
  return {
    ...a,
    ...Object.fromEntries(keys.map((k) => [k, scopeNestedLinks(a[k], model, tenantId)])),
  };
}

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
  | { action: "throw"; message: string } // enforce: no tenant context, or tenant reassignment
  // shadow, tenant present. `wouldReject` is set when enforce would refuse the
  // write (the message enforce would throw).
  | { action: "observe"; wouldScope: boolean; wouldReject?: string }
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

  if (mode === "off" || unscoped) {
    return { action: "passthrough" };
  }

  if (!TENANT_SCOPED_MODELS.has(model)) {
    // The model itself is not scoped, but a write on it can still reach scoped
    // models through nested relation writes (`user.update` creating a
    // notification). With an active tenant, those nested rows and links are
    // held to it exactly as if they were written directly. Without one there is
    // nothing to hold them to.
    if (!tenantId) return { action: "passthrough" };
    const a = args ?? {};
    const reassigned = tenantReassignment(model, operation, a, tenantId);
    const rejection = reassigned
      ? `[tenant-scope] ${model}.${operation} writes ${reassigned}, which would move the row out of the active tenant`
      : undefined;
    if (mode === "shadow") {
      return rejection
        ? { action: "observe", wouldScope: false, wouldReject: rejection }
        : { action: "passthrough" };
    }
    if (rejection) return { action: "throw", message: rejection };
    const linked = scopeWriteLinks(model, operation, a, tenantId);
    return linked === a ? { action: "passthrough" } : { action: "rewrite", args: linked };
  }

  if (!tenantId) {
    return mode === "enforce"
      ? {
          action: "throw",
          message: `[tenant-scope] ${model}.${operation} ran with no tenant context`,
        }
      : { action: "observe-no-context" };
  }

  // Rebound once below, to the copy with nested links narrowed (never mutated).
  let a = args ?? {};
  const reassigned = tenantReassignment(model, operation, a, tenantId);
  const rejection = reassigned
    ? `[tenant-scope] ${model}.${operation} writes ${reassigned}, which would move the row out of the active tenant`
    : undefined;

  if (mode === "shadow") {
    const w = (args?.where as Record<string, unknown> | undefined) ?? undefined;
    const wouldScope = !(w && Object.prototype.hasOwnProperty.call(w, "tenantId"));
    return rejection
      ? { action: "observe", wouldScope, wouldReject: rejection }
      : { action: "observe", wouldScope };
  }

  // enforce
  if (rejection) return { action: "throw", message: rejection };
  // Nested links (`connect`/`set`/`disconnect`/`connectOrCreate.where`) into
  // scoped models are narrowed to the active tenant before the op is scoped.
  const original = a;
  a = scopeWriteLinks(model, operation, a, tenantId);
  if (WHERE_MERGEABLE.has(operation)) {
    return { action: "rewrite", args: { ...a, where: andWhere(a.where, tenantId) } };
  }
  if (operation === "create") {
    return { action: "rewrite", args: { ...a, data: { ...(a.data as object), tenantId } } };
  }
  if (operation === "createMany" || operation === "createManyAndReturn") {
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
  // Unique-selector ops and anything else: cannot merge a non-unique tenantId
  // into the where — rely on the RLS backstop (WS3). A by-unique `update` has
  // already had its data checked above, and its nested links narrowed.
  return a === original ? { action: "passthrough" } : { action: "rewrite", args: a };
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
              getLogger().warn("[tenant-scope:shadow] scoped op with no tenant context", {
                model,
                operation,
              });
              return query(args);
            case "observe":
              if (plan.wouldReject) {
                getLogger().warn("[tenant-scope:shadow] enforce would reject tenant reassignment", {
                  model,
                  operation,
                  reason: plan.wouldReject,
                });
              }
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
