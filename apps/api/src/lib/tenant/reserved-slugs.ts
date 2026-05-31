/**
 * Reserved tenant slugs — values that may not be used as a Tenant.slug.
 *
 * Categories:
 *  - Platform terms (paths reachable on api.example.com / app.example.com).
 *  - Brand-protection placeholders (top consumer brands and the trellis-org).
 *  - Generic legal / system terms.
 *
 * The list is conservative; expand over time. Slugs that pass {@link SLUG_REGEX}
 * but appear in this set are rejected at tenant-creation time.
 *
 * See plans/mvp/10-trellis-stages/01-schema-migration.md §slug-reservation-list.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // Platform / routing terms
  "admin",
  "agent",
  "agents",
  "api",
  "app",
  "apps",
  "auth",
  "billing",
  "cdn",
  "console",
  "dashboard",
  "docs",
  "help",
  "login",
  "logout",
  "mail",
  "media",
  "oauth",
  "openid",
  "register",
  "settings",
  "signin",
  "signup",
  "sso",
  "staff",
  "static",
  "status",
  "support",
  "system",
  "team",
  "test",
  "tenant",
  "tenants",
  "user",
  "users",
  "well-known",
  "www",

  // de otio / trellis specific
  "deotio",
  "de-otio",
  "trellis",

  // Top consumer brands (illustrative — extend as squatting attempts surface)
  "amazon",
  "apple",
  "facebook",
  "google",
  "instagram",
  "meta",
  "microsoft",
  "openai",
  "twitter",
  "whatsapp",
  "youtube",
  // Note: 1-char brand "x" is not listed — SLUG_REGEX enforces a 3-char minimum,
  // so 1-char slugs are unclaimable by format anyway.

  // Generic legal/product terms
  "about",
  "contact",
  "legal",
  "privacy",
  "security",
  "terms",
  "tos",
]);

/**
 * Validates the *format* of a tenant slug.
 *
 * Rules:
 *  - 3–40 characters.
 *  - Lowercase ASCII letters, digits, and hyphens only.
 *  - Must start and end with an alphanumeric character (no leading/trailing hyphens).
 *  - No two consecutive hyphens (avoids confusion with punycode `xn--`).
 *
 * The 40-char ceiling accommodates auto-generated personal-tenant slugs of
 * the form `personal-{userId}` where userId is a 25-char cuid (T2 — JIT
 * provisioning). User-claimed organization slugs typically stay well under
 * the Cognito `tenantSlug` claim limit of 32 chars.
 *
 * Format-only — does not check the reserved list. Combine with
 * {@link isReservedSlug} for the full admission test.
 */
export const SLUG_REGEX = /^(?!.*--)[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** Returns true if `slug` exactly matches a reserved value (case-insensitive). */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

/** Combined check: format + reservation. Returns null if valid, an error code otherwise. */
export function validateSlug(
  slug: string,
): "INVALID_FORMAT" | "RESERVED" | null {
  if (!SLUG_REGEX.test(slug)) return "INVALID_FORMAT";
  if (isReservedSlug(slug)) return "RESERVED";
  return null;
}
