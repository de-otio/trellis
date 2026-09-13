/**
 * The public origin the API is reachable at, for the absolute URLs the API
 * writes into its own responses (media variants, the upload serve URL).
 *
 * Precedence:
 *   1. `APP_DOMAIN` — a URL or a bare host (deployments set the bare form; a
 *      scheme is added so it parses). A `www.` host maps to `api.`; a host
 *      without an `api.` label gets one on its apex (`app.example.com` →
 *      `api.example.com`); a single-label host (`localhost`) is used as is.
 *   2. The incoming request's own origin, when the caller has one.
 *   3. `""` — the URLs come back relative to the API, and a warning is logged
 *      once per process.
 *
 * There is deliberately no compiled-in default. The published core used to
 * fall back to a fixed hostname, which meant any deployment that left
 * `APP_DOMAIN` unset handed its clients media URLs pointing at somebody
 * else's server; a reusable core ships no deployment's hostname.
 */

import type { Env } from "../env.js";
import { getLogger } from "./logger.js";

let warnedRelative = false;

function withScheme(value: string): string {
  return /^https?:\/\//.test(value) ? value : `https://${value}`;
}

function originFromAppDomain(appDomain: string): string | undefined {
  let url: URL;
  try {
    url = new URL(withScheme(appDomain.trim().replace(/\/$/, "")));
  } catch {
    return undefined;
  }
  let hostname = url.hostname;
  if (hostname.startsWith("www.")) {
    hostname = hostname.replace("www.", "api.");
  } else if (!hostname.includes("api.")) {
    const parts = hostname.split(".");
    if (parts.length >= 2) {
      hostname = `api.${parts.slice(-2).join(".")}`;
    }
  }
  return `${url.protocol}//${hostname}`;
}

export function resolveApiOrigin(
  env: Pick<Env, "APP_DOMAIN">,
  request?: Pick<Request, "url">,
): string {
  if (env.APP_DOMAIN) {
    const fromEnv = originFromAppDomain(env.APP_DOMAIN);
    if (fromEnv) return fromEnv;
  }
  if (request) {
    try {
      return new URL(request.url).origin;
    } catch {
      // fall through
    }
  }
  if (!warnedRelative) {
    warnedRelative = true;
    getLogger().warn(
      "[api-origin] APP_DOMAIN is not set; media URLs in responses are relative to the API origin",
    );
  }
  return "";
}

/** Test seam: forget that the relative-URL warning was already logged. */
export function resetApiOriginWarning(): void {
  warnedRelative = false;
}
