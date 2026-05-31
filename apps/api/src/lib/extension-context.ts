/**
 * Extension Context Factory
 *
 * Builds the scoped ExtensionContext that extensions receive instead of the
 * full Env. Core secrets (SESSION_SECRET, DATABASE_URL, API keys) are never exposed.
 */

import type {
  ExtensionContext,
  ExtensionGraphService,
  TrellisExtension,
} from "@de-otio/trellis-extension-api";
import type { GraphService } from "./graph/index.js";
import type { Env } from "../env.js";

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
    getCircleMembers: graph.getCircleMembers.bind(graph),
    getVisiblePostIds: graph.getVisiblePostIds.bind(graph),
    getGlanceItems: graph.getGlanceItems.bind(graph),
    getDepthPostIds: graph.getDepthPostIds.bind(graph),
    getCircleStatus: graph.getCircleStatus.bind(graph),
    getCircleEntityStatus: graph.getCircleEntityStatus.bind(graph),
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
 */
export function createExtensionContext(
  ext: TrellisExtension,
  env: Env,
  prisma: any,
  graph?: GraphService,
): ExtensionContext {
  return {
    db: {
      entity: prisma.entity,
      post: prisma.post,
      postEntity: prisma.postEntity,
      postMedia: prisma.postMedia,
      taxonomyTaxon: prisma.taxonomyTaxon,
      taxonomyCategory: prisma.taxonomyCategory,
      taxonomyDimension: prisma.taxonomyDimension,
      productTaxonomyTag: prisma.productTaxonomyTag,
      activity: prisma.activity,
    },
    graphService: graph ? createReadOnlyGraphService(graph) : undefined,
    appDomain: env.APP_DOMAIN ?? "",
    appUrl: env.APP_URL ?? "",
    stage: env.STAGE ?? "dev",
    config: extractExtensionConfig(ext),
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
