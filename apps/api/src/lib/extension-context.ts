/**
 * Extension Context Factory
 *
 * Builds the scoped ExtensionContext that extensions receive instead of the
 * full Env. Core secrets (SESSION_SECRET, DATABASE_URL, API keys) are never exposed.
 */

import type {
  ExtensionContext,
  ExtensionGraphService,
  DiscoverDb,
  ScopedDb,
  TenantId,
  TrellisExtension,
} from "@de-otio/trellis-extension-api";
import {
  buildScopedModelMetas,
  createScopedDb,
  type RawPrismaLike,
} from "./extension-scoped-db.js";
import { createDiscoverDb } from "./extension-discover-db.js";
import {
  createExtensionEventEmitter,
  type TransactionRunner,
} from "./events/extension-emitter.js";
import type { TenantId as CoreTenantId } from "./mint-tenant-id.js";
import { getCurrentTenantId } from "@de-otio/saas-foundation/tenant";
import type { GraphService } from "./graph/index.js";
import type {
  CircleTier,
  GraphNodeType,
  PaginationInput,
} from "./graph/types.js";
import type { Env } from "../env.js";

/**
 * The tenant an extension's circle read runs in.
 *
 * The core circle reads now REQUIRE an explicit tenant (H1 — see
 * lib/graph/postgres/circles.ts): the ambient filter they used to build silently
 * evaluated to nothing under the default `TENANT_SCOPE_MODE=off`, so those
 * queries carried no tenant predicate at all.
 *
 * `ExtensionGraphService` is the PUBLISHED `@de-otio/trellis-extension-api`
 * surface and its circle signatures carry no tenant, so this bridge is the only
 * place one can come from. It reads the ambient tenant and THROWS when there is
 * none, rather than passing an empty string through to a query — fail closed,
 * loudly, at the boundary.
 *
 * This leaves extensions unable to call the circle reads in the default
 * configuration. That is deliberate and is the correct interim state: the
 * alternative is serving them cross-tenant results. Giving extensions a
 * tenant-carrying graph surface is a breaking change to the published package
 * and is left to that package's next major (`db.tenant(tid)` already models the
 * shape it should take).
 */
function extensionTenant(): string {
  const tenantId = getCurrentTenantId();
  if (!tenantId) {
    throw new Error(
      "ExtensionGraphService: circle reads require an active tenant; " +
        "none is established (TENANT_SCOPE_MODE is off?)",
    );
  }
  return tenantId;
}

/**
 * Build a read-only proxy over GraphService.
 *
 * Exposes only query methods — write methods (syncUser, removeUser,
 * createRelationship, recordInteraction, etc.) are intentionally omitted
 * so extensions cannot mutate graph state.
 */
function createReadOnlyGraphService(graph: GraphService): ExtensionGraphService {
  return {
    getRelationship: graph.getRelationship.bind(graph),
    getRelationships: graph.getRelationships.bind(graph),
    getRelationshipGraph: graph.getRelationshipGraph.bind(graph),
    getCircleMembers: (userId, tier) =>
      graph.getCircleMembers(userId, tier as CircleTier, extensionTenant()),
    getVisiblePostIds: (userId, tier, since, pagination) =>
      graph.getVisiblePostIds(
        userId,
        tier as CircleTier,
        since,
        pagination as PaginationInput,
        extensionTenant(),
      ),
    getGlanceItems: (userId, tier, limit) =>
      graph.getGlanceItems(userId, tier as CircleTier, limit, extensionTenant()),
    getDepthPostIds: (userId, targetType, targetId, since, limit) =>
      graph.getDepthPostIds(
        userId,
        targetType as GraphNodeType,
        targetId,
        since,
        limit,
        extensionTenant(),
      ),
    getCircleStatus: (userId) => graph.getCircleStatus(userId, extensionTenant()),
    getCircleEntityStatus: (userId, tier) =>
      graph.getCircleEntityStatus(userId, tier as CircleTier, extensionTenant()),
    getEntityRelationships: graph.getEntityRelationships.bind(graph),
    getPendingEntityRelationships: graph.getPendingEntityRelationships.bind(graph),
    discoverByGraph: graph.discoverByGraph.bind(graph),
    discoverNearby: graph.discoverNearby.bind(graph),
    getRecommendations: graph.getRecommendations.bind(graph),
  };
}

/**
 * Create a scoped ExtensionContext for an extension.
 *
 * @param ext - The extension to create context for
 * @param env - The full application environment (secrets stay here)
 * @param prisma - The full Prisma client (scoped down to safe tables)
 * @param graph - The full GraphService (scoped to read-only methods)
 * @param callerRegion - The caller's verified data region (discover()'s floor)
 * @param tenantId - The tenant core resolved for this request, when it has
 *   one. Optional and additive: today's only production caller (the extension
 *   route wrapper) resolves its tenant after building the context, so the
 *   event emitter falls back to the ambient tenant context when this is
 *   omitted. The parameter exists so that threading the resolved tenant
 *   through later is a one-line change at the call site rather than a
 *   redesign here.
 */
export function createExtensionContext(
  ext: TrellisExtension,
  env: Env,
  prisma: unknown,
  graph?: GraphService,
  callerRegion?: string,
  tenantId?: CoreTenantId,
): ExtensionContext {
  // Metadata for the tenant-carrying core delegates + composed ext_* models,
  // assembled once per context. The `tenant(tid)` proxy is the ONLY data surface
  // (O-1 design §5.3) — the raw unscoped delegate bag is not shipped.
  const metas = buildScopedModelMetas();
  const rawPrisma = prisma as RawPrismaLike;
  // discover() exposes EXACTLY the models this extension declared (05a §5); a
  // model in the core allow-list it did not declare is still blocked for it.
  // Registration (extension-validator) already guaranteed the declaration is a
  // subset of the core allow-list ∪ this extension's own models.
  const declaredCrossTenant = new Set<string>(ext.crossTenantRead ?? []);
  // Region floor for discover reads (§4.4(3)): the caller's data region when
  // authenticated, else the deployment primary — fail-closed to one region.
  const region = callerRegion ?? env.DEFAULT_REGION ?? "EU";
  return {
    db: {
      tenant: (tenantId: TenantId): ScopedDb =>
        createScopedDb(rawPrisma, tenantId, metas),
      discover: (reason: string): DiscoverDb =>
        createDiscoverDb(rawPrisma, ext.id, reason, declaredCrossTenant, region),
    },
    graphService: graph ? createReadOnlyGraphService(graph) : undefined,
    appDomain: env.APP_DOMAIN ?? "",
    appUrl: env.APP_URL ?? "",
    stage: env.STAGE ?? "dev",
    config: extractExtensionConfig(ext),
    // The event seam. Tenant-bound by construction: the published signature is
    // `emit(type, payload)`, so an extension has no way to name a tenant, and
    // the branded `TenantId` the outbox writer demands has a core-private
    // constructor it cannot reach. See lib/events/extension-emitter.ts.
    events: createExtensionEventEmitter(
      ext.id,
      rawPrisma as unknown as TransactionRunner,
      tenantId,
    ),
  };
}

/**
 * Extract only the env vars whose keys are declared in the extension's configSchema.
 * This prevents extensions from reading SESSION_SECRET, DATABASE_URL, etc.
 * via .passthrough() or .transform() on their Zod schema.
 */
function extractExtensionConfig(
  ext: TrellisExtension,
): Record<string, string> {
  if (!ext.configSchema || !("shape" in ext.configSchema)) return {};
  const config: Record<string, string> = {};
  for (const key of Object.keys((ext.configSchema as any).shape)) {
    if (process.env[key]) config[key] = process.env[key]!;
  }
  return config;
}
