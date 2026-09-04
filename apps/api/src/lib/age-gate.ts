/**
 * Age Gate Module
 *
 * The single home for age-tier arithmetic and the tier-based feature-access
 * tables, and the single place the platform's **minimum age** is stated.
 *
 * ## Minor tiers are quarantined (18+ product decision)
 *
 * The platform accepts adults only: {@link MINIMUM_SIGNUP_AGE_YEARS} is
 * enforced server-side at every point a date of birth enters the system, so a
 * CHILD or TEEN account cannot be created. {@link MINOR_TIERS_SUPPORTED}
 * records that decision as one constant the whole codebase reads, rather than
 * leaving minor-tier branches scattered around, passing their unit tests, and
 * running for nobody.
 *
 * The `AgeTier` enum, the `User.ageTier` column, the tier→policy tables below
 * and the nightly transition job all stay. They are the *policy* half and are
 * cheap to keep correct. What is quarantined is *resolution*: a session's tier
 * is ADULT by construction (see {@link resolveSessionAgeTier}) and the
 * guardian-facing endpoints refuse rather than pretend to work.
 */

import type { AgeTier } from "@prisma/client";

/**
 * Minimum age, in years, to hold an account.
 *
 * Enforced server-side at both points a date of birth can enter the system:
 * `identity/register.ts` (the brokered-IdP registration endpoint) and
 * `identity/provision-confirmed-user.ts` (JIT provisioning on first sign-in,
 * reached from both the Cognito PostConfirmation trigger and the Keycloak
 * path). The client-side check in the consuming application is a UX
 * affordance; this constant is the enforcement.
 */
export const MINIMUM_SIGNUP_AGE_YEARS = 18;

/**
 * Whether CHILD/TEEN accounts are a supported product.
 *
 * `false` since the 18+ minimum-age decision. Typed as `boolean` (not the
 * literal `false`) on purpose: the flag is a product decision, not a
 * type-level fact, and narrowing it would make every guarded branch look
 * unreachable to readers and tooling.
 *
 * While this is `false`:
 *   - {@link resolveSessionAgeTier} returns ADULT for every session;
 *   - the guardian/parental-control endpoints return 410 Gone;
 *   - provisioning rejects a date of birth under {@link MINIMUM_SIGNUP_AGE_YEARS}.
 *
 * Flipping it to `true` is NOT sufficient to ship minor support — it only
 * un-gates the machinery. The tier would also have to survive the token path
 * (`TrellisClaims` carries no `ageTier`, and the Cognito claim narrowing drops
 * `custom:ageTier`), which is the gap that made all of this inert to begin
 * with. Grep this symbol for the full set of sites.
 */
export const MINOR_TIERS_SUPPORTED: boolean = false;

/**
 * The structured 4xx envelope returned when a date of birth is below the
 * minimum age. Shared by every enforcement point so the client sees one shape
 * and one code regardless of which provider it registered through.
 */
export const UNDER_MINIMUM_AGE_ERROR = {
  error: "AGE_REQUIREMENT_NOT_MET",
  message: `You must be at least ${MINIMUM_SIGNUP_AGE_YEARS} years old to create an account.`,
  remediation:
    `Accounts are available to people aged ${MINIMUM_SIGNUP_AGE_YEARS} and over. ` +
    "If your date of birth was entered incorrectly, correct it and register again.",
  field: "dateOfBirth",
} as const;

/**
 * The structured envelope for an endpoint that exists only to serve minor
 * accounts. Returned with 410 Gone: the route was real, the capability is
 * withdrawn, and a caller should stop asking — which is the honest answer, and
 * distinguishable from a 404 typo'd path.
 */
export const MINOR_TIERS_UNSUPPORTED_ERROR = {
  error: "MINOR_ACCOUNTS_NOT_SUPPORTED",
  message:
    "Guardian and minor-account features are not available on this platform.",
  remediation:
    `All accounts are held by people aged ${MINIMUM_SIGNUP_AGE_YEARS} and over, ` +
    "so there is nothing for a guardian to manage. Stop calling this endpoint.",
} as const;

/**
 * Thrown by provisioning when a date of birth is below the minimum age.
 *
 * Provisioning is not an HTTP boundary (it is reached from a Cognito trigger
 * and from JIT sign-in), so it throws rather than returning a Response — but
 * it carries the same envelope, so an HTTP caller can serialise it unchanged.
 */
export class UnderMinimumAgeError extends Error {
  readonly envelope = UNDER_MINIMUM_AGE_ERROR;

  constructor() {
    super(UNDER_MINIMUM_AGE_ERROR.message);
    this.name = "UnderMinimumAgeError";
  }
}

export interface FeatureAccess {
  maxFeedPages: number | null; // null = unlimited
  sessionTimeLimits: {
    firstNudgeMinutes: number | null;
    secondNudgeMinutes: number | null;
    hardLimitMinutes: number | null;
  };
  sentimentDisplay: "full" | "distribution" | "hidden";
  sentimentDisplayOwnPost: "full" | "distribution";
  canViewSentimentUsers: boolean;
  canEditNotificationPreferences: boolean;
  showUnreadCount: boolean; // false = show boolean hasUnread only
  dmAccess: "anyone" | "connections" | "nobody";
}

/**
 * Whole years elapsed between `dateOfBirth` and `now`, computed **entirely in
 * UTC**.
 *
 * Both operands must be read in the same calendar frame. Mixing them — reading
 * the DOB in UTC and "today" in the server's local zone, or vice versa — moves
 * the answer by a day for anyone whose birthday is near a UTC day boundary,
 * and the direction of the error depends on where the server happens to be
 * running. Dates of birth are stored as UTC midnight (`YYYY-MM-DDT00:00:00Z`,
 * see `identity/register.ts`), so UTC is the frame that matches the data.
 *
 * `now` is injectable so callers can pin it: a batch job computes every user
 * against one instant, and tests get a deterministic answer.
 */
export function computeAgeYears(dateOfBirth: Date, now: Date = new Date()): number {
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())
  ) {
    age--;
  }
  return age;
}

/**
 * Calculate age tier from date of birth.
 *
 * Under 13 = CHILD, 13-17 = TEEN, 18+ = ADULT.
 *
 * This is the ONLY implementation. Two further copies used to live in
 * `age-tier-transition.ts` and `identity/provision-confirmed-user.ts`; the
 * transition copy read the clock in server-local time while the other two read
 * UTC, so the nightly job could disagree with provisioning about the tier of
 * the same user by a day. Both now import this function.
 */
export function computeAgeTier(dateOfBirth: Date, now: Date = new Date()): AgeTier {
  const age = computeAgeYears(dateOfBirth, now);
  if (age < 13) {
    return "CHILD";
  } else if (age < MINIMUM_SIGNUP_AGE_YEARS) {
    return "TEEN";
  } else {
    return "ADULT";
  }
}

/**
 * True when `dateOfBirth` puts the holder below {@link MINIMUM_SIGNUP_AGE_YEARS}.
 * The predicate every enforcement point calls.
 */
export function isUnderMinimumAge(dateOfBirth: Date, now: Date = new Date()): boolean {
  return computeAgeYears(dateOfBirth, now) < MINIMUM_SIGNUP_AGE_YEARS;
}

/**
 * Resolve the age tier a request should be served under, from whatever the
 * session claims.
 *
 * **This is the quarantine choke point.** While {@link MINOR_TIERS_SUPPORTED}
 * is `false` the answer is ADULT for every session, including one that
 * explicitly carries `ageTier: "CHILD"`. Every session-derived tier read in
 * the request path goes through here, so "minor gating never fires" is a
 * property of one tested function rather than an accident of the token
 * plumbing dropping the claim.
 *
 * Note what this does NOT cover: tiers read from `User.ageTier` in the
 * database (notification delivery floors, recap, the nightly transition job).
 * Those are a genuine defence-in-depth floor over stored data and stay live.
 */
export function resolveSessionAgeTier(sessionAgeTier?: AgeTier | undefined): AgeTier {
  if (!MINOR_TIERS_SUPPORTED) return "ADULT";
  return sessionAgeTier ?? "ADULT";
}

/**
 * Returns true if the age tier requires parental consent (CHILD only).
 */
export function requiresParentalConsent(ageTier: AgeTier): boolean {
  return ageTier === "CHILD";
}

/**
 * Returns the feature access configuration for the given age tier.
 */
export function getFeatureAccess(ageTier: AgeTier): FeatureAccess {
  switch (ageTier) {
    case "CHILD":
      return {
        maxFeedPages: 5,
        sessionTimeLimits: {
          firstNudgeMinutes: 15,
          secondNudgeMinutes: 25,
          hardLimitMinutes: 30,
        },
        sentimentDisplay: "hidden",
        sentimentDisplayOwnPost: "distribution",
        canViewSentimentUsers: false,
        canEditNotificationPreferences: false,
        showUnreadCount: false,
        dmAccess: "nobody",
      };

    case "TEEN":
      return {
        maxFeedPages: 20,
        sessionTimeLimits: {
          firstNudgeMinutes: 30,
          secondNudgeMinutes: 50,
          hardLimitMinutes: null,
        },
        sentimentDisplay: "distribution",
        sentimentDisplayOwnPost: "distribution",
        canViewSentimentUsers: false,
        canEditNotificationPreferences: true,
        showUnreadCount: false,
        dmAccess: "connections",
      };

    case "ADULT":
      return {
        maxFeedPages: null,
        sessionTimeLimits: {
          firstNudgeMinutes: 60,
          secondNudgeMinutes: null,
          hardLimitMinutes: null,
        },
        sentimentDisplay: "full",
        sentimentDisplayOwnPost: "full",
        canViewSentimentUsers: true,
        canEditNotificationPreferences: true,
        showUnreadCount: true,
        dmAccess: "connections",
      };
  }
}
