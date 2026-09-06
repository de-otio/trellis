/**
 * Per-request identity slot (S5)
 *
 * The same token is resolved twice, under two different sets of rules:
 *
 *   A — `SessionManager.getSession()` → `Session`. Bearer JWT → cookie →
 *       sealed token, with cuid validation, JIT claim resolution and the
 *       revocation checks (per-token blocklist + per-user session epoch).
 *   B — `authMiddleware()` → `AuthContext`. Bearer JWT only, plus a lazy
 *       memberships loader.
 *
 * They are **not** interchangeable and this module does not merge them:
 * unifying them would move an authorization boundary. What it does is make
 * each of them happen **at most once per request** — today the modal
 * authenticated request performs resolution A three times, and each repeat
 * costs an asymmetric JWT verify plus two to three KV round-trips (the
 * blocklist read, the epoch read and, on a claimless token, the JIT claims
 * read). Those are network calls, not cache hits.
 *
 * ## Why a memo and not a cache
 *
 * `createRequestIdentity` returns a closure over two `let` bindings. There is
 * no key, no map, no TTL and no eviction — the three things that make a cache
 * leak one request's identity into another's. Its lifetime is the lifetime of
 * the context object `server.ts` builds inside the per-request handler, so it
 * becomes garbage when the response is written.
 *
 * A token-keyed cache across requests would be a *security* regression rather
 * than an optimization: the blocklist and epoch reads **are** the revocation
 * check, so a cached session would keep answering after a logout — including
 * a "log out everywhere". Never introduce one, at any TTL.
 *
 * ## Why the promise is memoized rather than the value
 *
 * Two components awaiting concurrently then share one in-flight resolution
 * instead of racing two.
 *
 * ## Why it is lazy
 *
 * Most routes never need resolution B, and 58 routes need no identity at all.
 * An eager resolution would tax them with a verify and a KV read for nothing.
 *
 * ## Why the session is frozen
 *
 * Under a memo every consumer within one request shares one `Session` object.
 * `mfaVerified` is an authorization input, so one component mutating the
 * shared session in place could become a later component's security decision.
 * Freezing turns that into a loud `TypeError` (ESM is always strict) instead
 * of a silent shared write. The freeze is shallow — it is a guard against
 * accidental field writes, not a deep immutability claim.
 *
 * ## Why the fallback is safe
 *
 * `resolveSession` / `resolveAuth` take the request context as an *optional*
 * argument. With no context (context construction threw, or a unit test
 * passes `requestContext: undefined`) they resolve exactly as the call site
 * did before: the degradation is "slower", never "someone else's identity"
 * and never "open".
 *
 * Design: `plans/trellis-s5-request-context.md` §3.2, §4.
 */

import type { Env } from "../env.js";
import type { AuthContext } from "./auth/auth-context.js";
import type { TrellisRequestContext } from "./request-context.js";
import type { Session } from "./session-cookie.js";

// Extend TrellisRequestContext with the optional identity slot. Declared here
// (rather than in request-context.ts) so the slot travels with the module that
// owns it — the same pattern age-gate-middleware.ts uses for `featureAccess`.
declare module "./request-context.js" {
  interface TrellisRequestContext {
    identity?: RequestIdentity;
  }
}

/**
 * The two identity resolutions of one request, each performed at most once.
 *
 * Do not add a setter, an invalidator or a way to re-key this object. Both
 * methods are idempotent by construction; anything that can replace the
 * memoized value can also replace it with another request's.
 */
export interface RequestIdentity {
  /** Resolution A — the full session, including the revocation checks. */
  session(): Promise<Session | null>;
  /** Resolution B — the JWT-only auth context. */
  auth(): Promise<AuthContext | null>;
}

/**
 * Build the identity slot for one request. Call once, in the per-request
 * handler; never at module scope and never for a request other than the one
 * being served.
 */
export function createRequestIdentity(request: Request, env: Env): RequestIdentity {
  let sessionPromise: Promise<Session | null> | undefined;
  let authPromise: Promise<AuthContext | null> | undefined;

  return {
    session: () => (sessionPromise ??= resolveSessionUncached(request, env)),
    auth: () => (authPromise ??= resolveAuthUncached(request, env)),
  };
}

/**
 * Resolution A for one request, through the memo when there is one.
 *
 * Drop-in for `new SessionManager().getSession(request, env.SESSION_SECRET, env)`.
 */
export async function resolveSession(
  request: Request,
  env: Env,
  requestContext?: TrellisRequestContext,
): Promise<Session | null> {
  return requestContext?.identity
    ? requestContext.identity.session()
    : resolveSessionUncached(request, env);
}

/**
 * Resolution B for one request, through the memo when there is one.
 *
 * Drop-in for `authMiddleware(request, env)`.
 */
export async function resolveAuth(
  request: Request,
  env: Env,
  requestContext?: TrellisRequestContext,
): Promise<AuthContext | null> {
  return requestContext?.identity
    ? requestContext.identity.auth()
    : resolveAuthUncached(request, env);
}

async function resolveSessionUncached(
  request: Request,
  env: Env,
): Promise<Session | null> {
  const secret = env?.SESSION_SECRET;
  // Mirrors server.ts: with no secret there is nothing to resolve. getSession
  // would return null for the same reason; this just skips the import.
  if (!secret) return null;

  const { SessionManager } = await import("./session-cookie.js");
  const session = await new SessionManager().getSession(request, secret, env);
  return session ? Object.freeze(session) : null;
}

async function resolveAuthUncached(
  request: Request,
  env: Env,
): Promise<AuthContext | null> {
  const { authMiddleware } = await import("./auth/auth-middleware.js");
  return authMiddleware(request, env);
}
