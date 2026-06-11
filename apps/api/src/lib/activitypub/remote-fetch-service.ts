/**
 * ActivityPub Remote Fetching Service
 *
 * Handles fetching of remote ActivityPub actors and objects from other servers.
 * This enables federation with other ActivityPub instances.
 *
 * Phase 4: Federation
 */

import type { Env } from "../../env.js";
import { Logger } from "../logger.js";
import { JsonLdService } from "./jsonld.js";
import { isStandaloneModeEnabled, isRemoteUri } from "./standalone-mode.js";

/**
 * Cached remote document
 */
interface CachedDocument {
  document: object;
  expires: number;
}

/**
 * Service for fetching remote ActivityPub actors and objects
 */
export class RemoteFetchService {
  /**
   * Default cache TTL: 1 hour
   */
  private static readonly DEFAULT_CACHE_TTL = 3600000; // 1 hour in milliseconds

  /**
   * In-memory cache (for Cloudflare Workers)
   * In production, consider using Cloudflare KV or Durable Objects for distributed caching
   */
  private static cache = new Map<string, CachedDocument>();

  /**
   * Fetch remote actor document
   *
   * @param actorUri - Actor URI (e.g., https://mastodon.social/users/alice)
   * @param env - Environment variables
   * @param logger - Optional logger instance
   * @returns Actor document or null if fetch fails
   */
  static async fetchActor(
    actorUri: string,
    env: Env,
    logger?: Logger,
  ): Promise<object | null> {
    // Validate URI
    if (!this.isValidUri(actorUri)) {
      if (logger) {
        logger.warn(`[RemoteFetchService] Invalid actor URI: ${actorUri}`);
      }
      return null;
    }

    // Check if this is a remote actor
    if (!isRemoteUri(actorUri, env)) {
      // Local actor - should not be fetched via RemoteFetchService
      if (logger) {
        logger.debug(
          `[RemoteFetchService] Actor is local, skipping: ${actorUri}`,
        );
      }
      return null;
    }

    // Check if standalone mode is enabled - skip remote fetches
    const standaloneMode = await isStandaloneModeEnabled(env);
    if (standaloneMode) {
      if (logger) {
        logger.info(
          `[RemoteFetchService] Skipping remote actor fetch (standalone mode enabled): ${actorUri}`,
        );
      }
      return null;
    }

    // Check cache
    const cached = this.getCached(actorUri);
    if (cached) {
      if (logger) {
        logger.debug(`[RemoteFetchService] Using cached actor: ${actorUri}`);
      }
      return cached;
    }

    try {
      // Fetch actor document
      const response = await fetch(actorUri, {
        headers: {
          Accept:
            'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
          "User-Agent": "Trellis ActivityPub Client/1.0",
        },
        // Cloudflare Workers fetch supports redirects by default
      });

      if (!response.ok) {
        if (logger) {
          logger.warn(
            `[RemoteFetchService] Failed to fetch actor ${actorUri}: ${response.status} ${response.statusText}`,
          );
        }
        return null;
      }

      const actor = (await response.json()) as any;

      // Validate actor document
      if (!this.isValidActor(actor)) {
        if (logger) {
          logger.warn(
            `[RemoteFetchService] Invalid actor document: ${actorUri}`,
          );
        }
        return null;
      }

      // Cache actor
      this.setCached(actorUri, actor as object);

      if (logger) {
        logger.info(`[RemoteFetchService] Fetched remote actor: ${actorUri}`);
      }

      return actor as object;
    } catch (error: any) {
      if (logger) {
        logger.error(
          `[RemoteFetchService] Error fetching actor ${actorUri}:`,
          error,
        );
      }
      return null;
    }
  }

  /**
   * Fetch remote object (post, note, etc.)
   *
   * @param objectUri - Object URI
   * @param env - Environment variables
   * @param logger - Optional logger instance
   * @returns Object document or null if fetch fails
   */
  static async fetchObject(
    objectUri: string,
    env: Env,
    logger?: Logger,
  ): Promise<object | null> {
    // Validate URI
    if (!this.isValidUri(objectUri)) {
      if (logger) {
        logger.warn(`[RemoteFetchService] Invalid object URI: ${objectUri}`);
      }
      return null;
    }

    // Check if this is a remote object
    if (!isRemoteUri(objectUri, env)) {
      // Local object - should not be fetched via RemoteFetchService
      if (logger) {
        logger.debug(
          `[RemoteFetchService] Object is local, skipping: ${objectUri}`,
        );
      }
      return null;
    }

    // Check if standalone mode is enabled - skip remote fetches
    const standaloneMode = await isStandaloneModeEnabled(env);
    if (standaloneMode) {
      if (logger) {
        logger.info(
          `[RemoteFetchService] Skipping remote object fetch (standalone mode enabled): ${objectUri}`,
        );
      }
      return null;
    }

    // Check cache
    const cached = this.getCached(objectUri);
    if (cached) {
      if (logger) {
        logger.debug(`[RemoteFetchService] Using cached object: ${objectUri}`);
      }
      return cached;
    }

    try {
      // Fetch object document
      const response = await fetch(objectUri, {
        headers: {
          Accept:
            'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
          "User-Agent": "Trellis ActivityPub Client/1.0",
        },
      });

      if (!response.ok) {
        if (logger) {
          logger.warn(
            `[RemoteFetchService] Failed to fetch object ${objectUri}: ${response.status} ${response.statusText}`,
          );
        }
        return null;
      }

      const obj = (await response.json()) as any;

      // Validate object document
      if (!this.isValidObject(obj)) {
        if (logger) {
          logger.warn(
            `[RemoteFetchService] Invalid object document: ${objectUri}`,
          );
        }
        return null;
      }

      // Cache object
      this.setCached(objectUri, obj as object);

      if (logger) {
        logger.info(`[RemoteFetchService] Fetched remote object: ${objectUri}`);
      }

      return obj as object;
    } catch (error: any) {
      if (logger) {
        logger.error(
          `[RemoteFetchService] Error fetching object ${objectUri}:`,
          error,
        );
      }
      return null;
    }
  }

  /**
   * Get actor's inbox URL
   *
   * @param actorUri - Actor URI
   * @param env - Environment variables
   * @param logger - Optional logger instance
   * @returns Inbox URL or null if not found
   */
  static async getActorInbox(
    actorUri: string,
    env: Env,
    logger?: Logger,
  ): Promise<string | null> {
    const actor = await this.fetchActor(actorUri, env, logger);
    if (!actor) {
      return null;
    }

    const inbox = (actor as any).inbox;
    if (typeof inbox === "string") {
      return inbox;
    }

    if (typeof inbox === "object" && inbox !== null && (inbox as any).id) {
      return (inbox as any).id;
    }

    return null;
  }

  /**
   * Get actor's public key for signature verification
   *
   * @param actorUri - Actor URI
   * @param env - Environment variables
   * @param logger - Optional logger instance
   * @returns Public key PEM or null if not found
   */
  static async getActorPublicKey(
    actorUri: string,
    env: Env,
    logger?: Logger,
  ): Promise<string | null> {
    const actor = await this.fetchActor(actorUri, env, logger);
    if (!actor) {
      return null;
    }

    const publicKey = (actor as any).publicKey;
    if (!publicKey) {
      return null;
    }

    // Handle different public key formats
    if (typeof publicKey === "string") {
      return publicKey;
    }

    if (typeof publicKey === "object" && publicKey !== null) {
      // ActivityPub format: { id, owner, publicKeyPem }
      if ((publicKey as any).publicKeyPem) {
        return (publicKey as any).publicKeyPem;
      }
    }

    return null;
  }

  /**
   * Check if URI is remote (not from our server)
   *
   * @param uri - URI to check
   * @param env - Environment variables
   * @returns True if URI is remote
   */
  static isRemoteUri(uri: string, env: Env): boolean {
    const baseUrl = env.ACTIVITYPUB_BASE_URL || "https://example.com";
    // Compare parsed origins rather than a string prefix, so a host like
    // "example.com.attacker.com" cannot masquerade as local.
    try {
      return new URL(uri).origin !== new URL(baseUrl).origin;
    } catch {
      // Unparseable URI — treat as remote (untrusted).
      return true;
    }
  }

  /**
   * Extract domain from URI
   *
   * @param uri - URI
   * @returns Domain or null if invalid
   */
  static extractDomain(uri: string): string | null {
    try {
      const url = new URL(uri);
      return url.hostname;
    } catch {
      return null;
    }
  }

  /**
   * Validate URI format
   */
  private static isValidUri(uri: string): boolean {
    try {
      const url = new URL(uri);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }

  /**
   * Validate actor document structure
   */
  private static isValidActor(actor: any): boolean {
    if (!actor || typeof actor !== "object") {
      return false;
    }

    // Must have type, id, and inbox
    const validTypes = [
      "Person",
      "Group",
      "Organization",
      "Service",
      "Application",
    ];
    if (!validTypes.includes(actor.type)) {
      return false;
    }

    if (!actor.id || typeof actor.id !== "string") {
      return false;
    }

    if (!actor.inbox) {
      return false;
    }

    return true;
  }

  /**
   * Validate object document structure
   */
  private static isValidObject(obj: any): boolean {
    if (!obj || typeof obj !== "object") {
      return false;
    }

    // Must have id and type
    if (!obj.id || typeof obj.id !== "string") {
      return false;
    }

    if (!obj.type || typeof obj.type !== "string") {
      return false;
    }

    return true;
  }

  /**
   * Get cached document
   */
  private static getCached(uri: string): object | null {
    const cached = this.cache.get(uri);
    if (!cached) {
      return null;
    }

    // Check if expired
    if (cached.expires < Date.now()) {
      this.cache.delete(uri);
      return null;
    }

    return cached.document;
  }

  /**
   * Cache document
   */
  private static setCached(
    uri: string,
    document: object,
    ttl: number = this.DEFAULT_CACHE_TTL,
  ): void {
    this.cache.set(uri, {
      document,
      expires: Date.now() + ttl,
    });

    // Clean up expired entries periodically (simple approach)
    // In production, use a more sophisticated cache eviction strategy
    if (this.cache.size > 1000) {
      this.cleanupCache();
    }
  }

  /**
   * Clean up expired cache entries
   */
  private static cleanupCache(): void {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (value.expires < now) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Invalidate cache entry
   */
  static invalidateCache(uri: string): void {
    this.cache.delete(uri);
  }

  /**
   * Clear all cache entries
   */
  static clearCache(): void {
    this.cache.clear();
  }
}
