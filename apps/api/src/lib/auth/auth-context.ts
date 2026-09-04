/**
 * AuthContext — the resolved identity for one authenticated request.
 *
 * Built by authMiddleware from verified Cognito JWT claims. Every route
 * handler that needs auth information receives this rather than the raw
 * token payload.
 */

import type { TenantRole, UserRole, TenantMember, Tenant } from "@prisma/client";
import type { ScopeSet } from "./scopes.js";

/** The data carried from a verified JWT into each request. */
export interface AuthContext {
  /** Opaque IdP subject (`sub`). Stable identifier used for cache keys. */
  sub: string;
  /** Trellis `User.id` (cuid). */
  userId: string;
  /** Platform-wide role from `users.role`. */
  globalRole: UserRole;
  /** The tenant the user is currently acting as (`custom:activeTenantId`). */
  activeTenantId: string;
  /** Human-readable slug of the active tenant. */
  tenantSlug: string;
  /** Role within the active tenant. */
  tenantRole: TenantRole;
  /** ActivityPub-style handle. */
  handle: string;
  /**
   * Lazy loader for all of the user's tenant memberships.
   * Fetched at most once per request; stored on the context so callers
   * (e.g. tenant-switcher UI) don't duplicate the DB query.
   */
  membershipsLoader: () => Promise<(TenantMember & { tenant: Tenant })[]>;

  // -------------------------------------------------------------------------
  // Principal (declaration only — nothing reads these yet)
  // -------------------------------------------------------------------------

  /**
   * The third-party client acting on the user's behalf, if any.
   *
   * **Absent means first-party** — the human's own cookie or JWT session, with
   * no client in between. It stays `undefined` in production until an
   * authorization server exists to populate it; the field exists now so that
   * the day it is populated, no other type has to change.
   */
  clientId?: string;

  /**
   * What this request was granted. See {@link ScopeSet}.
   *
   * **Optional, and absent is equivalent to `"*"`** — every context built
   * before scopes existed is a first-party session, so treating an absent
   * value as unscoped preserves today's behaviour exactly and is why this
   * addition breaks no construction site. Code that reads it must therefore
   * normalise explicitly (`auth.scopes ?? "*"`) rather than relying on
   * `hasScope` to guess: the permissive default should be visible at the
   * place that applies it, not buried in the predicate.
   *
   * Once a path can produce a non-first-party principal it must set this
   * field on *every* branch, including the failure branches — an unset value
   * on a third-party path reads as full access.
   */
  scopes?: ScopeSet;
}
