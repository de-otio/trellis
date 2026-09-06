/**
 * Unit tests: per-request identity slot (S5)
 *
 * These are the guards the S5 design pass named as preconditions for the
 * refactor. In its numbering:
 *
 *   T1 — cross-request isolation under interleaving, with the underlying
 *        resolution deferred and completed OUT OF ORDER. A sequential loop
 *        passes even against a module-level singleton and is therefore
 *        worthless as a guard; the reverse-order completion is the point.
 *   T2 — the memo actually memoizes: one resolution per request, across the
 *        three converted middleware sharing one request context.
 *   T3 — no module-level binding typed `TrellisRequestContext` (a shared
 *        default context is the one realistic way to introduce a leak here,
 *        because the context is mutated in place).
 *   T4 — fallback equivalence: with no request context the call degrades to
 *        a fresh resolution — slower, never wrong and never open.
 *   T5 — the memoized session is frozen, so a future in-place write throws
 *        instead of silently becoming another component's decision input.
 *
 * The underlying resolvers are spied on their real prototypes/namespace
 * rather than replaced with a module factory, so the module under test keeps
 * its own dynamic imports and the concurrency being asserted is real.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { Env } from "../../src/env.js";
import type { AuthContext } from "../../src/lib/auth/auth-context.js";
import * as authMiddlewareModule from "../../src/lib/auth/auth-middleware.js";
import {
  composeMiddleware,
  csrfMiddleware,
  mfaMiddleware,
  rateLimitMiddleware,
  type MiddlewareContext,
} from "../../src/lib/middleware.js";
import { RateLimiter } from "../../src/lib/rate-limit.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";
import {
  createRequestIdentity,
  resolveAuth,
  resolveSession,
} from "../../src/lib/request-identity.js";
import { SessionManager, type Session } from "../../src/lib/session-cookie.js";

const CSRF_TOKEN = "csrf-token-for-tests";
// A syntactically valid session secret (>= 32 chars). Test-only literal.
const SESSION_SECRET = "session-secret-for-unit-tests-0123456789";

const env = { SESSION_SECRET } as unknown as Env;

/** Resolutions parked by the deferred stub, in arrival order. */
let pending: Array<() => void> = [];
let sessionCalls = 0;
let authCalls = 0;
/** When true, the session stub parks until the test releases it. */
let defer = false;

function sessionFor(request: Request): Session | null {
  const userId = request.headers.get("x-test-user");
  if (!userId) return null;
  return {
    userId,
    email: `${userId}@example.com`,
    expiresAt: Date.now() + 3_600_000,
    dataRegion: "EU",
    profileContext: "primary",
    csrfToken: CSRF_TOKEN,
  } as Session;
}

beforeEach(() => {
  pending = [];
  sessionCalls = 0;
  authCalls = 0;
  defer = false;

  vi.spyOn(SessionManager.prototype, "getSession").mockImplementation(
    async (request: Request) => {
      sessionCalls += 1;
      const session = sessionFor(request);
      if (!defer) return session;
      return new Promise<Session | null>((resolve) => {
        pending.push(() => resolve(session));
      });
    },
  );

  vi.spyOn(authMiddlewareModule, "authMiddleware").mockImplementation(
    async (request: Request): Promise<AuthContext | null> => {
      authCalls += 1;
      const userId = request.headers.get("x-test-auth-user");
      return userId ? ({ userId } as AuthContext) : null;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeRequest(userId: string | null, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (userId) headers.set("x-test-user", userId);
  return new Request("https://api.example.com/api/posts", { ...init, headers });
}

/** What `server.ts` builds per request, minus the region machinery. */
function makeRequestContext(request: Request): TrellisRequestContext {
  return {
    region: "EU",
    config: {} as TrellisRequestContext["config"],
    identity: createRequestIdentity(request, env),
  };
}

/** Wait, with a bounded number of turns, until `predicate` holds. */
async function until(predicate: () => boolean, maxTurns = 200): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not reached within the turn budget");
}

describe("T1 — cross-request isolation under interleaved, out-of-order completion", () => {
  it("gives every request its own identity when 50 requests complete in reverse order", async () => {
    const REQUESTS = 50;
    defer = true;

    const requests = Array.from({ length: REQUESTS }, (_, i) =>
      makeRequest(`user-${i % 3}`),
    );

    // Every request resolves its session twice, the way a middleware and the
    // handler it guards would, and all of them are in flight at once.
    const inflight = requests.map(async (request) => {
      const requestContext = makeRequestContext(request);
      const [first, second] = await Promise.all([
        resolveSession(request, env, requestContext),
        resolveSession(request, env, requestContext),
      ]);
      return {
        expected: request.headers.get("x-test-user"),
        first: first?.userId ?? null,
        second: second?.userId ?? null,
      };
    });

    await until(() => pending.length === REQUESTS);

    // Complete in REVERSE arrival order: the last request to arrive is the
    // first to finish. Any shared or ambient slot shows up here.
    for (const release of [...pending].reverse()) release();

    const results = await Promise.all(inflight);

    expect(results).toHaveLength(REQUESTS);
    for (const result of results) {
      expect(result.first).toBe(result.expected);
      expect(result.second).toBe(result.expected);
    }
    // One resolution per request, not per call site — 50, not 100.
    expect(sessionCalls).toBe(REQUESTS);
  });

  it("does not share a memo between two request contexts for the same request object", async () => {
    const request = makeRequest("user-a");

    const a = await resolveSession(request, env, makeRequestContext(request));
    const b = await resolveSession(request, env, makeRequestContext(request));

    expect(a?.userId).toBe("user-a");
    expect(b?.userId).toBe("user-a");
    // Two contexts, two resolutions: the memo is scoped to the context, and
    // nothing keyed by the token or the request survives it.
    expect(sessionCalls).toBe(2);
    expect(a).not.toBe(b);
  });
});

describe("T2 — the memo memoizes", () => {
  it("resolves the session once per context however often it is asked", async () => {
    const request = makeRequest("user-a");
    const requestContext = makeRequestContext(request);

    const results = await Promise.all([
      resolveSession(request, env, requestContext),
      resolveSession(request, env, requestContext),
      resolveSession(request, env, requestContext),
    ]);

    expect(results.map((s) => s?.userId)).toEqual(["user-a", "user-a", "user-a"]);
    expect(results[0]).toBe(results[1]);
    expect(sessionCalls).toBe(1);
  });

  it("resolves the auth context once per context, and only when asked", async () => {
    const request = makeRequest("user-a", {
      headers: { "x-test-auth-user": "user-a" },
    });
    const requestContext = makeRequestContext(request);

    // Resolution B is lazy: filling the session memo must not touch it.
    await resolveSession(request, env, requestContext);
    expect(authCalls).toBe(0);

    const [first, second] = await Promise.all([
      resolveAuth(request, env, requestContext),
      resolveAuth(request, env, requestContext),
    ]);

    expect(first?.userId).toBe("user-a");
    expect(first).toBe(second);
    expect(authCalls).toBe(1);
  });

  it("resolves once across csrf, rate-limit and mfa middleware sharing one context", async () => {
    // The regression guard for the conversion: reintroducing a direct
    // getSession() in any of these three makes this count climb.
    // The limiter is forced to fail so the middleware takes its documented
    // fail-open path on a non-sensitive route without touching any store.
    vi.spyOn(RateLimiter.prototype, "checkRateLimitKVStrict").mockRejectedValue(
      new Error("rate limiter unavailable"),
    );

    const request = new Request("https://api.example.com/api/posts", {
      method: "POST",
      headers: {
        "x-test-user": "user-a",
        Cookie: "trellis_session=opaque",
        "X-CSRF-Token": CSRF_TOKEN,
      },
    });
    const context: MiddlewareContext = {
      request,
      env,
      requestContext: makeRequestContext(request),
      url: new URL(request.url),
      pathname: "/api/posts",
      method: "POST",
    };

    const composed = composeMiddleware([
      csrfMiddleware(),
      rateLimitMiddleware(),
      mfaMiddleware(),
    ]);
    const response = await composed(context, async () => new Response("ok"));

    expect(response.status).toBe(200);
    expect(sessionCalls).toBe(1);
  });

  it("still resolves once per middleware chain when there is no context to share", async () => {
    // Same chain, no identity slot: proves the count above is the memo doing
    // the work and not the middleware having stopped asking.
    vi.spyOn(RateLimiter.prototype, "checkRateLimitKVStrict").mockRejectedValue(
      new Error("rate limiter unavailable"),
    );

    const request = new Request("https://api.example.com/api/posts", {
      method: "POST",
      headers: {
        "x-test-user": "user-a",
        Cookie: "trellis_session=opaque",
        "X-CSRF-Token": CSRF_TOKEN,
      },
    });
    const context: MiddlewareContext = {
      request,
      env,
      requestContext: undefined,
      url: new URL(request.url),
      pathname: "/api/posts",
      method: "POST",
    };

    const composed = composeMiddleware([
      csrfMiddleware(),
      rateLimitMiddleware(),
      mfaMiddleware(),
    ]);
    const response = await composed(context, async () => new Response("ok"));

    expect(response.status).toBe(200);
    expect(sessionCalls).toBe(3);
  });
});

describe("T3 — no module-level request context", () => {
  it("declares no module-scoped binding typed TrellisRequestContext", () => {
    const srcRoot = join(import.meta.dirname, "../../src");
    // A module-level context would be shared by every request that falls back
    // to it, and the context is mutated in place (age-gate-middleware.ts), so
    // one request's identity would become another's.
    const moduleScopedBinding =
      /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z0-9_$]+\s*:\s*(?:TrellisRequestContext|Partial<TrellisRequestContext>)\b/m;

    const offenders = walkTypeScript(srcRoot).filter((file) =>
      moduleScopedBinding.test(readFileSync(file, "utf8")),
    );

    expect(offenders).toEqual([]);
  });
});

describe("T4 — fallback equivalence when there is no request context", () => {
  it("still resolves the right session, once per call", async () => {
    const request = makeRequest("user-a");

    const first = await resolveSession(request, env, undefined);
    const second = await resolveSession(request, env, undefined);

    expect(first?.userId).toBe("user-a");
    expect(second?.userId).toBe("user-a");
    // Degrades to slower, not to wrong: two calls, two resolutions.
    expect(sessionCalls).toBe(2);
  });

  it("still refuses an unauthenticated request", async () => {
    const anonymous = makeRequest(null);

    expect(await resolveSession(anonymous, env, undefined)).toBeNull();
    expect(await resolveAuth(anonymous, env, undefined)).toBeNull();
    expect(sessionCalls).toBe(1);
    expect(authCalls).toBe(1);
  });

  it("resolves nothing when the deployment has no session secret", async () => {
    const request = makeRequest("user-a");

    expect(await resolveSession(request, {} as Env, undefined)).toBeNull();
    expect(sessionCalls).toBe(0);
  });
});

describe("T5 — the memoized session is frozen", () => {
  it("freezes the session and throws on an in-place write", async () => {
    const request = makeRequest("user-a");
    const session = await resolveSession(request, env, makeRequestContext(request));

    expect(session).not.toBeNull();
    expect(Object.isFrozen(session)).toBe(true);
    expect(() => {
      (session as Session).mfaVerified = true;
    }).toThrow(TypeError);
    expect(session?.mfaVerified).toBeUndefined();
  });
});

/** Every hand-written .ts file under `dir`. */
function walkTypeScript(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...walkTypeScript(path));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      found.push(path);
    }
  }
  return found;
}
