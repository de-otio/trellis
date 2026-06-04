/**
 * Graph Service Factory
 *
 * Creates and memoizes the GraphService implementation. The graph serving
 * path runs on Postgres (PostgresGraphService — joins + recursive CTEs on
 * the existing RDS); there is no separate graph database. (Graph-db revisit
 * 2026-06. The Neo4j/Neptune backend was removed; restore it from git
 * history if a dedicated graph DB is ever re-adopted.)
 *
 * @example
 * ```typescript
 * const graphService = await createGraphServiceFromEnv(env);
 * const health = await graphService.healthCheck(); // backend: "postgres"
 * ```
 */

import type { GraphService, GraphConnection } from "./graph-service.js";
import type { EntityGeoLookup } from "../geo/entity-geo-repository.js";
import type { EnvWithDb } from "../../db.js";

/**
 * Build the PostGIS geo-proximity lookup for discoverNearby. Tolerant of
 * absence — if Postgres config is missing it returns undefined and
 * geo-discovery yields empty. NOTE (residency): a single pooled client at
 * the default region is fine for dev/single-DB; multi-residency prod should
 * route per request.
 */
async function buildGeoLookup(env?: unknown): Promise<EntityGeoLookup | undefined> {
  try {
    const e = env as EnvWithDb | undefined;
    if (!e?.DATABASE_URL) return undefined;
    const { createPrisma } = await import("../../db.js");
    const { EntityGeoRepository } = await import("../geo/entity-geo-repository.js");
    return new EntityGeoRepository(createPrisma(e));
  } catch {
    return undefined;
  }
}

/**
 * Process-wide shared graph service.
 *
 * createGraphServiceFromEnv is called from ~10 per-request handlers + the
 * extension wrapper. Memoize the connected service so all callers share one
 * instance (and one underlying Prisma client) instead of building a fresh
 * one per request. Config comes from env, which is stable for the process,
 * so a single instance is correct.
 */
let sharedGraphService: Promise<GraphService & GraphConnection> | null = null;

export async function createGraphServiceFromEnv(
  env?: unknown,
): Promise<GraphService & GraphConnection> {
  if (!sharedGraphService) {
    sharedGraphService = buildGraphServiceFromEnv(env).catch((err) => {
      // Don't cache a failed connection — allow the next call to retry.
      sharedGraphService = null;
      throw err;
    });
  }
  return sharedGraphService;
}

/**
 * Close the shared graph service and clear the cache. Call on graceful
 * shutdown / test teardown so the process can exit cleanly.
 */
export async function closeSharedGraphService(): Promise<void> {
  if (!sharedGraphService) return;
  const pending = sharedGraphService;
  sharedGraphService = null;
  try {
    const svc = await pending;
    await svc.close();
  } catch {
    // best-effort
  }
}

async function buildGraphServiceFromEnv(
  _env?: unknown,
): Promise<GraphService & GraphConnection> {
  if (process.env.GRAPH_BACKEND === "neo4j") {
    throw new Error(
      "GRAPH_BACKEND=neo4j is no longer supported — the Neo4j/Neptune backend " +
        "was removed (the graph runs in Postgres; graph-db revisit 2026-06). " +
        "Restore it from git history if a dedicated graph DB is ever re-adopted.",
    );
  }

  const e = _env as EnvWithDb | undefined;
  if (!e?.DATABASE_URL) {
    throw new Error("Postgres graph backend requires a DATABASE_URL");
  }

  const geoLookup = await buildGeoLookup(_env);
  const { createPrisma } = await import("../../db.js");
  const { PostgresGraphService } = await import(
    "./postgres/postgres-graph-service.js"
  );
  // Surveillance-hardening Phase 0 (P2): thread the InteractionEvent dual-write
  // config from env (built by env.ts), falling back to the process.env parser.
  const { resolveInteractionEventConfig } = await import(
    "./postgres/interaction-events.js"
  );
  const eventConfig =
    (e as { interactionEvents?: ReturnType<typeof resolveInteractionEventConfig> })
      .interactionEvents ?? resolveInteractionEventConfig();
  const service = new PostgresGraphService(createPrisma(e), geoLookup, eventConfig);
  await service.connect({ endpoint: "postgres", auth: { type: "none" } });
  return service;
}
