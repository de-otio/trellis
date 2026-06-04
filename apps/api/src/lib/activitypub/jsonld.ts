/**
 * JSON-LD Context Management for ActivityPub
 *
 * Handles JSON-LD context setup and caching for ActivityStreams 2.0 documents.
 */

import type { Env } from "../../env.js";

/**
 * Standard ActivityPub JSON-LD contexts
 */
const ACTIVITYSTREAMS_CONTEXT = "https://www.w3.org/ns/activitystreams";
const SECURITY_CONTEXT = "https://w3id.org/security/v1";

/**
 * Service for managing JSON-LD contexts for ActivityPub
 */
export class JsonLdService {
  /**
   * Get standard ActivityPub context array
   * Used in all ActivityPub documents
   */
  static getStandardContext(): string[] {
    return [ACTIVITYSTREAMS_CONTEXT, SECURITY_CONTEXT];
  }

  /**
   * Get expanded context object (for future extensibility)
   * Currently returns standard contexts, but can be extended for custom contexts
   */
  static getContextObject(): object {
    return {
      "@context": this.getStandardContext(),
    };
  }

  /**
   * Validate that a document has the required ActivityPub context
   */
  static hasValidContext(document: any): boolean {
    if (!document || typeof document !== "object") {
      return false;
    }

    const context = document["@context"];
    if (!context) {
      return false;
    }

    // Context can be a string, array, or object
    const contexts = Array.isArray(context) ? context : [context];

    // Must include ActivityStreams context
    return contexts.some((ctx: any) => {
      const ctxStr = typeof ctx === "string" ? ctx : ctx["@context"] || "";
      return ctxStr === ACTIVITYSTREAMS_CONTEXT;
    });
  }

  /**
   * Add standard context to a document if missing
   */
  static ensureContext(document: any): any {
    if (!this.hasValidContext(document)) {
      return {
        ...document,
        "@context": this.getStandardContext(),
      };
    }
    // If context is valid, return document as-is (don't convert string to array)
    return document;
  }

  /**
   * Cache context documents (for future implementation)
   * ActivityPub servers may cache remote contexts for performance
   */
  static async cacheContext(
    contextUrl: string,
    contextDocument: any,
    env: Env,
  ): Promise<void> {
    // Future implementation: Store in KV for caching
    // For now, this is a placeholder
    // const kv = env.JSONLD_CACHE_KV;
    // if (kv) {
    //   await kv.put(contextUrl, JSON.stringify(contextDocument), {
    //     expirationTtl: 86400, // 24 hours
    //   });
    // }
  }

  /**
   * Get cached context document (for future implementation)
   */
  static async getCachedContext(
    contextUrl: string,
    env: Env,
  ): Promise<any | null> {
    // Future implementation: Retrieve from KV cache
    // For now, this is a placeholder
    // const kv = env.JSONLD_CACHE_KV;
    // if (kv) {
    //   const cached = await kv.get(contextUrl);
    //   if (cached) {
    //     return JSON.parse(cached);
    //   }
    // }
    return null;
  }
}
