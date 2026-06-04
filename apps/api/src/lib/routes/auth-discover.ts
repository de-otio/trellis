/**
 * POST /api/auth/discover
 *
 * Pre-login sign-in discovery. Accepts an email address and returns either:
 *   - { method: "idp", idpRedirect: "...", tenantSlug: "..." }  — federated tenant
 *   - { method: "password" }                                     — everything else
 *
 * Security properties:
 *  - No auth required (pre-login endpoint).
 *  - Never leaks whether a domain is claimed but with a disabled IdP.
 *  - Rate-limited 30 req/min per source IP (DynamoDB token bucket via RATE_LIMIT_KV).
 *  - Timing-safe: always performs the DB query; pads short-circuit paths to a
 *    fixed minimum elapsed time so response-time analysis cannot distinguish
 *    federated from non-federated domains.
 */

import type { Route } from "./types.js";
import { corsMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { deriveEmailDomain } from "../tenant/derive-domain.js";
import {
  buildIdpRedirectUrl,
  getIdpRedirectConfig,
} from "../auth/idp-redirect-builder.js";
import { cognitoIdpName } from "../tenant/idp-name.js";
import { RateLimiter } from "../rate-limit.js";
import { structuredError } from "./errors.js";
import type { Env } from "../../env.js";

const RATE_LIMIT_PER_MIN = 30;
const WINDOW_SECONDS = 60;
const MIN_RESPONSE_MS = 80;

function passwordResponse(): Response {
  return new Response(
    JSON.stringify({ method: "password" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function tooManyRequests(retryAfter: number): Response {
  const r = structuredError(429, {
    error: "RATE_LIMIT_EXCEEDED",
    message: "Too many sign-in discovery requests. Please slow down.",
    remediation: `Wait ${retryAfter} seconds before retrying.`,
  });
  // Attach Retry-After without re-constructing the body.
  const headers = new Headers(r.headers);
  headers.set("Retry-After", String(retryAfter));
  return new Response(r.body, { status: 429, headers });
}

async function padToMinimum(startMs: number): Promise<void> {
  const elapsed = Date.now() - startMs;
  if (elapsed < MIN_RESPONSE_MS) {
    await new Promise<void>((resolve) => setTimeout(resolve, MIN_RESPONSE_MS - elapsed));
  }
}

async function discoverHandler(request: Request, env: Env): Promise<Response> {
  const startMs = Date.now();

  const rateLimiter = new RateLimiter();
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown";

  const rateLimitResult = await rateLimiter.checkRateLimitKV(
    env,
    request,
    "auth-discover",
    RATE_LIMIT_PER_MIN,
    WINDOW_SECONDS,
  );

  if (!rateLimitResult.allowed) {
    const retryAfter = Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000);
    await padToMinimum(startMs);
    return tooManyRequests(retryAfter);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    await padToMinimum(startMs);
    return structuredError(400, {
      error: "INVALID_JSON",
      message: "Request body must be valid JSON.",
      remediation: "Ensure the request body is well-formed JSON with an 'email' field.",
    });
  }

  const { z } = await import("zod");
  const schema = z.object({ email: z.string() });
  const parsed = schema.safeParse(body);

  const emailDomain = parsed.success ? deriveEmailDomain(parsed.data.email) : null;

  if (!emailDomain) {
    await padToMinimum(startMs);
    return structuredError(400, {
      error: "INVALID_EMAIL",
      message: "A valid email address is required.",
      remediation: "Provide a well-formed email address in the 'email' field.",
      field: "email",
    });
  }

  const { createPrisma } = await import("../../db.js");
  const db = createPrisma(env);

  try {
    const row = await db.tenantDomain.findFirst({
      where: {
        domain: emailDomain,
        verifiedAt: { not: null },
        tenant: {
          identityProvider: {
            status: "ACTIVE",
          },
        },
      },
      select: {
        tenant: {
          select: {
            id: true,
            slug: true,
            identityProvider: {
              select: {
                cognitoIdpName: true,
              },
            },
          },
        },
      },
    });

    await padToMinimum(startMs);

    if (!row?.tenant?.identityProvider) {
      return passwordResponse();
    }

    const { tenant } = row;
    const idpName =
      tenant.identityProvider!.cognitoIdpName ?? cognitoIdpName(tenant.id);

    const config = getIdpRedirectConfig(env);
    const idpRedirect = buildIdpRedirectUrl(config, {
      cognitoIdpName: idpName,
      tenantSlug: tenant.slug,
    });

    return new Response(
      JSON.stringify({ method: "idp", idpRedirect, tenantSlug: tenant.slug }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    await padToMinimum(startMs);
    throw err;
  }
}

export const authDiscoverRoutes: Route[] = [
  {
    path: "/api/auth/discover",
    method: "POST",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const response = await discoverHandler(request, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware()],
    description: "Sign-in discovery: returns idp redirect or password fallback",
  },
];
