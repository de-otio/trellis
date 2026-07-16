/**
 * Shared cuid shape check.
 *
 * The canonical validator for cuid-shaped ids (user ids, tenant ids) minted by
 * the DB layer and carried in Cognito claims. Kept in one module so every
 * boundary that trusts a raw id string — the auth middleware, the session
 * manager's JWT path, and the extension route wrapper — validates against the
 * exact same pattern. A drift between two copies of this regex is a security
 * bug (one boundary accepting what another rejects), so there is deliberately
 * only one.
 *
 * cuid v1 is `c[a-z0-9]{24}`. We allow up to 40 chars to absorb future widening
 * and any cuid v2 / nanoid variants without re-issuing every JWT.
 */
export const CUID_RE = /^c[a-z0-9]{24,40}$/;
