/**
 * Agent-Surface Routes  (T9b-a)
 *
 * Public, unauthenticated discovery endpoints for AI agents and tooling:
 *
 *   GET /llms.txt           — setup contract for AI agents (llmstxt.org convention)
 *   GET /openapi.json       — OpenAPI 3.1 document auto-generated from route registry
 *   GET /security.txt       — RFC 9116 security contact
 *
 * All three are rate-limited at the API Gateway / WAF layer (120 req/min per IP).
 * No session required.
 *
 * ── Consumer-configurable content (plan 034, lane "agent words") ───────────
 *
 * `llms.txt` and `security.txt` bodies are plain text with no place to put a
 * consuming app's own product name, contacts, or persona-specific setup
 * narrative — trellis is the generic core, and its defaults must describe
 * only what trellis itself truthfully does. A consuming application (e.g.
 * Skybber) supplies its own content via `AgentSurfaceContent`, injected
 * through the SAME app-configuration path as `APP_DOMAIN`/`ALLOWED_ORIGINS`
 * (see `Env.agentSurface` in `apps/api/src/env.ts`, sourced from the
 * `AGENT_SURFACE_LLMS_TXT` / `AGENT_SURFACE_SECURITY_TXT` env vars):
 *
 *   - `llmsTxt` absent  → serve `DEFAULT_LLMS_TXT_CONTENT` below (generic,
 *     verified true against this repo's routes).
 *   - `securityTxt` absent → 404 with the standard error envelope. A missing
 *     security.txt is honest; the placeholder `security@example.com` contact
 *     it replaced was not (RFC 9116 has no "not configured yet" placeholder
 *     convention, and inventing one is worse than a 404).
 */

import { corsMiddleware } from "../middleware.js";
import { generateOpenApiDoc } from "../openapi/generator.js";
import { structuredError } from "./errors.js";
import type { Route } from "./types.js";

// ── Consumer-injected content type ──────────────────────────────────────────

/**
 * Consumer-supplied content for the agent-surface text routes. Both fields
 * are optional and additive — see the file banner above for the fallback
 * behaviour of each. Bodies are served verbatim (no template substitution),
 * so the consumer is responsible for the full RFC 9116 / llmstxt.org shape.
 */
export interface AgentSurfaceContent {
  /** Full body for GET /llms.txt. */
  llmsTxt?: string;
  /** Full body for GET /security.txt. */
  securityTxt?: string;
}

// ── llms.txt content ──────────────────────────────────────────────────────────

/**
 * Trellis's own default `llms.txt`. Generic — no product name other than
 * "Trellis", no consuming-app persona or contacts. Every claim below is true
 * against this repo's route registry as of plan 034; verify against
 * `apps/api/src/lib/routes/` before changing a claim rather than trusting
 * this comment.
 */
const DEFAULT_LLMS_TXT_CONTENT = `# Trellis — Agent Setup Contract

> Trellis is a generic, multi-tenant social-platform core with SAML/OIDC
> identity federation. This is trellis's own default content for this route;
> a consuming application may replace it with product-specific content (see
> \`agentSurface.llmsTxt\` in its deployment configuration).

## Authentication

Agents authenticate via OIDC. Two flows exist:

- **Interactive (authorization code + PKCE):** redirect the operator to this
  deployment's configured identity provider — its own hosted authorization
  endpoint — and exchange the returned code for a session: the standard
  OAuth 2.0 authorization-code-with-PKCE flow.
- **Headless / CI (device-authorization grant, RFC 8628):**
  POST /oauth2/device_authorization → device_code + user_code →
  the operator approves at /agents/authorize → the agent polls
  POST /oauth2/token.

Either way, the agent acts with the approving operator's own authority — a
first-party, unscoped session. There is currently no narrower, agent-specific
scope a caller can request. The operator can revoke a single agent session at
any time via GET/POST /api/users/me/agent-sessions.

## Key endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| /openapi.json | GET | Full OpenAPI 3.1 document, generated from the route registry |
| /oauth2/device_authorization | POST | Start a device-authorization grant (RFC 8628) |
| /oauth2/token | POST | Poll/exchange a device-authorization grant |
| /agents/authorize | GET | Operator approval page for a pending device grant |
| /api/users/me/agent-sessions | GET/POST | List / revoke this operator's own agent sessions |
| /api/tenants/{id}/setup-status | GET | Current tenant onboarding progress + nextStep hint |
| /api/tenants/{id}/domains | POST | Add a domain for verification |
| /api/tenants/{id}/domains/{domainId}/verify | POST | Trigger DNS TXT check |
| /api/tenants/{id}/identity-provider | POST | Connect an OIDC/SAML identity provider |
| /api/tenants/{id}/role-mappings | POST | Map an identity-provider group to a Trellis role |
| /api/tenants/{id}/audit | GET | Audit log of tenant events |
| /api/tenants/{id}/compliance.json | GET | Tenant compliance bundle (authenticated; requires the audit.view capability) |
| /api/auth/discover | POST | Pre-login: resolve an email to its identity provider or password sign-in |

## Error format

Every 4xx response from the federation surface is JSON:
\`\`\`json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description.",
  "remediation": "Exact next step.",
  "field": "fieldName"
}
\`\`\`

## Idempotency

Every federation POST accepts an \`Idempotency-Key\` header. Same key + same
body within 24 h returns the original 2xx response without side-effects.

## Safety

- Client secrets are write-only: GET /api/tenants/{id}/identity-provider
  never returns \`clientSecret\`. Never echo secrets in conversation.
- Destructive operations require \`?confirm=true\`. A call without it returns
  400 with a remediation explaining the risk.

## Further reading

- Full spec: GET /openapi.json
- Security contact: GET /security.txt — this deployment may not have
  configured one; an unconfigured deployment returns 404 rather than a
  placeholder contact.
`;

// ── Route definitions ─────────────────────────────────────────────────────────

/**
 * Build a lazy-caching OpenAPI JSON getter scoped to a specific route-list getter.
 * The cache is per-getter closure so multiple `buildAgentSurfaceRoutes` calls
 * (e.g. in tests) each get an independent cache.
 */
function makeOpenApiGetter(getAllRoutes: () => Route[]): () => string {
  let cached: string | null = null;
  return () => {
    if (cached === null) {
      const doc = generateOpenApiDoc(getAllRoutes());
      cached = JSON.stringify(doc, null, 2);
    }
    return cached;
  };
}

/**
 * Build the agent-surface routes, injecting the full route list so the
 * OpenAPI generator can introspect the registry.
 *
 * Usage in routes/index.ts:
 *   import { buildAgentSurfaceRoutes } from "./agent-surface.js";
 *   // after all routes are collected:
 *   const agentSurface = buildAgentSurfaceRoutes(coreRoutes);
 *
 * Because we need the full route list for OpenAPI generation but the route
 * list includes these routes themselves, we expose a plain `agentSurfaceRoutes`
 * export that uses a deferred getter — the first HTTP request triggers
 * generation using whatever has been registered by then.
 */
export function buildAgentSurfaceRoutes(getAllRoutes: () => Route[]): Route[] {
  const getOpenApiJson = makeOpenApiGetter(getAllRoutes);
  return [
    // ── GET /llms.txt ────────────────────────────────────────────────────────
    {
      path: "/llms.txt",
      method: "GET",
      handler: async (_request, env) => {
        const body = env.agentSurface?.llmsTxt ?? DEFAULT_LLMS_TXT_CONTENT;
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        });
      },
      middleware: [corsMiddleware()],
      description: "Agent setup contract (llmstxt.org convention)",
    },

    // ── GET /openapi.json ────────────────────────────────────────────────────
    {
      path: "/openapi.json",
      method: "GET",
      handler: async (_request, _env) => {
        const json = getOpenApiJson();
        return new Response(json, {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=300",
          },
        });
      },
      middleware: [corsMiddleware()],
      description: "OpenAPI 3.1 document (auto-generated from route registry)",
    },

    // ── GET /security.txt ────────────────────────────────────────────────────
    {
      path: "/security.txt",
      method: "GET",
      handler: async (_request, env) => {
        const configured = env.agentSurface?.securityTxt;
        if (!configured) {
          // A missing security.txt is honest; a placeholder contact is not
          // (see the file banner). No consumer content ⇒ no route.
          return structuredError(404, {
            error: "NOT_FOUND",
            message: "No security.txt is configured for this deployment.",
            remediation:
              "Configure agentSurface.securityTxt (env var AGENT_SURFACE_SECURITY_TXT) with an RFC 9116 body to serve a real security contact.",
          });
        }

        return new Response(configured, {
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "public, max-age=86400",
          },
        });
      },
      middleware: [corsMiddleware()],
      description: "RFC 9116 security contact",
    },
  ];
}

/**
 * Static export for the route registry.
 *
 * These routes have no dependency on the full route list (llms.txt and
 * security.txt are static; openapi.json generates lazily on first request).
 * Import and spread into coreRoutes in routes/index.ts.
 */
export const agentSurfaceRoutes: Route[] = buildAgentSurfaceRoutes(() => []);
