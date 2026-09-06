/**
 * Route Types
 *
 * Shared types and interfaces for route definitions.
 */

import type { ZodType } from "zod";
import type { Env } from "../../env.js";
import type { TrellisRequestContext } from "../request-context.js";
import type { Middleware } from "../middleware.js";

/**
 * A route's path pattern: an exact/prefix string or an anchored RegExp.
 * (Historically lived in the now-removed `route-matcher.ts`; the linear
 * matcher it served was superseded by the Hono router in Stream 2.1.)
 */
export type RoutePattern = string | RegExp;

export interface Route {
  /**
   * Route pattern (exact path, prefix with *, or regex)
   * Examples:
   * - '/health' (exact)
   * - '/auth/*' (prefix)
   * - '/api/users/:id' (with parameter)
   * - /^\/api\/posts\/(\d+)$/ (regex)
   */
  path: RoutePattern;

  /**
   * HTTP method(s) - '*' for all methods, or specific method(s)
   */
  method?: string | string[];

  /**
   * Route handler function
   */
  handler: (
    request: Request,
    env: Env,
    context: {
      url: URL;
      pathname: string;
      params: Record<string, string>;
      requestContext?: TrellisRequestContext;
    },
  ) => Promise<Response>;

  /**
   * Middleware to apply (executed in order)
   */
  middleware?: Middleware[];

  /**
   * Route description (for documentation)
   */
  description?: string;

  /**
   * API version (for versioning support).
   *
   * Currently unread by anything. **Reserved** for the public-surface rule
   * ("in the spec ⇔ under `/api/v1` ⇔ covered by the additivity gate") rather
   * than being a second versioning concept — do not introduce another field
   * for that; extend the meaning of this one.
   */
  version?: string;

  // -------------------------------------------------------------------------
  // Self-description (declaration only — no dispatcher reads these yet)
  //
  // These let a route say what it is, so that the OpenAPI document, the scope
  // gate and the idempotency middleware can be driven from the route table
  // instead of from a hand-maintained list beside it. Every field is optional;
  // a route that declares none behaves exactly as it does today.
  // -------------------------------------------------------------------------

  /**
   * Scopes a third-party principal must hold to call this route.
   *
   * Three distinct states, and the difference matters:
   * - **absent** — first-party only. No third-party client reaches it.
   * - **`[]`** — any authenticated principal, no particular scope.
   * - **non-empty** — every listed scope required (`hasScope` semantics,
   *   `auth/scopes.ts`). Strings are `<resource>:<verb>`; core's vocabulary is
   *   `CORE_SCOPES`, and an extension route may also name its own.
   *
   * A first-party session (`"*"`) satisfies all three.
   */
  scopes?: string[];

  /**
   * Which mount actually checks this route's `scopes`.
   *
   * Absent (every hand-written core route) means "the `/api/v1` public mount,
   * and nothing else" — which is why `assertPublicMountWiring` refuses
   * non-empty `scopes` without `publicSpec: true`: such a route looks gated
   * and is open.
   *
   * `"extension-wrapper"` is set by `wrapExtensionRoute` on every route it
   * builds. For those the premise is false: the wrapper runs
   * `requireScope(session, routeDef.scopes)` inside the handler it emits, on
   * the unversioned `/api/ext/...` mount, whether or not the route is also
   * published. Sweep C6 — without this marker a *private* extension route
   * with scopes could not boot at all, so the published rule "non-empty —
   * every listed scope required" was unexercisable as documented and a scope
   * could only be attached to a route by also making it public.
   */
  scopesEnforcedBy?: "extension-wrapper";

  /** Grouping for the generated spec — becomes an OpenAPI tag. */
  tags?: string[];

  /**
   * Zod schema for the request body. Emitted as JSON Schema in the spec, and
   * the intended validation point *before* the handler runs.
   *
   * `ZodType` is Zod v4's base type; `ZodSchema` is the v3 name for the same
   * thing and is not used in new declarations here.
   */
  requestSchema?: ZodType;

  /** Zod schema for the success response body. Emitted as JSON Schema. */
  responseSchema?: ZodType;

  /**
   * Stable machine name for this operation (OpenAPI `operationId`). It is the
   * symbol a generated client is named after, so it should outlive the path.
   */
  operationId?: string;

  /**
   * Whether a repeated call with the same `Idempotency-Key` must be
   * de-duplicated rather than re-executed. Expected to be true for every
   * public write.
   */
  idempotent?: boolean;

  /**
   * The compatibility promise this route carries in the published spec.
   * `"beta"` says the shape may change without a major bump; absent means
   * unstated, which for a route that is not `publicSpec` is the normal case.
   */
  stability?: "stable" | "beta";

  /**
   * Opt-in flag for publication on the public OpenAPI spec
   * (`/openapi.json`) (G4 MEDIUM-3). Default `false` — only routes
   * explicitly marked `publicSpec: true` appear in the document. The
   * agent-discovery surface and the federation management routes are
   * expected to set this; non-federation routes (posts, comments,
   * media, ActivityPub, etc.) are excluded from the public spec.
   */
  publicSpec?: boolean;
}
