/**
 * Thin trellis-side adapter around `@de-otio/saas-foundation/net`.
 *
 * Foundation exposes `trustedClientIp(request, { mode })` with a strict
 * `TrustedProxyMode = "none" | "alb" | "cloudflare"`. Trellis stores the
 * mode as a string in `env.TRUSTED_PROXY` and historically accepted any
 * case (`"ALB"` / `"Alb"` / `"alb"` all worked). This wrapper normalises
 * the env value and delegates; call sites stay `trustedClientIp(request, env)`.
 *
 * `isIpShape` is a straight re-export — foundation owns the regex now.
 */

import {
  trustedClientIp as foundationTrustedClientIp,
  type TrustedProxyMode,
} from "@de-otio/saas-foundation/net";

export { isIpShape } from "@de-otio/saas-foundation/net";

interface RemoteAddrEnv {
  TRUSTED_PROXY?: string;
}

export function trustedClientIp(request: Request, env: RemoteAddrEnv): string {
  const raw = (env.TRUSTED_PROXY ?? "none").toLowerCase();
  const mode: TrustedProxyMode =
    raw === "alb" || raw === "cloudflare" ? raw : "none";
  return foundationTrustedClientIp(request, { mode });
}
