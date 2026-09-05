/**
 * Authorization helpers — role, capability and scope gating.
 *
 * Layers:
 *  1. `requireRole`            — coarse role-rank check (legacy; T3 uses it).
 *  2. `requireCapability(cap)` — full capability matrix + resource scoping.
 *  3. `requireScope(scopes)`   — delegated-authority check (plan 034 lane A).
 *
 * SUPER_ADMIN bypasses every *role/capability* check (platform-wide override).
 * It deliberately does **not** bypass `requireScope`: see that function.
 *
 * Capabilities and scopes are **orthogonal and both must pass**. They are not
 * merged, and `capabilities.ts` must not learn about scopes:
 *
 *   - a **capability** answers "what may this role do in this tenant" — it is
 *     derived from the user's role and is a property of *the user*;
 *   - a **scope** answers "how much of the user's authority did the user
 *     delegate to this client" — it is a property of *the credential*.
 *
 * A client holding `posts:write` on behalf of a GUEST still may not post; a
 * tenant OWNER acting through a client granted only `profile:read` still may
 * not post. Neither axis can stand in for the other, which is why the next
 * reader's instinct to unify them into one matrix is wrong.
 */

import type { TenantRole, UserRole } from "@prisma/client";
import type { AuthContext } from "./auth-context.js";
import { Capability, type CapabilityValue } from "./capabilities.js";
import { RoleGrants } from "./role-grants.js";
import { hasScope, type ScopeSet } from "./scopes.js";
import { structuredError, type StructuredError } from "../routes/errors.js";
import type { SecurityHeaders } from "../security-headers.js";

export { Capability, type CapabilityValue } from "./capabilities.js";
export { RoleGrants } from "./role-grants.js";

const ROLE_RANK: Record<TenantRole, number> = {
  OWNER: 4,
  ADMIN: 3,
  MEMBER: 2,
  GUEST: 1,
};

function isSuperAdmin(auth: AuthContext): boolean {
  return auth.globalRole === ("SUPER_ADMIN" as UserRole);
}

function forbidden(message: string): Response {
  return new Response(
    JSON.stringify({ error: "FORBIDDEN", message }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}

/**
 * Returns a 403 Response if the caller's tenant role is below `minRole`,
 * or null if the check passes. SUPER_ADMIN bypasses.
 */
export function requireRole(
  auth: AuthContext,
  minRole: TenantRole,
): Response | null {
  if (isSuperAdmin(auth)) return null;
  if (ROLE_RANK[auth.tenantRole] >= ROLE_RANK[minRole]) return null;
  return forbidden(`Requires tenant role ${minRole} or higher`);
}

/**
 * Resource carrier for capability-scoped checks.
 *
 * `authorId` and `ownerUserId` are the two ownership signals we recognise:
 *  - `authorId` for posts/comments
 *  - `ownerUserId` for entities (via EntityOwnership)
 *
 * Either one matching `auth.userId` is sufficient for own-only verbs.
 */
export interface CapabilityResource {
  authorId?: string | null;
  ownerUserId?: string | null;
}

export interface RequireCapabilityOptions {
  /** Resource being acted on; required for own-only capabilities. */
  resource?: CapabilityResource;
}

/**
 * Resource-scoped capabilities — own-only by default, granted to all if the
 * caller also holds the matching `*.moderate` capability.
 *
 * Per design (05-roles-and-permissions.md):
 *  - `post.update` / `post.delete`: own posts; `post.moderate` is the cross-user variant.
 *  - `entity.update` / `entity.delete`: own entities (via EntityOwnership);
 *    ADMIN/OWNER hold these unconditionally because they also hold `post.moderate`
 *    (cross-user takedown). MEMBER must own the entity.
 */
const OWN_ONLY_FALLBACK: Partial<Record<CapabilityValue, CapabilityValue>> = {
  [Capability.PostUpdate]: Capability.PostModerate,
  [Capability.PostDelete]: Capability.PostModerate,
  [Capability.EntityUpdate]: Capability.PostModerate,
  [Capability.EntityDelete]: Capability.PostModerate,
  // Events primitive (R1): own events for MEMBER; EventModerate (ADMIN+) is the
  // cross-user variant — same shape as the post/entity own-only verbs above.
  [Capability.EventUpdate]: Capability.EventModerate,
  [Capability.EventDelete]: Capability.EventModerate,
};

function isOwnedBy(
  resource: CapabilityResource | undefined,
  userId: string,
): boolean {
  if (!resource) return false;
  if (resource.authorId && resource.authorId === userId) return true;
  if (resource.ownerUserId && resource.ownerUserId === userId) return true;
  return false;
}

/**
 * Returns a 403 Response if the caller lacks `cap`, null on success.
 *
 * SUPER_ADMIN bypasses every check.
 *
 * For own-only capabilities (PostUpdate, PostDelete, EntityUpdate, EntityDelete):
 *   1. The role must hold the base capability.
 *   2. AND the resource must be owned by the caller, UNLESS the role also
 *      holds the matching cross-user moderation capability (PostModerate).
 *
 * If `options.resource` is omitted for an own-only capability, the check is
 * lenient (caps-only) — callers that load the resource must pass it through.
 */
export function requireCapability(
  auth: AuthContext,
  cap: CapabilityValue,
  options: RequireCapabilityOptions = {},
): Response | null {
  if (isSuperAdmin(auth)) return null;

  const grants = RoleGrants[auth.tenantRole];
  if (!grants.has(cap)) return forbidden(`Requires capability ${cap}`);

  const moderationCap = OWN_ONLY_FALLBACK[cap];
  if (!moderationCap) return null;

  if (grants.has(moderationCap)) return null;
  if (options.resource === undefined) return null;
  if (isOwnedBy(options.resource, auth.userId)) return null;

  return forbidden(`Requires ownership or ${moderationCap}`);
}

// ───────────────────────────────────────────────────────────────────────────
// Scope gate (plan 034 lane A)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The scope-carrying half of a principal.
 *
 * {@link AuthContext} satisfies this structurally, and so does core's internal
 * cookie `Session` — the two places a principal exists today. The parameter is
 * typed on the *fields the gate reads* rather than on `AuthContext` so the
 * extension-route wrapper (which holds a `Session`, never an `AuthContext`)
 * can call the same gate instead of growing a second copy of the rule. It is
 * not a widening of what passes: an object with no `scopes` is exactly the
 * first-party case that {@link requireScope} already admits.
 */
export interface ScopedPrincipal {
  /** The third-party client acting for the user; absent means first-party. */
  clientId?: string;
  /** What the credential was granted; absent is equivalent to `"*"`. */
  scopes?: ScopeSet;
}

/**
 * Format a scope list for human-facing copy: `` `a` ``, `` `a` and `b` ``,
 * `` `a`, `b` and `c` ``. Order follows the route's declaration so the string
 * is deterministic and diffable in a test.
 */
function formatScopeList(scopes: readonly string[]): string {
  const quoted = scopes.map((scope) => `\`${scope}\``);
  if (quoted.length <= 1) return quoted[0] ?? "";
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * Thrown by {@link requireScope}. Carries the standard 4xx envelope
 * (`lib/routes/errors.ts`) so every caller renders the identical body.
 *
 * **Why a throw and not a `Response | null` return** — unlike
 * `requireCapability`, whose ignored return value is a visible `null` sitting
 * unused, an authorization gate that can be *silently* skipped by forgetting
 * to check its result is the failure mode this lane exists to prevent. A
 * throw that some outer `catch` turns into a 500 is a wrong status; a return
 * value nobody reads is an authorization bypass. Only one of those is safe to
 * get wrong, so the gate throws.
 */
export class InsufficientScopeError extends Error {
  /** Always 403: the caller *is* authenticated, it is simply not permitted. */
  readonly status = 403 as const;
  /** The scopes that were required and absent, in declaration order. */
  readonly missing: readonly string[];
  /** The response body, ready for `structuredError`. */
  readonly body: StructuredError;

  constructor(missing: readonly string[]) {
    const list = formatScopeList(missing);
    const noun = missing.length === 1 ? "scope" : "scopes";
    super(`Insufficient scope: ${missing.join(", ")}`);
    this.name = "InsufficientScopeError";
    this.missing = missing;
    this.body = {
      error: "INSUFFICIENT_SCOPE",
      message: `This operation requires the ${list} ${noun}, which this credential was not granted.`,
      // Named literally, and actionable: an AI-driven client reads this string
      // and knows both what to ask for and that asking needs the user back in
      // the loop. "Insufficient scope" alone costs a support round trip.
      remediation: `Request the ${list} ${noun} and have the user re-authorize.`,
    };
  }

  /** Render the 403. Pass `securityHeaders` at a route boundary. */
  toResponse(securityHeaders?: SecurityHeaders): Response {
    return structuredError(this.status, this.body, securityHeaders);
  }
}

/**
 * The single scope gate. Throws {@link InsufficientScopeError} (403) when the
 * principal's grant does not cover `needed`; returns normally otherwise.
 *
 * Rules, in order:
 *  1. `scopes === "*"` — pass. A first-party session is unscoped by
 *     construction and predates scopes entirely.
 *  2. `needed.length === 0` — pass. "Authenticated, no particular scope."
 *     Note this gate does **not** verify authentication: having a principal
 *     at all is what authentication produced, and the route's
 *     `auth: "required" | "optional" | "none"` flag stays authoritative for it.
 *  3. otherwise every element of `needed` must be present, by exact string
 *     equality (see `scopes.ts` — no prefix rule, no wildcard within a scope).
 *
 * **SUPER_ADMIN does not bypass this.** A platform admin who authorized a
 * narrow third-party client did not thereby hand it the platform. The role
 * override lives on the capability axis and must not leak onto this one.
 *
 * The permissive default is written here, once, and visibly: an absent
 * `scopes` means the context predates the field, which can only be a
 * first-party session. Any path that can mint a *non*-first-party principal
 * must set `scopes` on every branch — an unset value on such a path reads as
 * full access.
 */
export function requireScope(
  ctx: ScopedPrincipal,
  needed: readonly string[],
): void {
  const granted: ScopeSet = ctx.scopes ?? "*";
  if (hasScope(granted, needed)) return;
  // `hasScope` already returned false, so `granted` is a real set here — "*"
  // and an empty `needed` both pass. Report every absent scope, not just the
  // first, so one round trip tells the client the whole story.
  const held = granted as ReadonlySet<string>;
  throw new InsufficientScopeError(needed.filter((scope) => !held.has(scope)));
}

/**
 * Thrown by {@link requireFirstParty}. 403 for the same reason
 * {@link InsufficientScopeError} is: the caller authenticated and is simply
 * not permitted.
 *
 * Deliberately NOT an `InsufficientScopeError` with an empty `missing` list.
 * That error's contract is "ask for these scopes and come back", and its
 * remediation says so. Here there is no scope to ask for: the route is not
 * exposed to third-party clients at all, and telling a client to request a
 * grant that cannot exist sends it round a loop it can never finish.
 */
export class ThirdPartyNotPermittedError extends Error {
  readonly status = 403 as const;
  readonly body: StructuredError;

  constructor() {
    super("First-party only: this route is not available to third-party clients");
    this.name = "ThirdPartyNotPermittedError";
    this.body = {
      error: "FIRST_PARTY_ONLY",
      message:
        "This operation is available only to the user's own session, not to a third-party client acting on their behalf.",
      remediation:
        "There is no scope that grants this. If your integration needs this capability, it has to be exposed as a scoped route first.",
    };
  }

  /** Render the 403. Pass `securityHeaders` at a route boundary. */
  toResponse(securityHeaders?: SecurityHeaders): Response {
    return structuredError(this.status, this.body, securityHeaders);
  }
}

/**
 * The other half of the scope gate: a route that declares NO scopes is
 * first-party only, and this is where that is enforced.
 *
 * The published contract (`ExtensionRouteDefinition.scopes`) is three-valued —
 * absent means "first-party only; no third-party client reaches it", `[]` means
 * "any authenticated principal", non-empty means "every listed scope". Only the
 * last two ran through {@link requireScope}; absent fell through every gate,
 * because a missing declaration reads as "nothing to check" unless something
 * says otherwise. This says otherwise.
 *
 * The rule is written against `clientId`, not against `scopes`. An absent
 * `scopes` is the *first-party* default (see {@link requireScope}), so testing
 * it here would refuse exactly the caller the route is for. `clientId` is
 * populated only when a third-party client is acting on the user's behalf,
 * which is precisely the caller the contract excludes.
 *
 * Unreachable today: every `getSession` path stamps `scopes: "*"` and nothing
 * populates `clientId`, so no third-party principal exists yet. It is written
 * now because the gate has to be in place BEFORE the first narrowed principal
 * is minted — on the day that lands, every scope-less extension route would
 * otherwise open to any client at once, silently.
 * (Quality sweep 2026-09-05, C3.)
 */
export function requireFirstParty(ctx: ScopedPrincipal): void {
  if (ctx.clientId === undefined) return;
  throw new ThirdPartyNotPermittedError();
}
