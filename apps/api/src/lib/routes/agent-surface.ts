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
 */

import { corsMiddleware } from "../middleware.js";
import { generateOpenApiDoc } from "../openapi/generator.js";
import type { Route } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const SECURITY_CONTACT = "security@example.com";
const SECURITY_POLICY_URL = "https://example.com/security/policy";
const SECURITY_CANONICAL_URL = "https://api.example.com/security.txt";

// ── llms.txt content ──────────────────────────────────────────────────────────

const LLMS_TXT_CONTENT = `# Trellis / Trellis — Agent Setup Contract

> Trellis is a social platform for dog fans with a B2B multi-tenant identity
> federation layer. This file tells an AI agent everything it needs to drive
> tenant onboarding end-to-end.

## Persona scenario

An IT engineer at a customer org says: "Help me set up Trellis for my company."
The agent should be able to:
1. Discover what Trellis is and what setup involves (this file).
2. Ask the engineer for the few inputs only a human can supply (Entra admin
   consent, role-mapping decisions).
3. Drive every other step via HTTP API or tools the agent already has
   (Microsoft Graph, Route53/Cloudflare DNS, etc.).
4. Verify the result.
5. Hand the engineer back a working tenant with a one-paragraph summary.

## Authentication

Agents authenticate via OIDC — no static API tokens are issued.
Two flows are supported:

- **PKCE + localhost-listener** (interactive agent on engineer's machine):
  Redirect to \`https://auth.example.com/oauth2/authorize\` with
  \`response_type=code&client_id=trellis-agent-cli&code_challenge=...\`
  and catch the code on \`http://127.0.0.1:{ephemeral-port}/cb\`.

- **Device authorization grant** (headless / CI agent):
  POST /oauth2/device_authorization → get device_code + user_code →
  engineer approves at https://app.example.com/agents/authorize →
  agent polls POST /oauth2/token.

Tokens are short-lived (~1 h). Refresh tokens are single-use and rotated.
The engineer can revoke any agent session at any time via GET/POST
/api/users/me/agent-sessions.

## Key endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| /api/tenants/{id}/setup-status | GET | Current onboarding progress + nextStep hint |
| /api/tenants/{id}/domains | POST | Add a domain for verification |
| /api/tenants/{id}/domains/{domainId}/verify | POST | Trigger DNS TXT check |
| /api/tenants/{id}/identity-provider | POST | Connect OIDC/SAML IdP |
| /api/tenants/{id}/identity-provider/test-sign-in | POST | Validate IdP round-trip |
| /api/tenants/{id}/role-mappings | POST | Map IdP group → Trellis role |
| /api/tenants/{id}/audit | GET | Audit log of tenant events |
| /api/auth/discover | POST | Pre-login: resolve email → IdP redirect or password |
| /openapi.json | GET | Full OpenAPI 3.1 spec (this server) |
| /.well-known/compliance.json | GET | Tenant compliance bundle |

## Error format

Every 4xx response from federation endpoints is JSON:
\`\`\`json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description.",
  "remediation": "Exact next step or 'ask the engineer X'.",
  "field": "fieldName"
}
\`\`\`

## Idempotency

Every federation POST accepts an \`Idempotency-Key\` header. Same key + same
body within 24 h returns the original 2xx response without side-effects.

## Safety

- Client secrets are write-only. GET /api/tenants/{id}/identity-provider
  returns \`null\` for \`clientSecret\`. Never echo secrets in conversation.
- Destructive operations require \`?confirm=true\`. A call without it returns
  400 with a remediation explaining the risk.
- Agents should request minimal scopes: domain.*, idp.*, role_mapping.*.

## Further reading

- Full spec: GET /openapi.json
- Compliance bundle: GET /.well-known/compliance.json (per-tenant, auth required)
- Security contact: GET /security.txt
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
      handler: async (_request, _env) => {
        return new Response(LLMS_TXT_CONTENT, {
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
      handler: async (_request, _env) => {
        const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
        const body = [
          `Contact: mailto:${SECURITY_CONTACT}`,
          `Expires: ${expires}`,
          `Preferred-Languages: en`,
          `Canonical: ${SECURITY_CANONICAL_URL}`,
          `Policy: ${SECURITY_POLICY_URL}`,
          "",
        ].join("\n");

        return new Response(body, {
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
