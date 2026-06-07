/**
 * Cognito PostConfirmation trigger.
 *
 * Fires once per user-pool record after Cognito accepts a sign-up
 * (`PostConfirmation_ConfirmSignUp`) or a forgotten-password confirmation
 * (`PostConfirmation_ConfirmForgotPassword`). For federated identities the
 * same trigger source is `PostConfirmation_ConfirmSignUp`; the
 * `request.userAttributes.identities` JSON string is the disambiguator.
 *
 * Responsibilities (atomic, single Prisma transaction):
 *  1. Upsert the `User` row (link `cognitoSub` to an existing email match,
 *     otherwise create with a derived handle).
 *  2. Ensure a personal `Tenant` of `type=PERSONAL` exists for the user,
 *     plus a `TenantMember` with `role=OWNER`.
 *  3. For federated users: exact-match the email domain against
 *     `tenant_domains` (verified only). If the domain belongs to a tenant
 *     with an `ACTIVE` IdP, resolve the user's role from `TenantRoleMapping`
 *     (against the `custom:idpGroups` attribute) and create / refresh a
 *     `TenantMember` row with `isJitProvisioned=true`.
 *  4. Preserve the existing `ageTier` + parental-link logic from the v0.6
 *     stub (B2C requirement).
 *
 * Idempotency: every write is an upsert. Cognito retries up to 3 times.
 *
 * Cross-tenant isolation: domain lookup is exact-match-only. No substring,
 * no wildcard. See sec finding #8 in
 * plans/mvp/10-trellis-stages/02-cognito-triggers.md.
 *
 * No PII (email body, group claim contents, raw IdP attributes) is logged.
 */

import type {
  PostConfirmationTriggerEvent,
  PostConfirmationTriggerHandler,
} from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { getLambdaPrisma as getPrisma } from "../lib/lambda-prisma.js";
import {
  PrismaClient,
  Prisma,
  type AgeTier,
  type TenantRole,
  type UserRole,
} from "@prisma/client";
import { ClaimsCache, createClaimsCacheFromEnv, type CachedClaims } from "../lib/auth/claims-cache.js";
import { deriveEmailDomain } from "../lib/tenant/derive-domain.js";
import { resolveTenantRole, type RoleMappingInput } from "../lib/tenant/resolve-role.js";
import { deriveHandle } from "../lib/user/derive-handle.js";
import { computeAnonymousId } from "../lib/pseudonym.js";
import {
  emitSignupSecurityEvent,
  signupUserData,
} from "../lib/signup-metadata.js";
import type { SignupMethod } from "@prisma/client";

const logger = new Logger({ serviceName: "post-confirmation" });
let cache: ClaimsCache | null = null;

function getCache(): ClaimsCache {
  if (!cache) cache = createClaimsCacheFromEnv();
  return cache;
}

function computeAgeTier(dateOfBirth: Date): AgeTier {
  const now = new Date();
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())) {
    age--;
  }
  if (age < 13) return "CHILD";
  if (age < 18) return "TEEN";
  return "ADULT";
}

function isFederatedEvent(event: PostConfirmationTriggerEvent): boolean {
  const identitiesRaw = event.request.userAttributes["identities"];
  if (!identitiesRaw) return false;
  try {
    const parsed = JSON.parse(identitiesRaw);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    // Malformed `identities` is not a federation signal we can act on. Return
    // false rather than over-classifying as federated, which would set
    // role=B2B_PARTNER and run the org-tenant resolution path. (G2 M2)
    return false;
  }
}

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

function parseIdpGroups(raw: string | undefined | null): string[] {
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

interface ProvisioningResult {
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

const SUPPORTED_TRIGGERS = new Set([
  "PostConfirmation_ConfirmSignUp",
  "PostConfirmation_ConfirmForgotPassword",
]);

export const handler: PostConfirmationTriggerHandler = async (event) => {
  if (!SUPPORTED_TRIGGERS.has(event.triggerSource)) return event;

  const attrs = event.request.userAttributes;
  // Identify the user by the immutable Cognito `sub` (the value carried in the
  // issued ID/access tokens), NOT `event.userName`. `userName` is not stable
  // across trigger contexts — PostConfirmation sees the sign-up username while
  // PreTokenGeneration on alias (email) sign-in receives the `sub` — so keying
  // the User row and the claims cache on it silently breaks the cache lookup
  // (the claim is written under one key and read under another → 401s).
  const cognitoSub = attrs.sub;
  const email = attrs.email?.toLowerCase();
  if (!email) {
    logger.warn("postconfirm.no_email", { cognitoSub });
    return event;
  }

  const federated = isFederatedEvent(event);
  const idpGroups = parseIdpGroups(attrs["custom:idpGroups"]);
  const dobStr = attrs["custom:dateOfBirth"];

  let dateOfBirth: Date | undefined;
  let ageTier: AgeTier = "ADULT";
  if (dobStr) {
    const parsed = new Date(dobStr);
    if (!isNaN(parsed.getTime()) && parsed < new Date()) {
      dateOfBirth = parsed;
      ageTier = computeAgeTier(parsed);
    }
  }

  // Signup-metadata (P3): how the account was created. An explicit
  // `signupMethod` hint in clientMetadata wins (e.g. a passwordless/MAGIC_LINK
  // signup labels itself); otherwise an invitation code present at signup means
  // INVITE, and the default is COGNITO. The invitation FK is resolved inside the
  // transaction below (only when a matching Prisma Invitation exists).
  const invitationCode =
    event.request.clientMetadata?.invitationCode?.trim() || undefined;
  const requestedMethod = parseSignupMethodHint(
    event.request.clientMetadata?.signupMethod,
  );

  const db = await getPrisma();

  const result = await withHandleConflictRetry(() =>
    db.$transaction(
      async (tx) => provisionUserAndTenancy(tx, {
        cognitoSub,
        email,
        emailVerified: attrs.email_verified,
        federated,
        idpGroups,
        dateOfBirth,
        ageTier,
        providedHandle: attrs["custom:handle"],
        invitationCode,
        requestedMethod,
      }),
      { timeout: 8000 },
    ),
  );

  if (ageTier === "CHILD") {
    const guardianEmail = attrs["custom:guardianEmail"]?.toLowerCase();
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
  // provisioning transaction so a KMS hiccup can never roll back account
  // creation. No backfill: only set when currently null (idempotent on Cognito
  // retries). If no KMS HMAC key is configured, computeAnonymousId throws and
  // we skip — never an unkeyed fallback. See lib/PSEUDONYM.md.
  await populateAnonymousId(db, result.userId);

  await primeClaimsCache(cognitoSub, result);

  // Signup-metadata SecurityEvent (P3). Emitted AFTER the provisioning
  // transaction commits so a telemetry hiccup can never roll back account
  // creation; the helper itself also fails open. Cognito's PostConfirmation
  // event exposes no client source IP/UA (callerContext carries only
  // awsSdkVersion + clientId), so this records method + invitation + tenant
  // only — no fabricated client signals. Retention is config-driven.
  await emitSignupSecurityEvent({
    db,
    userId: result.userId,
    method: result.signupMethod,
    invitationId: result.invitationId,
    tenantId: result.orgTenantId ?? result.personalTenantId,
    config: { SIGNUP_EVENT_RETENTION_DAYS: process.env.SIGNUP_EVENT_RETENTION_DAYS },
    logger: { warn: (...args) => console.warn(...args) },
  });

  logger.info("postconfirm.ok", {
    cognitoSub,
    userId: result.userId,
    personalTenantId: result.personalTenantId,
    orgTenantId: result.orgTenantId,
    federated,
  });

  return event;
};

interface ProvisioningInput {
  cognitoSub: string;
  email: string;
  emailVerified: string | undefined;
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

/**
 * S-CP2: the canonical ActivityPub actor URI for a user, derived from the
 * stable, unique `handle` — `{baseUrl}/users/{handle}`. Returns null when no
 * base domain is configured for this lambda; the actorUri column then stays
 * null and the AP dispatcher derives it on demand. No hard dependency on the
 * env var, so this is safe whether or not the deploy plumbs APP_DOMAIN in.
 */
function canonicalActorUri(handle: string): string | null {
  const raw = process.env.ACTIVITYPUB_BASE_URL || process.env.APP_DOMAIN;
  if (!raw) return null;
  try {
    // Accept both a full URL ("https://host") and a bare hostname ("host").
    const withProtocol = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
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

async function provisionUserAndTenancy(
  tx: Prisma.TransactionClient,
  input: ProvisioningInput,
): Promise<ProvisioningResult> {
  const {
    cognitoSub,
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
    where: { OR: [{ cognitoSub }, { email }] },
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
        cognitoSub,
        email,
        handle: initialHandle,
        // S-CP2: lock in the AP-actor-shaped URI from the stable handle at
        // creation (null when no base domain is configured for this lambda).
        actorUri: canonicalActorUri(initialHandle),
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
    if (!user.cognitoSub) updates.cognitoSub = cognitoSub;
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
      if (!user.actorUri) updates.actorUri = canonicalActorUri(backfilledHandle);
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
    // Defensive: only resolve org-tenant membership when Cognito asserts the
    // email is verified by the IdP. Native Cognito sign-ups always reach this
    // trigger with email_verified=true; for federated identities the value
    // depends on the IdP's attribute mapping. Without this check, an IdP
    // misconfigured to skip verification would let a user claim any
    // domain-bound tenant by self-asserting an email. Personal-tenant
    // creation above is unaffected — Cognito has already authenticated them.
    const emailVerified = input.emailVerified === "true";
    if (!emailVerified) {
      logger.warn("postconfirm.federated.email_unverified", { cognitoSub });
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
      logger.warn("postconfirm.federated.invalid_email", { cognitoSub });
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
        logger.warn("postconfirm.federated.no_domain_match", { cognitoSub });
      } else if (!tenantDomain.verifiedAt) {
        logger.warn("postconfirm.federated.unverified_domain", {
          cognitoSub,
          tenantId: tenantDomain.tenantId,
        });
      } else if (
        !tenantDomain.tenant.identityProvider ||
        tenantDomain.tenant.identityProvider.status !== "ACTIVE"
      ) {
        logger.warn("postconfirm.federated.inactive_idp", {
          cognitoSub,
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
            cognitoSub,
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
 * Cognito's up-to-3 retries). A KMS / config failure is logged and swallowed —
 * account provisioning has already committed and must not be undone by a
 * pseudonym hiccup. NEVER falls back to an unkeyed hash (computeAnonymousId
 * throws when no KMS HMAC key is configured).
 */
async function populateAnonymousId(db: PrismaClient, userId: string): Promise<void> {
  try {
    const existing = await db.user.findUnique({
      where: { id: userId },
      select: { anonymousId: true },
    });
    if (existing?.anonymousId) return; // no backfill / already set

    const anonymousId = await computeAnonymousId(userId, {
      PSEUDONYM_HMAC_KMS_KEY_ID: process.env.PSEUDONYM_HMAC_KMS_KEY_ID,
      AWS_REGION: process.env.AWS_REGION,
    });

    // Guard against the unique-collision race on concurrent retries.
    await db.user.update({
      where: { id: userId },
      data: { anonymousId },
    });
  } catch (err) {
    logger.warn("postconfirm.anonymous_id_skipped", {
      userId,
      reason: (err as { name?: string }).name ?? "unknown",
    });
  }
}

async function primeClaimsCache(cognitoSub: string, result: ProvisioningResult): Promise<void> {
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
    await getCache().put(cognitoSub, claims);
  } catch (err) {
    logger.warn("postconfirm.cache_prime_failed", {
      cognitoSub,
      error: (err as { code?: string }).code ?? "unknown",
    });
  }
}
