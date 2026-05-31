/**
 * Extension Registry
 *
 * Manages registered extensions. Extensions are registered at startup
 * by the application entry point (server.ts), not statically imported here.
 * This keeps the core free of extension-specific dependencies.
 */

import type { TrellisExtension } from "@de-otio/trellis-extension-api";

const extensions: TrellisExtension[] = [];

/** Register an extension. Call at startup before the server starts. */
export function registerExtension(ext: TrellisExtension): void {
  extensions.push(ext);
  if (ext.entityRelationshipTypes && ext.entityRelationshipTypes.length > 0) {
    console.log(
      `[extensions] "${ext.id}" registered entityRelationshipTypes: ${ext.entityRelationshipTypes.join(", ")}`,
    );
  }
  if (ext.discoveryFacets && ext.discoveryFacets.length > 0) {
    const facetSummary = ext.discoveryFacets
      .map((f) => `${f.field}(${f.type})`)
      .join(", ");
    console.log(
      `[extensions] "${ext.id}" registered discoveryFacets: ${facetSummary}`,
    );
  }
}

/** Look up an extension by entity type */
export function getExtension(
  entityType: string,
): TrellisExtension | undefined {
  return extensions.find((e) => e.id === entityType);
}

/** Return all registered extensions */
export function getExtensions(): readonly TrellisExtension[] {
  return extensions;
}
