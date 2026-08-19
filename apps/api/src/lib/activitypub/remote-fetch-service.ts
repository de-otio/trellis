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
import {
  safeFetchJson,
  SsrfBlockedError,
  type DnsResolver,
  type Transport,
} from "../net/safe-fetch.js";
import { JsonLdService } from "./jsonld.js";
import { isStandaloneModeEnabled, isRemoteUri } from "./standalone-mode.js";

/**
 * Cached remote document
 */
interface CachedDocument {
  document: object;
  expires: number;
  /** Approximate serialized size, used to bound the cache by bytes. */
  bytes: number;
}

/** Injection seam for tests — never set in production. */
export interface RemoteFetchOptions {
  resolver?: DnsResolver;
  transport?: Transport;
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
   * Hard ceiling on a single remote document. AP actor and object documents are
   * kilobytes; anything past this is a hostile instance trying to make us
   * buffer. Enforced while streaming, BEFORE any JSON parse.
   */
  private static readonly MAX_DOCUMENT_BYTES = 256 * 1024;

  /** Whole-exchange budget for one remote dereference. */
  private static readonly FETCH_TIMEOUT_MS = 10_000;

  /** Redirect hops allowed; each one is re-validated by the helper. */
  private static readonly MAX_REDIRECTS = 3;

  /**
   * Cache ceiling in BYTES, not entries. The previous 1000-entry cap said
   * nothing about memory: 1000 documents of 256 KiB each is 256 MiB, which a
   * hostile instance could park in the process for an hour.
   */
  private static readonly MAX_CACHE_BYTES = 8 * 1024 * 1024;

  /**
   * In-memory cache (for Cloudflare Workers)
   * In production, consider using Cloudflare KV or Durable Objects for distributed caching
   */
  private static cache = new Map<string, CachedDocument>();

  /** Running total of `bytes` across `cache`, kept in step with every write. */
  private static cacheBytes = 0;

  /**
   * Fallback fetch options used when a caller passes none.
   *
   * TEST SEAM ONLY — production leaves this empty, so the real resolver and
   * the pinned-socket undici transport are used. Tests set it once instead of
   * threading an options argument through every call site.
   */
  static defaultFetchOptions: RemoteFetchOptions = {};

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
    options: RemoteFetchOptions = {},
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
      // Fetch through the SSRF-safe helper: https-only, DNS resolved and every
      // A/AAAA record range-checked before connect, socket pinned to the
      // validated address, each redirect re-validated, timeout, and the body
      // capped BEFORE it is parsed. The previous bare `fetch(actorUri)` had
      // none of that — an inbound activity naming
      // `actor: "http://169.254.169.254/…"` made this a metadata reader, and
      // an unbounded `response.json()` made it an OOM primitive.
      const { status, data } = await safeFetchJson<any>(actorUri, {
        headers: {
          accept:
            'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
          "user-agent": "Trellis ActivityPub Client/1.0",
        },
        allowedProtocols: ["https:"],
        timeoutMs: this.FETCH_TIMEOUT_MS,
        maxRedirects: this.MAX_REDIRECTS,
        maxBytes: this.MAX_DOCUMENT_BYTES,
        resolver: options.resolver ?? this.defaultFetchOptions.resolver,
        transport: options.transport ?? this.defaultFetchOptions.transport,
      });

      if (status < 200 || status >= 300 || !data) {
        if (logger) {
          logger.warn(
            `[RemoteFetchService] Failed to fetch actor ${actorUri}: ${status}`,
          );
        }
        return null;
      }

      const actor = data;

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
        if (error instanceof SsrfBlockedError) {
          logger.warn(
            `[RemoteFetchService] Refused actor fetch ${actorUri}: ${error.reason} — ${error.detail}`,
          );
        } else {
          logger.error(
            `[RemoteFetchService] Error fetching actor ${actorUri}:`,
            error,
          );
        }
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
    options: RemoteFetchOptions = {},
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
      // Same guarantees as fetchActor — see the comment there.
      const { status, data } = await safeFetchJson<any>(objectUri, {
        headers: {
          accept:
            'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
          "user-agent": "Trellis ActivityPub Client/1.0",
        },
        allowedProtocols: ["https:"],
        timeoutMs: this.FETCH_TIMEOUT_MS,
        maxRedirects: this.MAX_REDIRECTS,
        maxBytes: this.MAX_DOCUMENT_BYTES,
        resolver: options.resolver ?? this.defaultFetchOptions.resolver,
        transport: options.transport ?? this.defaultFetchOptions.transport,
      });

      if (status < 200 || status >= 300 || !data) {
        if (logger) {
          logger.warn(
            `[RemoteFetchService] Failed to fetch object ${objectUri}: ${status}`,
          );
        }
        return null;
      }

      const obj = data;

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
        if (error instanceof SsrfBlockedError) {
          logger.warn(
            `[RemoteFetchService] Refused object fetch ${objectUri}: ${error.reason} — ${error.detail}`,
          );
        } else {
          logger.error(
            `[RemoteFetchService] Error fetching object ${objectUri}:`,
            error,
          );
        }
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
   * Validate URI format.
   *
   * HTTPS only (F5). Permitting `http:` meant a remote actor could be
   * dereferenced in cleartext — the public key we then trust for signature
   * verification would be whatever a network attacker chose to return. There
   * is no federation scenario where a plaintext actor document is acceptable.
   */
  private static isValidUri(uri: string): boolean {
    try {
      return new URL(uri).protocol === "https:";
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
      this.evict(uri);
      return null;
    }

    return cached.document;
  }

  /**
   * Cache a document, keeping the cache bounded by BYTES.
   *
   * The old cap was 1000 *entries*, which said nothing about memory — 1000
   * documents at the 256 KiB ceiling is 256 MiB a hostile instance could park
   * in the process for an hour. We now track the serialized size of each entry
   * and evict (expired first, then oldest-inserted) until the total fits.
   */
  private static setCached(
    uri: string,
    document: object,
    ttl: number = this.DEFAULT_CACHE_TTL,
  ): void {
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(document), "utf8");
    } catch {
      // Unserializable (cycles) — do not cache what we cannot measure.
      return;
    }

    // A single document larger than the whole budget is never cached.
    if (bytes > this.MAX_CACHE_BYTES) return;

    this.evict(uri); // replace cleanly if already present
    this.cache.set(uri, { document, expires: Date.now() + ttl, bytes });
    this.cacheBytes += bytes;

    if (this.cacheBytes > this.MAX_CACHE_BYTES) {
      this.cleanupCache();
    }
  }

  /** Remove one entry and keep the byte total in step. */
  private static evict(uri: string): void {
    const existing = this.cache.get(uri);
    if (!existing) return;
    this.cacheBytes -= existing.bytes;
    this.cache.delete(uri);
  }

  /**
   * Drop expired entries, then — if still over budget — the oldest inserted
   * entries (Map preserves insertion order) until the total fits.
   */
  private static cleanupCache(): void {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (value.expires < now) {
        this.cacheBytes -= value.bytes;
        this.cache.delete(key);
      }
    }

    for (const [key, value] of this.cache.entries()) {
      if (this.cacheBytes <= this.MAX_CACHE_BYTES) break;
      this.cacheBytes -= value.bytes;
      this.cache.delete(key);
    }
  }

  /**
   * Invalidate cache entry
   */
  static invalidateCache(uri: string): void {
    this.evict(uri);
  }

  /**
   * Clear all cache entries
   */
  static clearCache(): void {
    this.cache.clear();
    this.cacheBytes = 0;
  }

  /** Current cache footprint in bytes — exposed for tests and diagnostics. */
  static getCacheBytes(): number {
    return this.cacheBytes;
  }
}
