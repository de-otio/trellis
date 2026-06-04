/**
 * Email-domain extraction for tenant resolution (T2 — JIT provisioning).
 *
 * Cross-tenant isolation depends on this helper being conservative: never
 * substring/wildcard-match a domain. Callers do an exact `tenant_domains.domain
 * == lower(emailDomain)` lookup. If parsing fails, we return null and the
 * federated-tenant resolution short-circuits to "personal-tenant only".
 *
 * See sec finding #8 in plans/mvp/10-trellis-stages/02-cognito-triggers.md.
 */

const EMAIL_PATTERN = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/;

/**
 * Extracts the lowercased domain part of an email address.
 *
 * Returns null for any input that doesn't have exactly one `@` and a
 * non-empty domain part with at least one dot. Conservatively rejects
 * inputs we don't fully recognise rather than guessing.
 */
export function deriveEmailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  if (!trimmed) return null;
  const match = EMAIL_PATTERN.exec(trimmed);
  if (!match) return null;
  const domain = match[1].toLowerCase();
  if (domain.includes("@")) return null;
  if (domain.startsWith(".") || domain.endsWith(".")) return null;
  return domain;
}
