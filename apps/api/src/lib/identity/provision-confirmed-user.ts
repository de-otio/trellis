/**
 * Post-confirmation JIT provisioning — provider-neutral core (WS-3.3
 * trigger-hook extraction, WS-2 worker pattern).
 *
 * The LOGIC of the Cognito PostConfirmation trigger, moved verbatim from
 * `lambda/post-confirmation.ts` (which is now a thin Cognito shell): user
 * upsert with sub linking, personal-tenant + OWNER membership, federated
 * org-tenant JIT provisioning against verified tenant domains, ageTier +
 * parental link, research-pseudonym population, claims-cache priming, and
 * the invitation-record burn. A Keycloak deployment reaches the same core
 * from its own post-registration hook with the identical input shape.
 *
 * WS-2 extraction rules hold: no aws-lambda / powertools imports, no
 * `process.env` reads — env-derived values (actor base URL, pseudonym key
 * config, signup-event retention) arrive through `deps`, resolved by the
 * entrypoint.
 *
 * Idempotency: every write is an upsert (providers retry). Cross-tenant
 * isolation: domain lookup is exact-match-only — no substring, no wildcard.
 * No PII (email body, group claim contents, raw IdP attributes) is logged.
 */

import {
  Prisma,
  type AgeTier,
  type PrismaClient,
  type SignupMethod,
  type TenantRole,
  type UserRole,
} from "@prisma/client";

import type { ClaimsCache, CachedClaims } from "../auth/claims-cache.js";
import {
  computeAgeTier as computeTier,
  isUnderMinimumAge,
  MINIMUM_SIGNUP_AGE_YEARS,
  MINOR_TIERS_SUPPORTED,
  InvalidDateOfBirthError,
  parseDateOfBirth,
  UnderMinimumAgeError,
} from "../age-gate.js";
import { deriveEmailDomain } from "../tenant/derive-domain.js";
import { resolveTenantRole, type RoleMappingInput } from "../tenant/resolve-role.js";
import { deriveHandle } from "../user/derive-handle.js";
import { emitSignupSecurityEvent, signupUserData } from "../signup-metadata.js";

/** The neutral logger surface the core needs. */
export interface ProvisionLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Provider-neutral view of a confirmed sign-up (built by the entrypoints). */
export interface ConfirmedUserInput {
  /** Provider subject — the value carried in issued tokens. Opaque. */
  sub: string;
  /** Raw email attribute; the core lowercases. Absent → provisioning skips. */
  email: string | undefined;
  /** Whether the PROVIDER asserts the email is verified (federated gate). */
  emailVerified: boolean;
  /** Whether this identity arrived via a federated IdP. */
  federated: boolean;
  /** Raw group claim (comma/semicolon-separated), if any. */
  idpGroupsRaw?: string | undefined;
  /** Raw date-of-birth attribute, if any. */
  dateOfBirthRaw?: string | undefined;
  /** Raw handle attribute, if any. */
  providedHandle?: string | undefined;
  /**
   * Raw guardian email attribute, if any (CHILD accounts).
   *
   * Accepted and IGNORED while `MINOR_TIERS_SUPPORTED` is false — the 18+
   * floor below means no CHILD account can be provisioned to link one to.
   */
  guardianEmail?: string | undefined;
  /** Raw invitation code presented at signup, if any. */
  invitationCode?: string | undefined;
  /** Raw signupMethod hint from the client metadata, if any. */
  signupMethodHint?: string | undefined;
}

export interface ProvisionDeps {
  db: PrismaClient;
  logger: ProvisionLogger;
  claimsCache: ClaimsCache;
  /**
   * Research-pseudonym computation (`lib/pseudonym.ts` bound to its env by
   * the entrypoint). MUST throw when unkeyed — the core never falls back.
   */
  computeAnonymousId: (userId: string) => Promise<string>;
  /** Burns the pre-signup invitation record (single-use gate). */
  markInvitationRecordUsed: (input: { code: string; usedBy: string }) => Promise<void>;
  /** Base URL/domain for the canonical ActivityPub actor URI (S-CP2). */
  actorBaseUrl?: string | undefined;
  /** Retention config for the signup SecurityEvent (P3). */
  signupEventRetentionDays?: string | undefined;
  /**
   * Guard around the provisioning transaction (the Lambda wraps its circuit
   * breaker here; the container may pass identity). Defaults to pass-through.
   */
  dbGuard?: <T>(fn: () => Promise<T>, label: string) => Promise<T>;
}

export interface ProvisioningResult {
  userId: string;
  globalRole: UserRole;
  handle: string;
  personalTenantId: string;
  personalTenantSlug: string;
  orgTenantId: string | null;
  orgTenantSlug: string | null;
  orgTenantRole: TenantRole | null;
  // Signup-metadata (P3): how this account was created and which invitation it
  // redeemed. Populated only for freshly created users (existing users keep
  // their NULL legacy state — no backfill).
  signupMethod: SignupMethod;
  invitationId: string | null;
}

// The third copy of `computeAgeTier` used to live here. One implementation now
// serves provisioning, the nightly transition job and the parental paths.
export { computeAgeTier } from "../age-gate.js";

/**
 * Parse an explicit `signupMethod` hint from clientMetadata, if present and
 * valid. Returns undefined for anything we don't recognize (the caller then
 * derives the method from the invitation code / defaults to COGNITO).
 */
function parseSignupMethodHint(
  raw: string | undefined | null,
): SignupMethod | undefined {
  switch (raw) {
    case "COGNITO":
    case "INVITE":
    case "MAGIC_LINK":
      return raw;
    default:
      return undefined;
  }
}

export function parseIdpGroups(raw: string | undefined | null): string[] {
  if (!raw) return [];
  // Split on `,` and `;` only — IdPs (notably Okta in displayName mode) may
  // emit group names containing whitespace. Cognito's custom-attribute
  // serialization is comma-separated; we accept semicolon as a defensive
  // fallback. (G2 L1)
  return raw
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * S-CP2: the canonical ActivityPub actor URI for a user, derived from the
 * stable, unique `handle` — `{baseUrl}/users/{handle}`. Returns null when no
 * base domain is configured; the actorUri column then stays null and the AP
 * dispatcher derives it on demand.
 */
function canonicalActorUri(handle: string, actorBaseUrl: string | undefined): string | null {
  if (!actorBaseUrl) return null;
  try {
    // Accept both a full URL ("https://host") and a bare hostname ("host").
    const withProtocol = /^https?:\/\//.test(actorBaseUrl) ? actorBaseUrl : `https://${actorBaseUrl}`;
    const url = new URL(withProtocol);
    return `${url.protocol}//${url.hostname}/users/${encodeURIComponent(handle)}`;
  } catch {
    return null;
  }
}

/**
 * S-CP2: retry the provisioning transaction when two concurrent signups race to
 * the same derived handle. `handle` is DB-unique, so the loser of the race gets
 * a P2002; re-running the transaction re-derives the handle (now seeing the
 * committed conflict) and picks the next suffix. The transaction rolls back
 * fully on failure, so retries have no partial-write side effects.
 */
async function withHandleConflictRetry<T>(
  logger: ProvisionLogger,
  fn: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isHandleConflict =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" &&
        String(
          (err.meta as { target?: unknown } | undefined)?.target ?? "",
        ).includes("handle");
      if (isHandleConflict && attempt < maxAttempts) {
        logger.warn("Handle collision during provisioning; retrying", {
          attempt,
        });
        continue;
      }
      throw err;
    }
  }
}

/**
 * Provision a confirmed user end to end. Returns the provisioning result, or
 * null when the input carries no email (logged, skipped — provider parity).
 */
export async function provisionConfirmedUser(
  input: ConfirmedUserInput,
  deps: ProvisionDeps,
): Promise<ProvisioningResult | null> {
  const { db, logger } = deps;
  const sub = input.sub;
  const email = input.email?.toLowerCase();
  if (!email) {
    logger.warn("postconfirm.no_email", { sub });
    return null;
  }

  const federated = input.federated;
  const idpGroups = parseIdpGroups(input.idpGroupsRaw);

  // ── Minimum-age floor (defence in depth) ──────────────────────────────────
  //
  // The consuming client refuses an under-18 date of birth at signup. That
  // check is a UX affordance sitting on the far side of an HTTP boundary, and
  // this function is reachable from a Cognito PostConfirmation trigger and
  // from Keycloak JIT sign-in — neither of which the client mediates. So the
  // floor is re-applied here, at the last point before the row is written.
  //
  // Throwing (rather than silently downgrading to ADULT, or provisioning a
  // minor) is the fail-closed choice: on the Cognito path the trigger fails
  // and the sign-up does not complete; on the JIT path `jit-claims.ts` logs
  // and yields no claims, which surfaces as a 401. An account that should not
  // exist is never created either way.
  //
  // A SUPPLIED date of birth that cannot be read fails closed too (quality
  // sweep 2026-09-05, B1). The inline parse here used to accept anything
  // `new Date()` accepted and require only `parsed < now`; a malformed or
  // future value failed the `if` and fell straight through, leaving the
  // account at the `ADULT` default with no date of birth stored, no log line
  // and no re-check. That is an age tier assigned by accident from an input
  // the caller got wrong — the exact opposite of the paragraph above, on the
  // two paths (Cognito trigger, Keycloak JIT) that the strict parser at
  // `/auth/register` never sees. A value we cannot read is not evidence of
  // adulthood.
  //
  // `parseDateOfBirth` is now the single implementation (age-gate.ts), so
  // these paths also inherit its round-trip guard (`2025-02-31`) and its
  // implausible-year guard (`0202`).
  const now = new Date();
  let dateOfBirth: Date | undefined;
  let ageTier: AgeTier = "ADULT";
  if (input.dateOfBirthRaw) {
    const parsed = parseDateOfBirth(input.dateOfBirthRaw, now);
    if (!parsed) {
      // No date of birth in the log line — the reason is enough, and the value
      // is the most sensitive field on the input.
      logger.warn("postconfirm.invalid_date_of_birth", { sub });
      throw new InvalidDateOfBirthError();
    }
    if (isUnderMinimumAge(parsed, now)) {
      logger.warn("postconfirm.under_minimum_age", {
        sub,
        minimumAgeYears: MINIMUM_SIGNUP_AGE_YEARS,
      });
      throw new UnderMinimumAgeError();
    }
    dateOfBirth = parsed;
    ageTier = computeTier(parsed, now);
  }

  // Signup-metadata (P3): how the account was created. An explicit
  // `signupMethod` hint wins (e.g. a passwordless/MAGIC_LINK signup labels
  // itself); otherwise an invitation code present at signup means INVITE, and
  // the default is COGNITO. The invitation FK is resolved inside the
  // transaction below (only when a matching Prisma Invitation exists).
  const invitationCode = input.invitationCode?.trim() || undefined;
  const requestedMethod = parseSignupMethodHint(input.signupMethodHint);

  // The provisioning transaction is the longest-held connection in a signup
  // burst (multi-statement, up to the 8s timeout). The entrypoint's dbGuard
  // (Lambda circuit breaker) wraps it so a saturated DB trips fast-fail.
  const dbGuard = deps.dbGuard ?? (<T>(fn: () => Promise<T>): Promise<T> => fn());
  const result = await dbGuard(
    () =>
      withHandleConflictRetry(logger, () =>
        db.$transaction(
          async (tx) => provisionUserAndTenancy(tx, logger, deps.actorBaseUrl, {
            sub,
            email,
            emailVerified: input.emailVerified,
            federated,
            idpGroups,
            dateOfBirth,
            ageTier,
            providedHandle: input.providedHandle,
            invitationCode,
            requestedMethod,
          }),
          { timeout: 8000 },
        ),
      ),
    "post_confirmation.provision",
  );

  // Guardian linking is minor-only machinery. The floor above already makes
  // `ageTier === "CHILD"` unreachable; the explicit MINOR_TIERS_SUPPORTED
  // guard states WHY rather than leaving a branch that looks live and never
  // runs. `input.guardianEmail` is accepted and ignored while this is false.
  if (MINOR_TIERS_SUPPORTED && ageTier === "CHILD") {
    const guardianEmail = input.guardianEmail?.toLowerCase();
    if (guardianEmail) {
      const guardian = await db.user.findUnique({ where: { email: guardianEmail } });
      if (guardian) {
        await db.parentalLink.upsert({
          where: { childId_guardianId: { childId: result.userId, guardianId: guardian.id } },
          create: { childId: result.userId, guardianId: guardian.id, status: "PENDING" },
          update: {},
        });
      }
    }
  }

  // Populate the research pseudonym (best-effort, fail-safe). Done AFTER the
  // provisioning transaction so a key-service hiccup can never roll back
  // account creation. No backfill: only set when currently null (idempotent on
  // provider retries). If no HMAC key is configured, computeAnonymousId throws
  // and we skip — never an unkeyed fallback. See lib/PSEUDONYM.md.
  await populateAnonymousId(deps, result.userId);

  await primeClaimsCache(deps, sub, result);

  // AUTH GATE: burn the PreSignUp invitation record so the code cannot be
  // redeemed a second time — the pre-signup gate rejects `used` items, and it
  // reads ONLY that record (never Prisma). Best-effort AFTER the provisioning
  // transaction: the account is already committed and a store hiccup must
  // never roll it back (same doctrine as the pseudonym / security-event steps
  // above). This still fails closed on a lost marker — the gate rejects a
  // missing item too, and the record carries a TTL. A persistent failure is
  // logged loudly (ops-visible) rather than swallowed.
  if (invitationCode) {
    try {
      await deps.markInvitationRecordUsed({
        code: invitationCode,
        usedBy: result.userId,
      });
    } catch (err) {
      logger.error("postconfirm.invitation_record_mark_used_failed", {
        sub,
        reason: (err as { name?: string }).name ?? "unknown",
      });
    }
  }

  // Signup-metadata SecurityEvent (P3). Emitted AFTER the provisioning
  // transaction commits so a telemetry hiccup can never roll back account
  // creation; the helper itself also fails open. Provider confirmation events
  // expose no client source IP/UA, so this records method + invitation +
  // tenant only — no fabricated client signals. Retention is config-driven.
  await emitSignupSecurityEvent({
    db,
    userId: result.userId,
    method: result.signupMethod,
    invitationId: result.invitationId,
    tenantId: result.orgTenantId ?? result.personalTenantId,
    config: { SIGNUP_EVENT_RETENTION_DAYS: deps.signupEventRetentionDays },
    logger: { warn: (...args) => console.warn(...args) },
  });

  logger.info("postconfirm.ok", {
    sub,
    userId: result.userId,
    personalTenantId: result.personalTenantId,
    orgTenantId: result.orgTenantId,
    federated,
  });

  return result;
}

interface ProvisioningInput {
  sub: string;
  email: string;
  emailVerified: boolean;
  federated: boolean;
  idpGroups: string[];
  dateOfBirth: Date | undefined;
  ageTier: AgeTier;
  providedHandle: string | undefined;
  /** Invitation code presented at signup (clientMetadata), if any. */
  invitationCode: string | undefined;
  /** Explicit signupMethod hint from clientMetadata, if recognized. */
  requestedMethod: SignupMethod | undefined;
}

async function provisionUserAndTenancy(
  tx: Prisma.TransactionClient,
  logger: ProvisionLogger,
  actorBaseUrl: string | undefined,
  input: ProvisioningInput,
): Promise<ProvisioningResult> {
  const {
    sub,
    email,
    federated,
    idpGroups,
    dateOfBirth,
    ageTier,
    providedHandle,
    invitationCode,
    requestedMethod,
  } = input;

  const existing = await tx.user.findFirst({
    where: { OR: [{ subject: sub }, { email }] },
  });

  // Signup-metadata (P3): resolve the redeemed Prisma Invitation (if the code
  // presented at signup matches one) so we can set the FK. Codes are stored
  // upper-cased on the Invitation model. A code that doesn't resolve to a
  // Prisma invitation simply yields no FK (still a valid signup).
  let redeemedInvitationId: string | null = null;
  if (invitationCode) {
    const inv = await tx.invitation.findUnique({
      where: { code: invitationCode.toUpperCase() },
      select: { id: true },
    });
    redeemedInvitationId = inv?.id ?? null;
  }
  // Method precedence: explicit hint > resolved invitation FK > COGNITO default.
  const signupMethod: SignupMethod =
    requestedMethod ?? (redeemedInvitationId ? "INVITE" : "COGNITO");
  // Choke point: the only place User signup-metadata is assembled.
  const signupFields = signupUserData({
    method: signupMethod,
    invitationId: redeemedInvitationId,
  });

  let user = existing;
  if (!user) {
    const initialHandle =
      (providedHandle && providedHandle.trim()) ||
      (await deriveHandle(email, async (h) => {
        const found = await tx.user.findFirst({ where: { handle: h }, select: { id: true } });
        return !!found;
      }));
    user = await tx.user.create({
      data: {
        subject: sub,
        email,
        handle: initialHandle,
        // S-CP2: lock in the AP-actor-shaped URI from the stable handle at
        // creation (null when no base domain is configured).
        actorUri: canonicalActorUri(initialHandle, actorBaseUrl),
        role: federated ? "B2B_PARTNER" : "END_USER",
        // Fail-CLOSED research age signal: a new account is NOT age-verified
        // until an explicit verification flow sets it. Distinct from `ageTier`
        // (which fails open at ADULT). See prisma User.ageVerified doc + PSEUDONYM.md.
        ageVerified: false,
        // Signup-metadata (P3): how the account was created + redeemed
        // invitation FK. Client signals (IP/UA) go to SecurityEvent, never here.
        signupMethod: signupFields.signupMethod,
        invitationId: signupFields.invitationId,
        ...(dateOfBirth && { dateOfBirth, ageTier }),
      },
    });
  } else {
    const updates: Prisma.UserUpdateInput = {};
    if (!user.subject) updates.subject = sub;
    if (!user.handle) {
      const backfilledHandle = await deriveHandle(email, async (h) => {
        const found = await tx.user.findFirst({
          where: { handle: h, NOT: { id: user!.id } },
          select: { id: true },
        });
        return !!found;
      });
      updates.handle = backfilledHandle;
      // S-CP2: derive the AP actor URI from the handle we just assigned.
      if (!user.actorUri) updates.actorUri = canonicalActorUri(backfilledHandle, actorBaseUrl);
    }
    if (Object.keys(updates).length > 0) {
      user = await tx.user.update({ where: { id: user.id }, data: updates });
    }
  }

  let personalTenantId = user.personalTenantId;
  let personalTenantSlug = "";
  if (!personalTenantId) {
    const personalSlug = `personal-${user.id}`;
    const personalTenant = await tx.tenant.create({
      data: {
        slug: personalSlug,
        displayName: user.handle ?? "personal",
        type: "PERSONAL",
        personalOwnerUserId: user.id,
      },
    });
    personalTenantId = personalTenant.id;
    personalTenantSlug = personalTenant.slug;
    await tx.tenantMember.upsert({
      where: { tenantId_userId: { tenantId: personalTenant.id, userId: user.id } },
      create: {
        tenantId: personalTenant.id,
        userId: user.id,
        role: "OWNER",
        status: "ACTIVE",
        joinedAt: new Date(),
      },
      update: { status: "ACTIVE" },
    });
    await tx.user.update({
      where: { id: user.id },
      data: { personalTenantId: personalTenant.id },
    });
  } else {
    const personal = await tx.tenant.findUnique({
      where: { id: personalTenantId },
      select: { slug: true },
    });
    personalTenantSlug = personal?.slug ?? "";
    await tx.tenantMember.upsert({
      where: { tenantId_userId: { tenantId: personalTenantId, userId: user.id } },
      create: {
        tenantId: personalTenantId,
        userId: user.id,
        role: "OWNER",
        status: "ACTIVE",
        joinedAt: new Date(),
      },
      update: {},
    });
  }

  let orgTenantId: string | null = null;
  let orgTenantSlug: string | null = null;
  let orgTenantRole: TenantRole | null = null;
  if (federated) {
    // Defensive: only resolve org-tenant membership when the provider asserts
    // the email is verified by the IdP. Native sign-ups always reach this hook
    // with a verified email; for federated identities the value depends on the
    // IdP's attribute mapping. Without this check, an IdP misconfigured to
    // skip verification would let a user claim any domain-bound tenant by
    // self-asserting an email. Personal-tenant creation above is unaffected —
    // the provider has already authenticated them.
    if (!input.emailVerified) {
      logger.warn("postconfirm.federated.email_unverified", { sub });
      return {
        userId: user.id,
        globalRole: user.role,
        handle: user.handle ?? "",
        personalTenantId: personalTenantId!,
        personalTenantSlug,
        orgTenantId: null,
        orgTenantSlug: null,
        orgTenantRole: null,
        signupMethod,
        invitationId: redeemedInvitationId,
      };
    }
    const domain = deriveEmailDomain(email);
    if (!domain) {
      logger.warn("postconfirm.federated.invalid_email", { sub });
    } else {
      const tenantDomain = await tx.tenantDomain.findUnique({
        where: { domain },
        include: {
          tenant: {
            include: {
              identityProvider: {
                select: { status: true, defaultRole: true },
              },
              roleMappings: {
                select: { idpGroupName: true, tenantRole: true, priority: true },
              },
            },
          },
        },
      });

      if (!tenantDomain) {
        logger.warn("postconfirm.federated.no_domain_match", { sub });
      } else if (!tenantDomain.verifiedAt) {
        logger.warn("postconfirm.federated.unverified_domain", {
          sub,
          tenantId: tenantDomain.tenantId,
        });
      } else if (
        !tenantDomain.tenant.identityProvider ||
        tenantDomain.tenant.identityProvider.status !== "ACTIVE"
      ) {
        logger.warn("postconfirm.federated.inactive_idp", {
          sub,
          tenantId: tenantDomain.tenantId,
        });
      } else {
        const role = resolveTenantRole(
          idpGroups,
          tenantDomain.tenant.roleMappings as RoleMappingInput[],
          tenantDomain.tenant.identityProvider.defaultRole,
        );
        if (!role) {
          logger.warn("postconfirm.federated.no_role", {
            sub,
            tenantId: tenantDomain.tenantId,
          });
        } else {
          await tx.tenantMember.upsert({
            where: {
              tenantId_userId: { tenantId: tenantDomain.tenantId, userId: user.id },
            },
            create: {
              tenantId: tenantDomain.tenantId,
              userId: user.id,
              role,
              status: "ACTIVE",
              joinedAt: new Date(),
              isJitProvisioned: true,
            },
            update: {
              role,
              status: "ACTIVE",
              lastActiveAt: new Date(),
            },
          });
          orgTenantId = tenantDomain.tenantId;
          orgTenantSlug = tenantDomain.tenant.slug;
          orgTenantRole = role;
        }
      }
    }
  }

  return {
    userId: user.id,
    globalRole: user.role,
    handle: user.handle ?? "",
    personalTenantId: personalTenantId!,
    personalTenantSlug,
    orgTenantId,
    orgTenantSlug,
    orgTenantRole,
    signupMethod,
    invitationId: redeemedInvitationId,
  };
}

/**
 * Best-effort, fail-safe population of `User.anonymousId` (the research
 * pseudonym). Only sets it when currently null (no backfill, idempotent on
 * provider retries). A key-service / config failure is logged and swallowed —
 * account provisioning has already committed and must not be undone by a
 * pseudonym hiccup. NEVER falls back to an unkeyed hash (computeAnonymousId
 * throws when no HMAC key is configured).
 */
async function populateAnonymousId(deps: ProvisionDeps, userId: string): Promise<void> {
  try {
    const existing = await deps.db.user.findUnique({
      where: { id: userId },
      select: { anonymousId: true },
    });
    if (existing?.anonymousId) return; // no backfill / already set

    const anonymousId = await deps.computeAnonymousId(userId);

    // Guard against the unique-collision race on concurrent retries.
    await deps.db.user.update({
      where: { id: userId },
      data: { anonymousId },
    });
  } catch (err) {
    deps.logger.warn("postconfirm.anonymous_id_skipped", {
      userId,
      reason: (err as { name?: string }).name ?? "unknown",
    });
  }
}

async function primeClaimsCache(
  deps: ProvisionDeps,
  sub: string,
  result: ProvisioningResult,
): Promise<void> {
  const activeTenantId = result.orgTenantId ?? result.personalTenantId;
  const activeTenantSlug = result.orgTenantSlug ?? result.personalTenantSlug;
  const activeTenantRole = result.orgTenantRole ?? "OWNER";
  const claims: CachedClaims = {
    userId: result.userId,
    globalRole: result.globalRole,
    activeTenantId,
    tenantSlug: activeTenantSlug,
    tenantRole: activeTenantRole,
    handle: result.handle,
  };
  try {
    await deps.claimsCache.put(sub, claims);
  } catch (err) {
    deps.logger.warn("postconfirm.cache_prime_failed", {
      sub,
      error: (err as { code?: string }).code ?? "unknown",
    });
  }
}
