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
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import {
  PrismaClient,
  type AgeTier,
  type Prisma,
  type TenantRole,
  type UserRole,
} from "@prisma/client";
import { ClaimsCache, createClaimsCacheFromEnv, type CachedClaims } from "../lib/auth/claims-cache.js";
import { deriveEmailDomain } from "../lib/tenant/derive-domain.js";
import { resolveTenantRole, type RoleMappingInput } from "../lib/tenant/resolve-role.js";
import { deriveHandle } from "../lib/user/derive-handle.js";

const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });
let prisma: PrismaClient | null = null;
let cache: ClaimsCache | null = null;

async function getPrisma(): Promise<PrismaClient> {
  if (prisma) return prisma;
  const secret = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN! }),
  );
  const { username, password, host, port, dbname } = JSON.parse(secret.SecretString!);
  prisma = new PrismaClient({
    datasources: {
      db: {
        url: `postgresql://${username}:${encodeURIComponent(password)}@${host}:${port}/${dbname}?connection_limit=1`,
      },
    },
  });
  return prisma;
}

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
}

const SUPPORTED_TRIGGERS = new Set([
  "PostConfirmation_ConfirmSignUp",
  "PostConfirmation_ConfirmForgotPassword",
]);

export const handler: PostConfirmationTriggerHandler = async (event) => {
  if (!SUPPORTED_TRIGGERS.has(event.triggerSource)) return event;

  const cognitoSub = event.userName;
  const attrs = event.request.userAttributes;
  const email = attrs.email?.toLowerCase();
  if (!email) {
    console.warn(JSON.stringify({ event: "postconfirm.no_email", cognitoSub }));
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

  const db = await getPrisma();

  const result = await db.$transaction(
    async (tx) => provisionUserAndTenancy(tx, {
      cognitoSub,
      email,
      emailVerified: attrs.email_verified,
      federated,
      idpGroups,
      dateOfBirth,
      ageTier,
      providedHandle: attrs["custom:handle"],
    }),
    { timeout: 8000 },
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

  await primeClaimsCache(cognitoSub, result);

  console.log(
    JSON.stringify({
      event: "postconfirm.ok",
      cognitoSub,
      userId: result.userId,
      personalTenantId: result.personalTenantId,
      orgTenantId: result.orgTenantId,
      federated,
    }),
  );

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
  } = input;

  const existing = await tx.user.findFirst({
    where: { OR: [{ cognitoSub }, { email }] },
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
        role: federated ? "B2B_PARTNER" : "END_USER",
        ...(dateOfBirth && { dateOfBirth, ageTier }),
      },
    });
  } else {
    const updates: Prisma.UserUpdateInput = {};
    if (!user.cognitoSub) updates.cognitoSub = cognitoSub;
    if (!user.handle) {
      updates.handle = await deriveHandle(email, async (h) => {
        const found = await tx.user.findFirst({
          where: { handle: h, NOT: { id: user!.id } },
          select: { id: true },
        });
        return !!found;
      });
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
      console.warn(
        JSON.stringify({ event: "postconfirm.federated.email_unverified", cognitoSub }),
      );
      return {
        userId: user.id,
        globalRole: user.role,
        handle: user.handle ?? "",
        personalTenantId: personalTenantId!,
        personalTenantSlug,
        orgTenantId: null,
        orgTenantSlug: null,
        orgTenantRole: null,
      };
    }
    const domain = deriveEmailDomain(email);
    if (!domain) {
      console.warn(JSON.stringify({ event: "postconfirm.federated.invalid_email", cognitoSub }));
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
        console.warn(
          JSON.stringify({ event: "postconfirm.federated.no_domain_match", cognitoSub }),
        );
      } else if (!tenantDomain.verifiedAt) {
        console.warn(
          JSON.stringify({
            event: "postconfirm.federated.unverified_domain",
            cognitoSub,
            tenantId: tenantDomain.tenantId,
          }),
        );
      } else if (
        !tenantDomain.tenant.identityProvider ||
        tenantDomain.tenant.identityProvider.status !== "ACTIVE"
      ) {
        console.warn(
          JSON.stringify({
            event: "postconfirm.federated.inactive_idp",
            cognitoSub,
            tenantId: tenantDomain.tenantId,
          }),
        );
      } else {
        const role = resolveTenantRole(
          idpGroups,
          tenantDomain.tenant.roleMappings as RoleMappingInput[],
          tenantDomain.tenant.identityProvider.defaultRole,
        );
        if (!role) {
          console.warn(
            JSON.stringify({
              event: "postconfirm.federated.no_role",
              cognitoSub,
              tenantId: tenantDomain.tenantId,
            }),
          );
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
  };
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
    console.warn(
      JSON.stringify({
        event: "postconfirm.cache_prime_failed",
        cognitoSub,
        error: (err as { code?: string }).code ?? "unknown",
      }),
    );
  }
}
