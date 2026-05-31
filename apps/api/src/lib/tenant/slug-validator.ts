/**
 * Slug Validator
 *
 * Wraps the T1 slug regex and reserved-list into a typed result that
 * route handlers can pattern-match on.
 */

import { validateSlug } from "./reserved-slugs.js";

export type SlugValidationResult =
  | { ok: true }
  | { ok: false; code: "INVALID_FORMAT"; message: string }
  | { ok: false; code: "RESERVED"; message: string };

/**
 * Full admission check for a tenant slug: format + reserved-list.
 *
 * Negative test cases (must never pass):
 *   - Shell-escape attempts: "foo; rm -rf", "$(evil)", "`cmd`"  → INVALID_FORMAT (non-[a-z0-9-])
 *   - URL-injection: "../admin", "//evil.com", "%2F"            → INVALID_FORMAT
 *   - Leading/trailing hyphen: "-foo", "foo-"                   → INVALID_FORMAT
 *   - Double-hyphen: "foo--bar"                                 → INVALID_FORMAT
 *   - Too short: "ab" (2 chars)                                 → INVALID_FORMAT
 *   - Too long: 41+ chars                                       → INVALID_FORMAT
 *   - Reserved word: "admin", "system"                          → RESERVED
 */
export function validateTenantSlug(slug: string): SlugValidationResult {
  const code = validateSlug(slug);
  if (code === "INVALID_FORMAT") {
    return {
      ok: false,
      code: "INVALID_FORMAT",
      message:
        "Slug must be 3–40 lowercase alphanumeric characters or hyphens, " +
        "start and end with an alphanumeric character, and contain no consecutive hyphens.",
    };
  }
  if (code === "RESERVED") {
    return {
      ok: false,
      code: "RESERVED",
      message: "This slug is reserved and cannot be used.",
    };
  }
  return { ok: true };
}
