/**
 * Keycloak JIT claims resolution + first-contact provisioning (WS-0, plan 016).
 *
 * On Cognito, two Lambdas make authenticated requests work: PostConfirmation
 * provisions the User row + personal tenant, and PreTokenGeneration writes the
 * `custom:*` trellis claims into every token. On Keycloak neither hook exists:
 * a realm user's token verifies but carries no `custom:userId` /
 * `custom:activeTenantId` (nothing populates the realm attributes the protocol
 * mappers read), and a brand-new user has no User row or personal tenant at
 * all — so every request 401s.
 *
 * This module is the API-side replacement for both Lambdas. Auth-middleware
 * calls it ONLY when a verified token lacks the required claims, and it
 * no-ops (returns null) unless `IDENTITY_PROVIDER=keycloak` — the Cognito
 * path stays byte-identical (its tokens always carry the claims).
 *
 * Resolution order per sub:
 *   1. claims cache (primed by provisioning / prior resolutions; 1h TTL),
 *   2. DB derivation via the shared `loadClaimsFromDb` (user exists —
 *      suspended users resolve to null → 401, stricter than the Lambda's
 *      drift sentinel),
 *   3. JIT provisioning through the provider-neutral
 *      `provisionConfirmedUser` core (user's first contact).
 *
 * Input mapping for step 3 mirrors the Cognito PostConfirmation shell: realm
 * user attributes are fetched via the provider's admin `getUser` (duck-typed —
 * not part of `IdentityProviderPort`, which stays narrow per plan 016 WS-0
 * step 3) under the same literal `custom:*` names Cognito used. Keycloak
 * attributes are multi-valued; the first non-empty value wins.
 *
 * Concurrency: an in-process single-flight map collapses parallel requests
 * from the same new user; the cross-instance race lands on the DB's unique
 * constraints (User.email / User.subject → P2002) and is retried once — the
 * rerun finds the winner's committed row and takes the core's upsert path
 * ("every write is an upsert (providers retry)").
 *
 * Failure policy: fail closed. Any unexpected error resolves to null and the
 * request 401s; nothing here ever widens access beyond what the DB says.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import type { IdentityProviderPort } from "@de-otio/saas-foundation/identity";

import type { Env } from "../../env.js";
import {
  ClaimsCache,
  createClaimsCacheFromEnv,
  type CachedClaims,
} from "../auth/claims-cache.js";
import type { TrellisClaims } from "../auth/cognito-jwt.js";
import { getLogger } from "../logger.js";
import { computeAnonymousId } from "../pseudonym.js";
import { getIdentityProvider, resolveIdentityProviderKind } from "./identity-provider.js";
import { loadClaimsFromDb } from "./load-claims.js";
import {
  provisionConfirmedUser,
  type ConfirmedUserInput,
  type ProvisionDeps,
} from "./provision-confirmed-user.js";

/** The provider's optional admin surface this module duck-types onto. */
interface IdentityUserLookup {
  getUser?: (id: string) => Promise<{
    id: string;
    email: string;
    attributes?: Readonly<Record<string, ReadonlyArray<string>>>;
  } | null>;
}

interface JitOverrides {
  claimsCache?: ClaimsCache;
  db?: PrismaClient;
  identity?: IdentityProviderPort & IdentityUserLookup;
  provision?: typeof provisionConfirmedUser;
  loadClaims?: typeof loadClaimsFromDb;
}

let overrides: JitOverrides | null = null;
let cachedClaimsCache: ClaimsCache | null = null;
const inflight = new Map<string, Promise<CachedClaims | null>>();

/**
 * Test seam: inject any subset of the module's collaborators (pass null to
 * reset). Also clears the single-flight map so tests are isolated.
 */
export function __setJitClaimsOverridesForTest(o: JitOverrides | null): void {
  overrides = o;
  cachedClaimsCache = null;
  inflight.clear();
}

function getClaimsCache(): ClaimsCache {
  if (overrides?.claimsCache) return overrides.claimsCache;
  if (!cachedClaimsCache) cachedClaimsCache = createClaimsCacheFromEnv();
  return cachedClaimsCache;
}

async function getDb(env: Env): Promise<PrismaClient> {
  if (overrides?.db) return overrides.db;
  const { createPrisma } = await import("../../db.js");
  return createPrisma(env) as unknown as PrismaClient;
}

/**
 * Resolve trellis claims for a verified token that carries none, provisioning
 * the user on first contact. Returns null when the fallback does not apply
 * (non-Keycloak deployment) or cannot produce claims (→ the caller 401s).
 */
export async function resolveJitClaims(
  tokenClaims: TrellisClaims,
  env: Env,
): Promise<CachedClaims | null> {
  if (resolveIdentityProviderKind() !== "keycloak") return null;
  const sub = tokenClaims.sub;
  if (!sub) return null;

  // Single-flight: parallel requests from the same (new) user share one
  // resolution instead of racing the provisioning transaction in-process.
  const running = inflight.get(sub);
  if (running) return running;
  const p = resolveInner(tokenClaims, env).finally(() => inflight.delete(sub));
  inflight.set(sub, p);
  return p;
}

async function resolveInner(
  tokenClaims: TrellisClaims,
  env: Env,
): Promise<CachedClaims | null> {
  const logger = getLogger();
  const sub = tokenClaims.sub;
  const cache = getClaimsCache();

  try {
    try {
      const cached = await cache.get(sub);
      if (cached && cached.userId && cached.activeTenantId) return cached;
    } catch (err) {
      // A cache outage must not block auth — the DB path below is authoritative.
      logger.warn("jit.cache_read_failed", {
        sub,
        error: (err as { code?: string }).code ?? "unknown",
      });
    }

    const db = await getDb(env);
    let preferredTenantId: string | null = null;
    try {
      preferredTenantId = await cache.getActiveTenantPreference(sub);
    } catch {
      // Preference is an optimization; personal-tenant fallback is correct.
    }

    const loadClaims = overrides?.loadClaims ?? loadClaimsFromDb;
    const loaded = await loadClaims(db, sub, false, preferredTenantId);
    if (loaded.user) {
      // Stricter than the Lambda's drift sentinel: a suspended user gets no
      // claims at all (→ 401) instead of a sentinel token.
      if (loaded.user.suspended || loaded.user.suspendedAt !== null) {
        logger.warn("jit.suspended", { sub });
        return null;
      }
      if (loaded.activeMembership) {
        const derived: CachedClaims = {
          userId: loaded.user.id,
          globalRole: loaded.user.role,
          activeTenantId: loaded.activeMembership.tenantId,
          tenantSlug: loaded.activeMembership.tenant.slug,
          tenantRole: loaded.activeMembership.role,
          handle: loaded.user.handle ?? "",
        };
        try {
          await cache.put(sub, derived);
        } catch (err) {
          logger.warn("jit.cache_prime_failed", {
            sub,
            error: (err as { code?: string }).code ?? "unknown",
          });
        }
        return derived;
      }
      // User row exists but no ACTIVE membership (half-provisioned/drift):
      // fall through — provisionConfirmedUser is idempotent and heals the
      // missing personal tenant / OWNER membership via its upsert path.
    }

    return await provisionJit(tokenClaims, env, db, cache);
  } catch (err) {
    logger.error("jit.resolve_failed", {
      sub,
      error: (err as { code?: string; name?: string }).code ??
        (err as { name?: string }).name ??
        "unknown",
    });
    return null;
  }
}

/**
 * First non-empty value of a multi-valued Keycloak attribute, trying the
 * literal `custom:`-prefixed name first (the realm convention proven in G2 —
 * protocol mappers pass `custom:*` through unchanged) and the bare name as a
 * fallback.
 */
function attrValue(
  attributes: Readonly<Record<string, ReadonlyArray<string>>> | undefined,
  name: string,
): string | undefined {
  if (!attributes) return undefined;
  for (const key of [`custom:${name}`, name]) {
    const values = attributes[key];
    const first = values?.find((v) => typeof v === "string" && v.trim() !== "");
    if (first !== undefined) return first.trim();
  }
  return undefined;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

async function provisionJit(
  tokenClaims: TrellisClaims,
  env: Env,
  db: PrismaClient,
  cache: ClaimsCache,
): Promise<CachedClaims | null> {
  const logger = getLogger();
  const sub = tokenClaims.sub;

  // Realm user attributes (dateOfBirth, guardianEmail, …) are not in the
  // token; fetch them via the provider's admin surface when available. A
  // fetch failure degrades to token-only input — provisioning still succeeds,
  // the attributes just don't apply (fail-safe, not fail-closed: the user IS
  // authenticated, the attributes only refine the profile).
  let idpUser: Awaited<ReturnType<NonNullable<IdentityUserLookup["getUser"]>>> = null;
  try {
    const identity = (overrides?.identity ?? getIdentityProvider()) as IdentityProviderPort &
      IdentityUserLookup;
    if (typeof identity.getUser === "function") {
      idpUser = await identity.getUser(sub);
    }
  } catch (err) {
    logger.warn("jit.idp_user_fetch_failed", {
      sub,
      error: (err as { code?: string }).code ?? "unknown",
    });
  }

  const email = tokenClaims.email ?? (idpUser?.email || undefined);
  if (!email) {
    // Without an email the core skips provisioning anyway; make the reason
    // visible here (the token's scope or the realm's email mapper is off).
    logger.warn("jit.no_email", { sub });
    return null;
  }

  const attrs = idpUser?.attributes;
  const input: ConfirmedUserInput = {
    sub,
    email,
    emailVerified: tokenClaims.emailVerified ?? false,
    // Identity brokering (federated IdPs behind Keycloak) is out of scope for
    // WS-0 (plan 016 WS-2 step 4 records the decision) — org-tenant JIT via
    // domain matching stays Cognito-only until then.
    federated: false,
    idpGroupsRaw: attrValue(attrs, "idpGroups"),
    dateOfBirthRaw: attrValue(attrs, "dateOfBirth"),
    providedHandle: attrValue(attrs, "handle") ?? tokenClaims.handle,
    guardianEmail: attrValue(attrs, "guardianEmail"),
    invitationCode: attrValue(attrs, "invitationCode"),
    // On the Keycloak path the only end-user signup flow is the magic link;
    // an explicit realm attribute may still override.
    signupMethodHint: attrValue(attrs, "signupMethod") ?? "MAGIC_LINK",
  };

  const deps: ProvisionDeps = {
    db,
    logger: {
      info: (message, meta) => logger.info(message, meta),
      warn: (message, meta) => logger.warn(message, meta),
      error: (message, meta) => logger.error(message, meta),
    },
    claimsCache: cache,
    computeAnonymousId: (userId) =>
      computeAnonymousId(userId, {
        PSEUDONYM_HMAC_KMS_KEY_ID: process.env.PSEUDONYM_HMAC_KMS_KEY_ID,
        AWS_REGION: process.env.AWS_REGION,
        // Narrow to the typed union; any other value behaves as unset (the
        // same treatment configurePseudonymMacFromEnv applies at startup).
        PSEUDONYM_MAC_PROVIDER:
          process.env.PSEUDONYM_MAC_PROVIDER === "software" ? "software" : undefined,
      }),
    markInvitationRecordUsed: async (record) => {
      const { markPreSignUpInvitationRecordUsed } = await import(
        "../invitation-presignup-record.js"
      );
      await markPreSignUpInvitationRecordUsed(record);
    },
    actorBaseUrl: process.env.ACTIVITYPUB_BASE_URL || process.env.APP_DOMAIN,
    signupEventRetentionDays: process.env.SIGNUP_EVENT_RETENTION_DAYS,
  };

  const provision = overrides?.provision ?? provisionConfirmedUser;
  let result;
  try {
    result = await provision(input, deps);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Cross-instance first-request race: another instance committed the user
    // between our findFirst and create. The rerun finds that row and takes
    // the upsert path.
    logger.warn("jit.provision_race_retry", { sub });
    result = await provision(input, deps);
  }
  if (!result) return null;

  logger.info("jit.provisioned", {
    sub,
    userId: result.userId,
    personalTenantId: result.personalTenantId,
  });

  // Same shape primeClaimsCache already wrote to the cache.
  return {
    userId: result.userId,
    globalRole: result.globalRole,
    activeTenantId: result.orgTenantId ?? result.personalTenantId,
    tenantSlug: result.orgTenantSlug ?? result.personalTenantSlug,
    tenantRole: result.orgTenantRole ?? "OWNER",
    handle: result.handle,
  };
}
