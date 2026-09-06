/**
 * Shared SUPER_ADMIN auth guard.
 *
 * Was retyped verbatim (differing only in the forbidden-message string) in
 * three places: `tenant/platform-category-admin-handler.ts`,
 * `content-report-admin-handler.ts`, `report-category-admin-handler.ts`. One
 * guard, parameterized by message (quality sweep 2026-09-05, D2).
 */

import type { AuthContext } from "./auth-context.js";

const DEFAULT_MESSAGE = "SUPER_ADMIN role required for this operation.";

/**
 * Returns a 403 Response if the caller is not SUPER_ADMIN, or `null` if the
 * check passes.
 */
export function requireSuperAdmin(
  auth: AuthContext,
  message: string = DEFAULT_MESSAGE,
): Response | null {
  if (auth.globalRole === "SUPER_ADMIN") return null;
  return new Response(JSON.stringify({ error: "FORBIDDEN", message }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}
