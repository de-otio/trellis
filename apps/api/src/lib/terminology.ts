/**
 * Terminology Abstraction
 *
 * Provides configurable terminology backed by the extension registry.
 * Each extension provides its own terminology (entity name, plural).
 */

import { getExtension } from "../extensions.js";

export interface Terminology {
  entity: string;
  entityPlural: string;
  post: string;
  profile: string;
  owner: string;
}

const DEFAULT_TERMINOLOGY: Terminology = {
  entity: "entity",
  entityPlural: "entities",
  post: "post",
  profile: "profile",
  owner: "owner",
};

/**
 * Get terminology, optionally for a specific entity type.
 *
 * If entityType is provided and a matching extension is registered,
 * its terminology overrides the defaults.
 */
export function getTerminology(entityType?: string): Terminology {
  if (entityType) {
    const ext = getExtension(entityType);
    if (ext) {
      return {
        ...DEFAULT_TERMINOLOGY,
        entity: ext.terminology.entity,
        entityPlural: ext.terminology.entityPlural,
      };
    }
  }
  return DEFAULT_TERMINOLOGY;
}

/**
 * Get terminology synchronously (for use in non-async contexts)
 */
export function getTerminologySync(entityType?: string): Terminology {
  return getTerminology(entityType);
}
