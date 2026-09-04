/**
 * Idempotency-Key Middleware (T9b-c)
 *
 * Deduplicates POST requests using an `Idempotency-Key` header backed by a
 * 24-hour DynamoDB cache.
 *
 * Behaviour:
 * - No header → pass-through (no caching, handler runs normally).
 * - First request with key K + body B → execute handler, cache result,
 *   respond with `Idempotency-Replay: false`.
 * - Repeat with same key K + same body B → return cached response,
 *   `Idempotency-Replay: true`. Handler NOT called.
 * - Repeat with same key K + different body B' → 422 IDEMPOTENCY_KEY_REUSE.
 * - Non-POST method with key present → pass-through (key is only honoured on POST).
 * - Body > 1 MB → 413 IDEMPOTENCY_BODY_TOO_LARGE.
 * - Key invalid (empty / non-ASCII-printable / > 255 chars) → 400 IDEMPOTENCY_KEY_INVALID.
 * - Concurrent same-key claim (race): loser polls up to 3×100 ms for winner's
 *   response, then returns 409 IDEMPOTENCY_KEY_IN_FLIGHT.
 *
 * Spec: plans/mvp/10-trellis-stages/09-agent-surface.md §T9b-c
 *       doc/02-technical/identity-federation/10-agent-friendly-onboarding.md §MVP-4
 */

import * as crypto from "node:crypto";
import type { Middleware } from "../middleware.js";
import {
  createIdempotencyStoreFromEnv,
  buildPk,
  isInFlight,
  IDEMPOTENCY_TTL_SECONDS,
  IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS,
  IN_FLIGHT_SENTINEL,
  type IdempotencyStoreInterface,
  type IdempotencyRecord,
  type StoredRecord,
} from "./idempotency-store.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_KEY_LENGTH = 255;
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;

/** Maximum body size we will buffer and hash: 1 MiB */
const MAX_BODY_BYTES = 1 * 1024 * 1024;

/** Polling config for in-flight race resolution */
const IN_FLIGHT_POLL_ATTEMPTS = 3;
const IN_FLIGHT_POLL_INTERVAL_MS = 100;

// Headers replayed on cache hits (exclude security / hop-by-hop / CORS / auth
// headers which either need to be re-emitted fresh by the security-headers
// middleware on each call (HIGH-2 hardening), are session-scoped, or could
// leak credentials when replayed across callers).
const REPLAY_HEADER_DENYLIST = new Set([
  "set-cookie",
  "strict-transport-security",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "content-security-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "transfer-encoding",
  "connection",
  // HIGH-2: never replay credential / authentication headers stored
  // alongside a previous response. Each caller's auth context must be
  // re-evaluated against their own credentials.
  "authorization",
  "www-authenticate",
  "proxy-authenticate",
  "x-csrf-token",
]);

/**
 * Pull a tenant-scoped or user-scoped value out of the request context
 * so the idempotency dedup key partitions cleanly across tenants
 * (G4 HIGH-1). Federation POSTs all sit under `/api/tenants/{id}/...`,
 * so the path-based extractor catches the common case; if an `auth`
 * object was attached upstream we prefer its activeTenantId so callers
 * acting through tenant-switch flows still partition correctly.
 */
function deriveScope(context: {
  pathname: string;
  request: Request;
  // The idempotency middleware is registered after auth on federation
  // routes; some upstream code attaches an auth context here.
  auth?: { activeTenantId?: string; userId?: string };
}): string {
  const ctxAuth = (context as { auth?: { activeTenantId?: string; userId?: string } }).auth;
  if (ctxAuth?.activeTenantId) return `t:${ctxAuth.activeTenantId}`;

  // Path-based fallback: /api/tenants/{tenantId}/...
  const m = context.pathname.match(/^\/api\/tenants\/([^/]+)/);
  if (m && m[1]) return `t:${m[1]}`;

  if (ctxAuth?.userId) return `u:${ctxAuth.userId}`;
  return "anon";
}

// ─────────────────────────────────────────────────────────────────────────────
// Error helpers
// ─────────────────────────────────────────────────────────────────────────────

function jsonError(
  status: number,
  error: string,
  message: string,
  remediation: string,
): Response {
  return new Response(JSON.stringify({ error, message, remediation }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Hash helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a deterministic hash over method + path + raw body bytes.
 * Headers are intentionally excluded so that retries with different
 * Idempotency-Key values but same intent hash the same way.
 */
export function buildRequestHash(method: string, path: string, body: Uint8Array): string {
  const hash = crypto.createHash("sha256");
  hash.update(`${method.toUpperCase()}:${path}:`);
  hash.update(body);
  return hash.digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// Sleep helper (mockable in tests)
// ─────────────────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param storeOverride - Inject a mock store for testing; production uses
 *   DynamoIdempotencyStore built from `env.IDEMPOTENCY_TABLE`.
 */
export function idempotencyMiddleware(
  storeOverride?: IdempotencyStoreInterface,
): Middleware {
  return async (context, next) => {
    const { request, env } = context;

    const rawKey = request.headers.get("Idempotency-Key");

    // ── No header → pass-through ──────────────────────────────────────────────
    if (rawKey === null) {
      return next();
    }

    // ── Only honour the header on POST ───────────────────────────────────────
    if (request.method !== "POST") {
      return next();
    }

    // ── Key validation ────────────────────────────────────────────────────────
    if (rawKey.length === 0 || rawKey.length > MAX_KEY_LENGTH || !PRINTABLE_ASCII_RE.test(rawKey)) {
      return jsonError(
        400,
        "IDEMPOTENCY_KEY_INVALID",
        `Idempotency-Key must be 1–${MAX_KEY_LENGTH} printable ASCII characters.`,
        "Generate a UUID v4 (e.g. crypto.randomUUID()) and use it as the Idempotency-Key.",
      );
    }

    // ── Buffer + size-check the request body ──────────────────────────────────
    let bodyBytes: Uint8Array;
    try {
      bodyBytes = await readBodyWithLimit(request, MAX_BODY_BYTES);
    } catch {
      return jsonError(
        413,
        "IDEMPOTENCY_BODY_TOO_LARGE",
        `Request body exceeds the ${MAX_BODY_BYTES / 1024 / 1024} MiB limit for idempotency processing.`,
        "Reduce the request body size or omit the Idempotency-Key header for large payloads.",
      );
    }

    const requestHash = buildRequestHash(request.method, context.pathname, bodyBytes);

    // ── Resolve the store ─────────────────────────────────────────────────────
    const tableName = (env as any).IDEMPOTENCY_TABLE as string | undefined;
    const store: IdempotencyStoreInterface =
      storeOverride ?? createIdempotencyStoreFromEnv(tableName ?? `${(env as any).STAGE ?? "dev"}-trellis-idempotency`);

    // G4 HIGH-1: scope the dedup key by tenant (preferred) or user.
    const scope = deriveScope(context);
    const pk = buildPk(rawKey, scope);

    // ── Check existing record ─────────────────────────────────────────────────
    const existing = await store.get(pk);

    if (existing) {
      // Hash mismatch → 422
      if (existing.requestHash !== requestHash) {
        return jsonError(
          422,
          "IDEMPOTENCY_KEY_REUSE",
          "This Idempotency-Key was used with a different request body.",
          "Use a fresh Idempotency-Key per logically distinct request.",
        );
      }

      // In-flight: poll for the winner's response
      if (isInFlight(existing)) {
        return await pollForResolution(store, pk, requestHash);
      }

      // Cached response → replay
      return buildReplay(existing);
    }

    // ── Claim the key with a conditional write ────────────────────────────────
    // G4 MEDIUM-5: write a SHORT-TTL sentinel here. If the worker dies
    // between this claim and the resolve/delete step, the row evaporates
    // on its own within ~60s and a retry can succeed. The full 24h TTL
    // is only assigned after a successful resolve.
    const nowSec = Math.floor(Date.now() / 1000);
    const inFlightRecord: StoredRecord = {
      pk,
      requestHash,
      responseStatus: 0,
      responseBody: IN_FLIGHT_SENTINEL,
      responseHeaders: {},
      expiresAt: nowSec + IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS,
    };

    const claimed = await store.putIfAbsent(inFlightRecord);

    if (!claimed) {
      // Lost the race — another worker claimed the key in the gap between
      // our get() returning null and our putIfAbsent().
      return await pollForResolution(store, pk, requestHash);
    }

    // ── We own the key: execute the handler ──────────────────────────────────
    // We've consumed request.body. Patch context.request so downstream middleware
    // and the route handler see a readable body again.
    const freshRequest = new Request(request, { body: bodyBytes.length > 0 ? (bodyBytes as BodyInit) : null });
    (context as { request: Request }).request = freshRequest;

    let response: Response;
    try {
      response = await next.call(undefined);
    } catch (err) {
      // Handler threw — release the claim so retries aren't permanently blocked.
      await store.delete(pk).catch(() => { /* best-effort */ });
      throw err;
    }

    // ── Persist the response (only on success 2xx/3xx) ───────────────────────
    if (response.status < 400) {
      const responseBodyText = await response.clone().text();
      const headersToStore: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (!REPLAY_HEADER_DENYLIST.has(name.toLowerCase())) {
          headersToStore[name] = value;
        }
      });

      const resolvedRecord: IdempotencyRecord = {
        pk,
        requestHash,
        responseStatus: response.status,
        responseBody: responseBodyText,
        responseHeaders: headersToStore,
        expiresAt: nowSec + IDEMPOTENCY_TTL_SECONDS,
      };

      await store.resolve(resolvedRecord).catch(() => { /* best-effort; client will get real response */ });
    } else {
      // Non-success: release the claim so the caller can retry with the same key.
      await store.delete(pk).catch(() => { /* best-effort */ });
    }

    // ── Return original response with replay=false marker ────────────────────
    const mutableResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    mutableResponse.headers.set("Idempotency-Replay", "false");
    return mutableResponse;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strict Content-Length parser. Returns null when the header is absent,
 * throws "body_too_large" when the value is malformed (G4 HIGH-3) or
 * exceeds `maxBytes`. We reject anything that isn't a sequence of ASCII
 * digits — `-1`, `1.0e10`, hex literals, etc. — because the looser
 * parseInt(value, 10) silently absorbs them and the resulting limit
 * check is bypassable.
 */
const STRICT_CONTENT_LENGTH_RE = /^[0-9]+$/;

/**
 * Read the request body into a Uint8Array.
 * Throws if the body exceeds `maxBytes`.
 */
async function readBodyWithLimit(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!STRICT_CONTENT_LENGTH_RE.test(contentLength)) {
      throw new Error("body_too_large");
    }
    const len = Number(contentLength);
    if (!Number.isFinite(len) || len > maxBytes) {
      throw new Error("body_too_large");
    }
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return new Uint8Array(0);
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        reader.cancel().catch(() => { /* ignore */ });
        throw new Error("body_too_large");
      }
      chunks.push(value);
    }
  }

  // Concatenate chunks
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/**
 * Poll the store for up to IN_FLIGHT_POLL_ATTEMPTS × IN_FLIGHT_POLL_INTERVAL_MS,
 * waiting for an in-flight record to be resolved by the primary worker.
 * Returns the cached response on resolution, or 409 on exhaustion.
 */
async function pollForResolution(
  store: IdempotencyStoreInterface,
  pk: string,
  requestHash: string,
): Promise<Response> {
  for (let attempt = 0; attempt < IN_FLIGHT_POLL_ATTEMPTS; attempt++) {
    await sleep(IN_FLIGHT_POLL_INTERVAL_MS);

    const record = await store.get(pk);

    if (!record) {
      // Primary failed and deleted the claim — treat as if no record exists.
      // Caller will retry; for now return 409 to avoid re-running the handler.
      break;
    }

    if (record.requestHash !== requestHash) {
      return jsonError(
        422,
        "IDEMPOTENCY_KEY_REUSE",
        "This Idempotency-Key was used with a different request body.",
        "Use a fresh Idempotency-Key per logically distinct request.",
      );
    }

    if (!isInFlight(record)) {
      return buildReplay(record);
    }
  }

  return jsonError(
    409,
    "IDEMPOTENCY_KEY_IN_FLIGHT",
    "Another request with this Idempotency-Key is still being processed.",
    "Wait a moment and retry, or use a new Idempotency-Key.",
  );
}

/**
 * Reconstruct a Response from a cached IdempotencyRecord and add replay header.
 */
function buildReplay(record: IdempotencyRecord): Response {
  const headers = new Headers(record.responseHeaders);
  headers.set("Idempotency-Replay", "true");
  headers.set("content-type", headers.get("content-type") ?? "application/json");
  return new Response(record.responseBody, {
    status: record.responseStatus,
    headers,
  });
}
