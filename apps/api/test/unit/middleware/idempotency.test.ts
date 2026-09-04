/**
 * Unit Tests: Idempotency-Key Middleware (T9b-c)
 *
 * Coverage floor: 95% lines on idempotency.ts.
 *
 * Required test cases per spec:
 *  1. Same key + same body twice → identical response, second has Idempotency-Replay: true, handler NOT called.
 *  2. Same key + different body → 422 IDEMPOTENCY_KEY_REUSE.
 *  3. No header → handler runs normally; no store write.
 *  4. Invalid key (empty / non-ASCII / > 255 chars) → 400 IDEMPOTENCY_KEY_INVALID.
 *  5. Body > 1 MB with header → 413 IDEMPOTENCY_BODY_TOO_LARGE.
 *  6. Concurrent simulation: first wins; second sees cached response (or 409 on poll exhaustion).
 *  7. Expired entry → treated as fresh request; handler runs.
 *  8. Hash determinism: same body → same hash regardless of unrelated header order.
 *  9. Non-POST request with header → pass-through (header only honoured on POST).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type { MiddlewareContext } from "../../../src/lib/middleware.js";
import {
  idempotencyMiddleware,
  buildRequestHash,
  routeNeedsIdempotency,
} from "../../../src/lib/middleware/idempotency.js";
import {
  IN_FLIGHT_SENTINEL,
  IDEMPOTENCY_TTL_SECONDS,
  type IdempotencyStoreInterface,
  type StoredRecord,
  type IdempotencyRecord,
} from "../../../src/lib/middleware/idempotency-store.js";

// ─── Minimal mock store ───────────────────────────────────────────────────────

function makeMockStore(
  overrides: Partial<IdempotencyStoreInterface> = {},
): IdempotencyStoreInterface {
  return {
    get: vi.fn().mockResolvedValue(null),
    putIfAbsent: vi.fn().mockResolvedValue(true),
    resolve: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ─── Request / context helpers ───────────────────────────────────────────────

function makePostRequest(
  body = '{"name":"test"}',
  headers: Record<string, string> = {},
): Request {
  return new Request("https://api.example.com/api/tenants", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function makeContext(
  request: Request,
  url = new URL("https://api.example.com/api/tenants"),
): MiddlewareContext {
  return {
    request,
    env: {} as Env,
    url,
    pathname: url.pathname,
    method: request.method,
  };
}

const DEFAULT_KEY = "550e8400-e29b-41d4-a716-446655440000";

function makeCachedRecord(
  key: string,
  requestHash: string,
  overrides: Partial<IdempotencyRecord> = {},
): IdempotencyRecord {
  return {
    pk: `idem#${key}`,
    requestHash,
    responseStatus: 201,
    responseBody: '{"id":"created"}',
    responseHeaders: { "content-type": "application/json" },
    expiresAt: Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("idempotencyMiddleware", () => {
  let mockStore: IdempotencyStoreInterface;
  let handlerCallCount: number;
  let mockNext: () => Promise<Response>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlerCallCount = 0;
    mockNext = vi.fn(async () => {
      handlerCallCount++;
      return new Response('{"id":"created"}', {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    mockStore = makeMockStore();
  });

  // ── Test 3: No header → pass-through ───────────────────────────────────────
  describe("no Idempotency-Key header", () => {
    it("passes through to the handler without touching the store", async () => {
      const request = makePostRequest('{"name":"test"}');
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(mockStore);

      const response = await middleware(context, mockNext);

      expect(response.status).toBe(201);
      expect(handlerCallCount).toBe(1);
      expect(mockStore.get).not.toHaveBeenCalled();
      expect(mockStore.putIfAbsent).not.toHaveBeenCalled();
      expect(mockStore.resolve).not.toHaveBeenCalled();
    });

    it("does not add Idempotency-Replay header when no key present", async () => {
      const request = makePostRequest('{"name":"test"}');
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(mockStore);

      const response = await middleware(context, mockNext);

      expect(response.headers.get("Idempotency-Replay")).toBeNull();
    });
  });

  // ── Test 9: Non-POST → pass-through ──────────────────────────────────────
  describe("non-POST method with Idempotency-Key header", () => {
    it("passes through GET requests without deduplication", async () => {
      const request = new Request("https://api.example.com/api/tenants/t1", {
        method: "GET",
        headers: { "Idempotency-Key": DEFAULT_KEY },
      });
      const context = makeContext(request, new URL("https://api.example.com/api/tenants/t1"));
      const mockGetNext = vi.fn(async () => new Response('{"id":"t1"}', { status: 200 }));
      const middleware = idempotencyMiddleware(mockStore);

      const response = await middleware(context, mockGetNext);

      expect(mockGetNext).toHaveBeenCalledOnce();
      expect(response.status).toBe(200);
      expect(mockStore.get).not.toHaveBeenCalled();
    });

    it("passes through DELETE requests without deduplication", async () => {
      const request = new Request("https://api.example.com/api/tenants/t1", {
        method: "DELETE",
        headers: { "Idempotency-Key": DEFAULT_KEY },
      });
      const context = makeContext(request, new URL("https://api.example.com/api/tenants/t1"));
      const mockDeleteNext = vi.fn(async () => new Response(null, { status: 204 }));
      const middleware = idempotencyMiddleware(mockStore);

      const response = await middleware(context, mockDeleteNext);

      expect(mockDeleteNext).toHaveBeenCalledOnce();
      expect(mockStore.get).not.toHaveBeenCalled();
    });
  });

  // ── Test 4: Invalid key ────────────────────────────────────────────────────
  describe("invalid Idempotency-Key", () => {
    it("returns 400 for an empty string key", async () => {
      const request = makePostRequest('{"name":"test"}', { "Idempotency-Key": "" });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(mockStore);

      const response = await middleware(context, mockNext);

      expect(response.status).toBe(400);
      const body = await response.json() as any;
      expect(body.error).toBe("IDEMPOTENCY_KEY_INVALID");
      expect(handlerCallCount).toBe(0);
    });

    it("returns 400 for a key exceeding 255 characters", async () => {
      const longKey = "a".repeat(256);
      const request = makePostRequest('{"name":"test"}', { "Idempotency-Key": longKey });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(mockStore);

      const response = await middleware(context, mockNext);

      expect(response.status).toBe(400);
      const body = await response.json() as any;
      expect(body.error).toBe("IDEMPOTENCY_KEY_INVALID");
    });

    it("returns 400 for a key with non-ASCII characters", async () => {
      const request = makePostRequest('{"name":"test"}', { "Idempotency-Key": "keybad" });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(mockStore);

      const response = await middleware(context, mockNext);

      expect(response.status).toBe(400);
      const body = await response.json() as any;
      expect(body.error).toBe("IDEMPOTENCY_KEY_INVALID");
    });

    it("accepts a 255-character key (boundary)", async () => {
      const maxKey = "a".repeat(255);
      const request = makePostRequest('{"name":"test"}', { "Idempotency-Key": maxKey });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(mockStore);

      const response = await middleware(context, mockNext);

      // Should pass key validation (store.get called)
      expect(mockStore.get).toHaveBeenCalled();
    });

    it("accepts a UUID v4 key", async () => {
      const request = makePostRequest('{"name":"test"}', { "Idempotency-Key": DEFAULT_KEY });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(mockStore);

      await middleware(context, mockNext);

      expect(mockStore.get).toHaveBeenCalled();
    });
  });

  // ── Test 5: Body too large ─────────────────────────────────────────────────
  describe("body too large", () => {
    it("returns 413 when Content-Length header exceeds 1 MiB", async () => {
      const request = new Request("https://api.example.com/api/tenants", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(1 * 1024 * 1024 + 1),
          "Idempotency-Key": DEFAULT_KEY,
        },
        body: "x",
      });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(mockStore);

      const response = await middleware(context, mockNext);

      expect(response.status).toBe(413);
      const body = await response.json() as any;
      expect(body.error).toBe("IDEMPOTENCY_BODY_TOO_LARGE");
      expect(handlerCallCount).toBe(0);
    });

    it("returns 413 when stream body exceeds 1 MiB", async () => {
      // Build a body just over the limit
      const overLimit = new Uint8Array(1 * 1024 * 1024 + 100);
      const request = new Request("https://api.example.com/api/tenants", {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "Idempotency-Key": DEFAULT_KEY,
        },
        body: overLimit,
      });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(mockStore);

      const response = await middleware(context, mockNext);

      expect(response.status).toBe(413);
      const body = await response.json() as any;
      expect(body.error).toBe("IDEMPOTENCY_BODY_TOO_LARGE");
    });
  });

  // ── Test 1: Same key + same body twice → replay on second call ─────────────
  describe("deduplication: same key + same body", () => {
    it("returns Idempotency-Replay: false on first request and executes handler", async () => {
      const body = '{"name":"acme"}';
      const request = makePostRequest(body, { "Idempotency-Key": DEFAULT_KEY });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(mockStore);

      const response = await middleware(context, mockNext);

      expect(response.status).toBe(201);
      expect(response.headers.get("Idempotency-Replay")).toBe("false");
      expect(handlerCallCount).toBe(1);
      expect(mockStore.putIfAbsent).toHaveBeenCalled();
      expect(mockStore.resolve).toHaveBeenCalled();
    });

    it("returns Idempotency-Replay: true on repeat, handler NOT called", async () => {
      const body = '{"name":"acme"}';
      const hash = buildRequestHash("POST", "/api/tenants", new TextEncoder().encode(body));
      const cachedRecord = makeCachedRecord(DEFAULT_KEY, hash);

      const storeWithCache = makeMockStore({
        get: vi.fn().mockResolvedValue(cachedRecord),
      });

      const request = makePostRequest(body, { "Idempotency-Key": DEFAULT_KEY });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(storeWithCache);

      const response = await middleware(context, mockNext);

      expect(response.status).toBe(201);
      expect(response.headers.get("Idempotency-Replay")).toBe("true");
      // Handler must NOT have been called
      expect(handlerCallCount).toBe(0);
      // No new store writes
      expect(storeWithCache.putIfAbsent).not.toHaveBeenCalled();
    });

    it("replayed response body matches cached body", async () => {
      const body = '{"name":"acme"}';
      const hash = buildRequestHash("POST", "/api/tenants", new TextEncoder().encode(body));
      const cachedRecord = makeCachedRecord(DEFAULT_KEY, hash, {
        responseBody: '{"id":"existing-id"}',
        responseStatus: 201,
      });

      const storeWithCache = makeMockStore({
        get: vi.fn().mockResolvedValue(cachedRecord),
      });

      const request = makePostRequest(body, { "Idempotency-Key": DEFAULT_KEY });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(storeWithCache);

      const response = await middleware(context, mockNext);

      const responseBody = await response.json();
      expect(responseBody).toEqual({ id: "existing-id" });
    });
  });

  // ── Test 2: Same key + different body → 422 ────────────────────────────────
  describe("key reuse with different body", () => {
    it("returns 422 IDEMPOTENCY_KEY_REUSE", async () => {
      const originalBody = '{"name":"original"}';
      const differentBody = '{"name":"different"}';
      const originalHash = buildRequestHash(
        "POST",
        "/api/tenants",
        new TextEncoder().encode(originalBody),
      );

      // Store has a record with the original hash
      const cachedRecord = makeCachedRecord(DEFAULT_KEY, originalHash);
      const storeWithCache = makeMockStore({
        get: vi.fn().mockResolvedValue(cachedRecord),
      });

      // New request comes in with a different body but same key
      const request = makePostRequest(differentBody, { "Idempotency-Key": DEFAULT_KEY });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(storeWithCache);

      const response = await middleware(context, mockNext);

      expect(response.status).toBe(422);
      const body = await response.json() as any;
      expect(body.error).toBe("IDEMPOTENCY_KEY_REUSE");
      expect(body.remediation).toBeDefined();
      expect(handlerCallCount).toBe(0);
    });
  });

  // ── Test 6: Concurrent simulation ─────────────────────────────────────────
  describe("concurrent requests (in-flight)", () => {
    it("second caller polls and gets the resolved response when winner finishes", async () => {
      const body = '{"name":"race"}';
      const hash = buildRequestHash("POST", "/api/tenants", new TextEncoder().encode(body));

      const inFlightRecord: StoredRecord = {
        pk: `idem#${DEFAULT_KEY}`,
        requestHash: hash,
        responseStatus: 0,
        responseBody: IN_FLIGHT_SENTINEL,
        responseHeaders: {},
        expiresAt: Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS,
      };

      const resolvedRecord: IdempotencyRecord = {
        pk: `idem#${DEFAULT_KEY}`,
        requestHash: hash,
        responseStatus: 201,
        responseBody: '{"id":"winner"}',
        responseHeaders: { "content-type": "application/json" },
        expiresAt: Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS,
      };

      // First get → in-flight; second get (after poll) → resolved
      const storeWithRace = makeMockStore({
        get: vi
          .fn()
          .mockResolvedValueOnce(inFlightRecord)
          .mockResolvedValueOnce(resolvedRecord),
      });

      const request = makePostRequest(body, { "Idempotency-Key": DEFAULT_KEY });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(storeWithRace);

      const response = await middleware(context, mockNext);

      expect(response.status).toBe(201);
      expect(response.headers.get("Idempotency-Replay")).toBe("true");
      expect(handlerCallCount).toBe(0);
    });

    it("returns 409 IDEMPOTENCY_KEY_IN_FLIGHT when polling exhausts", async () => {
      const body = '{"name":"race"}';
      const hash = buildRequestHash("POST", "/api/tenants", new TextEncoder().encode(body));

      const inFlightRecord: StoredRecord = {
        pk: `idem#${DEFAULT_KEY}`,
        requestHash: hash,
        responseStatus: 0,
        responseBody: IN_FLIGHT_SENTINEL,
        responseHeaders: {},
        expiresAt: Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS,
      };

      // Always in-flight — never resolves
      const storeAlwaysInFlight = makeMockStore({
        get: vi.fn().mockResolvedValue(inFlightRecord),
      });

      const request = makePostRequest(body, { "Idempotency-Key": DEFAULT_KEY });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(storeAlwaysInFlight);

      const response = await middleware(context, mockNext);

      expect(response.status).toBe(409);
      const responseBody = await response.json() as any;
      expect(responseBody.error).toBe("IDEMPOTENCY_KEY_IN_FLIGHT");
      expect(handlerCallCount).toBe(0);
    });

    it("returns 409 when winner deleted the claim after failure", async () => {
      const body = '{"name":"race"}';
      const hash = buildRequestHash("POST", "/api/tenants", new TextEncoder().encode(body));

      const inFlightRecord: StoredRecord = {
        pk: `idem#${DEFAULT_KEY}`,
        requestHash: hash,
        responseStatus: 0,
        responseBody: IN_FLIGHT_SENTINEL,
        responseHeaders: {},
        expiresAt: Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS,
      };

      // First get returns in-flight; subsequent polls return null (winner cleaned up)
      const storeWithCleanup = makeMockStore({
        get: vi
          .fn()
          .mockResolvedValueOnce(inFlightRecord)
          .mockResolvedValue(null),
      });

      const request = makePostRequest(body, { "Idempotency-Key": DEFAULT_KEY });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(storeWithCleanup);

      const response = await middleware(context, mockNext);

      expect(response.status).toBe(409);
    });

    it("concurrent loser gets 422 when winner had different hash", async () => {
      const body = '{"name":"loser"}';
      const loserHash = buildRequestHash("POST", "/api/tenants", new TextEncoder().encode(body));
      const winnerHash = "different-hash-entirely";

      const inFlightRecord: StoredRecord = {
        pk: `idem#${DEFAULT_KEY}`,
        requestHash: winnerHash,
        responseStatus: 0,
        responseBody: IN_FLIGHT_SENTINEL,
        responseHeaders: {},
        expiresAt: Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS,
      };

      const storeWithWrongHash = makeMockStore({
        get: vi.fn().mockResolvedValue(inFlightRecord),
      });

      const request = makePostRequest(body, { "Idempotency-Key": DEFAULT_KEY });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(storeWithWrongHash);

      const response = await middleware(context, mockNext);

      expect(response.status).toBe(422);
      const responseBody = await response.json() as any;
      expect(responseBody.error).toBe("IDEMPOTENCY_KEY_REUSE");
    });

    it("poll sees resolved record with different hash → 422", async () => {
      // Loser: initial get returns in-flight with SAME hash (passes outer check)
      // But then on poll, the resolved record has a different hash (shouldn't happen
      // in practice but middleware must handle it defensively)
      const body = '{"name":"loser-poll"}';
      const hash = buildRequestHash("POST", "/api/tenants", new TextEncoder().encode(body));
      const differentHash = "completely-different-hash-for-test";

      const inFlightRecord: StoredRecord = {
        pk: `idem#${DEFAULT_KEY}`,
        requestHash: hash, // matches — passes outer check
        responseStatus: 0,
        responseBody: IN_FLIGHT_SENTINEL,
        responseHeaders: {},
        expiresAt: Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS,
      };

      // Poll returns a resolved record but with a different hash
      const resolvedDifferentHash: StoredRecord = {
        pk: `idem#${DEFAULT_KEY}`,
        requestHash: differentHash,
        responseStatus: 201,
        responseBody: '{"id":"other"}',
        responseHeaders: { "content-type": "application/json" },
        expiresAt: Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS,
      };

      const storeWithHashChange = makeMockStore({
        get: vi
          .fn()
          .mockResolvedValueOnce(inFlightRecord) // initial check → in-flight
          .mockResolvedValueOnce(resolvedDifferentHash), // poll → resolved with different hash
      });

      const request = makePostRequest(body, { "Idempotency-Key": DEFAULT_KEY });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(storeWithHashChange);

      const response = await middleware(context, mockNext);

      expect(response.status).toBe(422);
      const responseBody = await response.json() as any;
      expect(responseBody.error).toBe("IDEMPOTENCY_KEY_REUSE");
    });

    it("second request claims after losing putIfAbsent race (store now has record)", async () => {
      const body = '{"name":"race-claim"}';
      const hash = buildRequestHash("POST", "/api/tenants", new TextEncoder().encode(body));

      const resolvedRecord: IdempotencyRecord = {
        pk: `idem#${DEFAULT_KEY}`,
        requestHash: hash,
        responseStatus: 201,
        responseBody: '{"id":"fast-winner"}',
        responseHeaders: { "content-type": "application/json" },
        expiresAt: Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS,
      };

      // get returns null (race gap), putIfAbsent returns false (claim lost),
      // then polling returns resolved record
      const storeWithLostClaim = makeMockStore({
        get: vi.fn()
          .mockResolvedValueOnce(null) // initial get
          .mockResolvedValueOnce(resolvedRecord), // poll after claim lost
        putIfAbsent: vi.fn().mockResolvedValue(false),
      });

      const request = makePostRequest(body, { "Idempotency-Key": DEFAULT_KEY });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(storeWithLostClaim);

      const response = await middleware(context, mockNext);

      expect(response.status).toBe(201);
      expect(response.headers.get("Idempotency-Replay")).toBe("true");
      expect(handlerCallCount).toBe(0);
    });
  });

  // ── Test 7: Expired entry → fresh request ─────────────────────────────────
  describe("expired entries", () => {
    it("treats an expired (null-returning) entry as fresh", async () => {
      // The store's get() returns null for expired records (client-side TTL enforcement)
      const storeWithExpired = makeMockStore({
        get: vi.fn().mockResolvedValue(null),
      });

      const body = '{"name":"fresh-after-expiry"}';
      const request = makePostRequest(body, { "Idempotency-Key": DEFAULT_KEY });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(storeWithExpired);

      const response = await middleware(context, mockNext);

      // Handler should run (treated as fresh)
      expect(handlerCallCount).toBe(1);
      expect(response.status).toBe(201);
      expect(response.headers.get("Idempotency-Replay")).toBe("false");
    });
  });

  // ── Test 8: Hash determinism ───────────────────────────────────────────────
  describe("hash determinism", () => {
    it("same method + path + body always produces same hash", () => {
      const body = new TextEncoder().encode('{"name":"stable"}');
      const h1 = buildRequestHash("POST", "/api/tenants", body);
      const h2 = buildRequestHash("POST", "/api/tenants", body);
      expect(h1).toBe(h2);
    });

    it("different body produces different hash", () => {
      const body1 = new TextEncoder().encode('{"name":"a"}');
      const body2 = new TextEncoder().encode('{"name":"b"}');
      const h1 = buildRequestHash("POST", "/api/tenants", body1);
      const h2 = buildRequestHash("POST", "/api/tenants", body2);
      expect(h1).not.toBe(h2);
    });

    it("hash is case-insensitive on method", () => {
      const body = new TextEncoder().encode("test");
      const h1 = buildRequestHash("post", "/api/tenants", body);
      const h2 = buildRequestHash("POST", "/api/tenants", body);
      expect(h1).toBe(h2);
    });

    it("different paths produce different hashes for same body", () => {
      const body = new TextEncoder().encode('{"name":"x"}');
      const h1 = buildRequestHash("POST", "/api/tenants", body);
      const h2 = buildRequestHash("POST", "/api/tenants/t1/domains", body);
      expect(h1).not.toBe(h2);
    });

    it("hash is a 64-char hex string (SHA-256)", () => {
      const body = new TextEncoder().encode("body");
      const hash = buildRequestHash("POST", "/api/tenants", body);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ── Handler error handling ─────────────────────────────────────────────────
  describe("handler error handling", () => {
    it("releases the in-flight claim and re-throws when handler throws", async () => {
      const storeWithClaim = makeMockStore({
        putIfAbsent: vi.fn().mockResolvedValue(true),
      });

      const throwingNext = vi.fn(async () => {
        throw new Error("handler exploded");
      });

      const body = '{"name":"crash"}';
      const request = makePostRequest(body, { "Idempotency-Key": DEFAULT_KEY });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(storeWithClaim);

      await expect(middleware(context, throwingNext)).rejects.toThrow("handler exploded");

      // Claim should be deleted (best-effort) so retries can proceed
      expect(storeWithClaim.delete).toHaveBeenCalled();
    });

    it("does not cache 4xx responses, deletes in-flight claim", async () => {
      const storeWithClaim = makeMockStore({
        putIfAbsent: vi.fn().mockResolvedValue(true),
      });

      const errorNext = vi.fn(async () => {
        return new Response('{"error":"BAD_REQUEST"}', {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      });

      const body = '{"name":"bad"}';
      const request = makePostRequest(body, { "Idempotency-Key": DEFAULT_KEY });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(storeWithClaim);

      const response = await middleware(context, errorNext);

      expect(response.status).toBe(400);
      expect(storeWithClaim.resolve).not.toHaveBeenCalled();
      expect(storeWithClaim.delete).toHaveBeenCalled();
    });

    it("caches 2xx responses", async () => {
      const storeWithClaim = makeMockStore({
        putIfAbsent: vi.fn().mockResolvedValue(true),
      });

      const body = '{"name":"ok"}';
      const request = makePostRequest(body, { "Idempotency-Key": DEFAULT_KEY });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(storeWithClaim);

      await middleware(context, mockNext);

      expect(storeWithClaim.resolve).toHaveBeenCalled();
      expect(storeWithClaim.delete).not.toHaveBeenCalled();
    });
  });

  // ── Empty body ─────────────────────────────────────────────────────────────
  describe("empty body", () => {
    it("handles POST with no body (content-length 0)", async () => {
      const request = new Request("https://api.example.com/api/tenants/t1/domains/d1/verify", {
        method: "POST",
        headers: {
          "Idempotency-Key": DEFAULT_KEY,
          "content-length": "0",
        },
      });
      const context = makeContext(request, new URL("https://api.example.com/api/tenants/t1/domains/d1/verify"));
      const middleware = idempotencyMiddleware(mockStore);

      const response = await middleware(context, mockNext);

      expect(mockStore.putIfAbsent).toHaveBeenCalled();
      expect(response.status).toBe(201);
    });
  });

  // ── Replay header filtering ────────────────────────────────────────────────
  describe("response header filtering", () => {
    it("does not persist security headers in the cache", async () => {
      const securityHeadersNext = vi.fn(async () => {
        return new Response('{"id":"new"}', {
          status: 201,
          headers: {
            "content-type": "application/json",
            "strict-transport-security": "max-age=31536000",
            "x-frame-options": "DENY",
            "x-custom-header": "preserved",
          },
        });
      });

      const body = '{"name":"hdr-test"}';
      const request = makePostRequest(body, { "Idempotency-Key": DEFAULT_KEY });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(mockStore);

      await middleware(context, securityHeadersNext);

      const resolveCall = (mockStore.resolve as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const storedHeaders = resolveCall.responseHeaders;

      expect(storedHeaders["strict-transport-security"]).toBeUndefined();
      expect(storedHeaders["x-frame-options"]).toBeUndefined();
      expect(storedHeaders["x-custom-header"]).toBe("preserved");
    });

    it("HIGH-2: strips authorization, www-authenticate, proxy-authenticate, and x-csrf-token from replays", async () => {
      const authHeadersNext = vi.fn(async () => {
        return new Response('{"id":"new"}', {
          status: 201,
          headers: {
            "content-type": "application/json",
            authorization: "Bearer secret-token",
            "www-authenticate": "Basic realm=trellis",
            "proxy-authenticate": "Basic realm=proxy",
            "x-csrf-token": "csrf-12345",
          },
        });
      });

      const body = '{"name":"auth-hdr-test"}';
      const request = makePostRequest(body, { "Idempotency-Key": DEFAULT_KEY });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(mockStore);

      await middleware(context, authHeadersNext);

      const resolveCall = (mockStore.resolve as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const storedHeaders = resolveCall.responseHeaders;

      expect(storedHeaders["authorization"]).toBeUndefined();
      expect(storedHeaders["www-authenticate"]).toBeUndefined();
      expect(storedHeaders["proxy-authenticate"]).toBeUndefined();
      expect(storedHeaders["x-csrf-token"]).toBeUndefined();
    });
  });

  // ── HIGH-1: tenant-scoped dedup key ─────────────────────────────────────────
  describe("HIGH-1: tenant scoping of dedup keys", () => {
    it("produces distinct store pks for the same Idempotency-Key under different tenant paths", async () => {
      const body = '{"name":"x"}';
      const seenKeys: string[] = [];
      const captureStore: IdempotencyStoreInterface = {
        get: vi.fn().mockImplementation(async (pk: string) => {
          seenKeys.push(pk);
          return null;
        }),
        putIfAbsent: vi.fn().mockResolvedValue(true),
        resolve: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      };

      const middleware = idempotencyMiddleware(captureStore);

      const ctxA: MiddlewareContext = {
        request: new Request("https://api.example.com/api/tenants/tenant-a/domains", {
          method: "POST",
          headers: { "Idempotency-Key": DEFAULT_KEY, "content-type": "application/json" },
          body,
        }),
        env: {} as Env,
        url: new URL("https://api.example.com/api/tenants/tenant-a/domains"),
        pathname: "/api/tenants/tenant-a/domains",
        method: "POST",
      };
      const ctxB: MiddlewareContext = {
        request: new Request("https://api.example.com/api/tenants/tenant-b/domains", {
          method: "POST",
          headers: { "Idempotency-Key": DEFAULT_KEY, "content-type": "application/json" },
          body,
        }),
        env: {} as Env,
        url: new URL("https://api.example.com/api/tenants/tenant-b/domains"),
        pathname: "/api/tenants/tenant-b/domains",
        method: "POST",
      };

      await middleware(ctxA, mockNext);
      await middleware(ctxB, mockNext);

      expect(seenKeys.length).toBe(2);
      expect(seenKeys[0]).not.toBe(seenKeys[1]);
      expect(seenKeys[0]).toContain("t:tenant-a");
      expect(seenKeys[1]).toContain("t:tenant-b");
    });
  });

  // ── HIGH-3: strict Content-Length parser ────────────────────────────────────
  describe("HIGH-3: Content-Length parser tightening", () => {
    // Note: leading/trailing whitespace cannot reach the middleware — the
    // Headers constructor strips it per RFC 7230 §3.2 — so it isn't a
    // realistic attack vector and we don't include it in the matrix.
    it.each([
      ["-1", "negative value"],
      ["1.0e10", "scientific notation"],
      ["foo", "non-numeric"],
      ["1.5", "decimal"],
      ["0x10", "hex literal"],
    ])("rejects malformed Content-Length: %s (%s)", async (cl) => {
      const request = new Request("https://api.example.com/api/tenants", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": cl,
          "Idempotency-Key": DEFAULT_KEY,
        },
        body: "x",
      });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(mockStore);

      const response = await middleware(context, mockNext);

      expect(response.status).toBe(413);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("IDEMPOTENCY_BODY_TOO_LARGE");
    });
  });

  // ── MEDIUM-5: in-flight TTL vs resolved TTL ─────────────────────────────────
  describe("MEDIUM-5: short in-flight TTL", () => {
    it("writes a 60s in-flight sentinel and a 24h resolved record", async () => {
      const captured: Array<{ phase: string; expiresAt: number }> = [];
      const captureStore: IdempotencyStoreInterface = {
        get: vi.fn().mockResolvedValue(null),
        putIfAbsent: vi.fn().mockImplementation(async (rec) => {
          captured.push({ phase: "in-flight", expiresAt: rec.expiresAt });
          return true;
        }),
        resolve: vi.fn().mockImplementation(async (rec) => {
          captured.push({ phase: "resolved", expiresAt: rec.expiresAt });
        }),
        delete: vi.fn().mockResolvedValue(undefined),
      };

      const body = '{"name":"ttl"}';
      const request = makePostRequest(body, { "Idempotency-Key": DEFAULT_KEY });
      const context = makeContext(request);
      const middleware = idempotencyMiddleware(captureStore);

      const before = Math.floor(Date.now() / 1000);
      await middleware(context, mockNext);
      const after = Math.floor(Date.now() / 1000);

      const inFlight = captured.find((c) => c.phase === "in-flight");
      const resolved = captured.find((c) => c.phase === "resolved");
      expect(inFlight).toBeDefined();
      expect(resolved).toBeDefined();

      // In-flight TTL must be ≤ 60s from now.
      expect(inFlight!.expiresAt - before).toBeGreaterThanOrEqual(0);
      expect(inFlight!.expiresAt - after).toBeLessThanOrEqual(60);

      // Resolved TTL must be ≥ ~23h from now (24h - tolerance).
      expect(resolved!.expiresAt - before).toBeGreaterThan(60);
      expect(resolved!.expiresAt - after).toBeGreaterThan(23 * 60 * 60);
    });
  });
});

// ─── buildRequestHash standalone tests ────────────────────────────────────────

describe("buildRequestHash (exported)", () => {
  it("is a pure function of method + path + body", () => {
    const b = new TextEncoder().encode("body-data");
    expect(buildRequestHash("POST", "/path", b)).toBe(
      buildRequestHash("POST", "/path", b),
    );
  });

  it("hex output is 64 characters long", () => {
    const h = buildRequestHash("POST", "/", new Uint8Array(0));
    expect(h.length).toBe(64);
  });
});

// ─── routeNeedsIdempotency (plan 034, lane C.2) ───────────────────────────────

describe("routeNeedsIdempotency (exported metadata rule)", () => {
  // Truth table required by the lane spec: public+POST, public+GET,
  // private+POST, explicit opt-out.
  it("public + POST (mutating) → true (the default rule)", () => {
    expect(
      routeNeedsIdempotency({ publicSpec: true, method: "POST" }),
    ).toBe(true);
  });

  it("public + GET (non-mutating) → false", () => {
    expect(
      routeNeedsIdempotency({ publicSpec: true, method: "GET" }),
    ).toBe(false);
  });

  it("private (no publicSpec) + POST → false", () => {
    expect(
      routeNeedsIdempotency({ publicSpec: false, method: "POST" }),
    ).toBe(false);
    expect(routeNeedsIdempotency({ method: "POST" })).toBe(false);
  });

  it("explicit opt-out (idempotent: false) wins even for public + POST", () => {
    expect(
      routeNeedsIdempotency({
        publicSpec: true,
        method: "POST",
        idempotent: false,
      }),
    ).toBe(false);
  });

  // Beyond the required four: the other stated precedence rules.
  it("explicit opt-in (idempotent: true) wins even for a private GET", () => {
    expect(
      routeNeedsIdempotency({
        publicSpec: false,
        method: "GET",
        idempotent: true,
      }),
    ).toBe(true);
  });

  it("mutating methods beyond POST count as mutating under the default rule", () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      expect(
        routeNeedsIdempotency({ publicSpec: true, method }),
        `expected ${method} to be treated as mutating`,
      ).toBe(true);
    }
  });

  it("an array of methods is mutating if any entry is mutating", () => {
    expect(
      routeNeedsIdempotency({ publicSpec: true, method: ["GET", "POST"] }),
    ).toBe(true);
    expect(
      routeNeedsIdempotency({ publicSpec: true, method: ["GET", "HEAD"] }),
    ).toBe(false);
  });

  it("an unrestricted method ('*' or absent) is treated as potentially mutating", () => {
    expect(routeNeedsIdempotency({ publicSpec: true, method: "*" })).toBe(
      true,
    );
    expect(routeNeedsIdempotency({ publicSpec: true })).toBe(true);
  });

  it("method matching is case-insensitive", () => {
    expect(routeNeedsIdempotency({ publicSpec: true, method: "post" })).toBe(
      true,
    );
  });
});
