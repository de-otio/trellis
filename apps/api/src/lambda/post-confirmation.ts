/**
 * Thin AWS entrypoint for the Cognito PostConfirmation trigger (WS-3.3
 * trigger-hook extraction, WS-2 pattern).
 *
 * Fires once per user-pool record after Cognito accepts a sign-up
 * (`PostConfirmation_ConfirmSignUp`) or a forgotten-password confirmation
 * (`PostConfirmation_ConfirmForgotPassword`). For federated identities the
 * same trigger source is `PostConfirmation_ConfirmSignUp`; the
 * `request.userAttributes.identities` JSON string is the disambiguator.
 *
 * Owns the Cognito concerns only: the trigger-event shape (attribute reads,
 * `identities` federation signal, clientMetadata), the Powertools logger,
 * Prisma via `getLambdaPrisma` + the Lambda circuit breaker, and the
 * env-bound deps (pseudonym key config, actor base URL, retention). The
 * provisioning LOGIC lives in `lib/identity/provision-confirmed-user.ts`.
 */

import type {
  PostConfirmationTriggerEvent,
  PostConfirmationTriggerHandler,
} from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { getLambdaPrisma as getPrisma, withLambdaDbBreaker } from "../lib/lambda-prisma.js";
import { ClaimsCache, createClaimsCacheFromEnv } from "../lib/auth/claims-cache.js";
import { computeAnonymousId } from "../lib/pseudonym.js";
import { provisionConfirmedUser } from "../lib/identity/provision-confirmed-user.js";

const logger = new Logger({ serviceName: "post-confirmation" });
let cache: ClaimsCache | null = null;

function getCache(): ClaimsCache {
  if (!cache) cache = createClaimsCacheFromEnv();
  return cache;
}

/**
 * Test seam (WS-1 §3.6): inject a `ClaimsCache` (e.g. backed by a
 * `MemoryKvStore`) so the claims-priming path can be asserted by OUTCOME
 * (`cache.get(sub)`) rather than by spying on raw DynamoDB commands. Pass
 * `null` to reset.
 */
export function __setClaimsCacheForTest(c: ClaimsCache | null): void {
  cache = c;
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

const SUPPORTED_TRIGGERS = new Set([
  "PostConfirmation_ConfirmSignUp",
  "PostConfirmation_ConfirmForgotPassword",
]);

export const handler: PostConfirmationTriggerHandler = async (event) => {
  if (!SUPPORTED_TRIGGERS.has(event.triggerSource)) return event;

  const attrs = event.request.userAttributes;
  // Identify the user by the immutable provider `sub` (the value carried in
  // the issued ID/access tokens), NOT `event.userName`. `userName` is not
  // stable across trigger contexts — PostConfirmation sees the sign-up
  // username while PreTokenGeneration on alias (email) sign-in receives the
  // `sub` — so keying the User row and the claims cache on it silently breaks
  // the cache lookup (the claim is written under one key and read under
  // another → 401s).
  const sub = attrs.sub;

  const db = await getPrisma();

  await provisionConfirmedUser(
    {
      sub,
      email: attrs.email,
      emailVerified: attrs.email_verified === "true",
      federated: isFederatedEvent(event),
      idpGroupsRaw: attrs["custom:idpGroups"],
      dateOfBirthRaw: attrs["custom:dateOfBirth"],
      providedHandle: attrs["custom:handle"],
      guardianEmail: attrs["custom:guardianEmail"],
      invitationCode: event.request.clientMetadata?.invitationCode,
      signupMethodHint: event.request.clientMetadata?.signupMethod,
    },
    {
      db,
      // Adapt Powertools' variadic logger onto the core's narrow surface.
      logger: {
        info: (message, meta) => logger.info(message, { ...meta }),
        warn: (message, meta) => logger.warn(message, { ...meta }),
        error: (message, meta) => logger.error(message, { ...meta }),
      },
      claimsCache: getCache(),
      computeAnonymousId: (userId) =>
        computeAnonymousId(userId, {
          PSEUDONYM_HMAC_KMS_KEY_ID: process.env.PSEUDONYM_HMAC_KMS_KEY_ID,
          AWS_REGION: process.env.AWS_REGION,
        }),
      markInvitationRecordUsed: async (input) => {
        const { markPreSignUpInvitationRecordUsed } = await import(
          "../lib/invitation-presignup-record.js"
        );
        await markPreSignUpInvitationRecordUsed(input);
      },
      actorBaseUrl: process.env.ACTIVITYPUB_BASE_URL || process.env.APP_DOMAIN,
      signupEventRetentionDays: process.env.SIGNUP_EVENT_RETENTION_DAYS,
      dbGuard: withLambdaDbBreaker,
    },
  );

  return event;
};
