/**
 * OAuth 2.0 device-authorization endpoints (T9b-d, RFC 8628).
 *
 *   POST /oauth2/device_authorization
 *   POST /oauth2/token (grant_type=urn:ietf:params:oauth:grant-type:device_code)
 *
 * Discovery + agent-approval pages live in `agent-authorize.ts`. The
 * /settings/agents user-facing surface lives in `agent-sessions.ts`.
 *
 * No CSRF on these endpoints — they accept token-bearing or anonymous
 * requests from CLIs that aren't running in a browser context.
 */

import { z } from "zod";
import {
  pollDeviceAuth,
  startDeviceAuthorization,
} from "../oauth/device-authorization.js";
import { corsMiddleware } from "../middleware.js";
import { trustedClientIp } from "../net/trusted-client-ip.js";
import { SecurityHeaders } from "../security-headers.js";
// structuredError imported for consistency with federation surface error format.
// RFC 8628 §5.2 prescribes its own error codes (snake_case) for /oauth2/* endpoints;
// those are left as-is since deviating from the RFC would break OAuth clients.
import { structuredError as _structuredError } from "./errors.js";
import type { Route } from "./types.js";

/**
 * Hard cap on the agent-supplied User-Agent we accept as the agent label
 * (G4 HIGH-4). The label is rendered on the operator's approval page and
 * persisted alongside the agent session. Anything beyond this size is
 * truncated server-side at request time.
 */
const MAX_AGENT_LABEL_BYTES = 256;

function truncateAgentLabel(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  if (input.length <= MAX_AGENT_LABEL_BYTES) return input;
  return input.slice(0, MAX_AGENT_LABEL_BYTES);
}

const DEVICE_AUTHORIZATION_RE = /^\/oauth2\/device_authorization$/;
const TOKEN_RE = /^\/oauth2\/token$/;

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** RFC 8628 §3.1 — request body is a form-encoded `client_id`. */
const DeviceAuthorizationRequestSchema = z
  .object({
    client_id: z.string().min(1).max(256),
    scope: z.string().max(1024).optional(),
  })
  .strict();

const TokenRequestSchema = z
  .object({
    grant_type: z.literal(DEVICE_GRANT_TYPE),
    device_code: z.string().min(16).max(512),
    client_id: z.string().min(1).max(256),
  })
  .strict();

function jsonResponse(body: unknown, status: number, env: unknown): Response {
  const sec = new SecurityHeaders(env as never);
  return sec.createSecureResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * D.3 — boot-time fail-closed check on the agent client registration.
 *
 * `/oauth2/device_authorization` and `/oauth2/token` are mounted
 * unconditionally, and both used to guard with `if (expectedClientId && …)`:
 * with `COGNITO_AGENT_CLIENT_ID` unset, ANY `client_id` was accepted. Every
 * other auth decision in this codebase fails closed and says so
 * (`auth-config.ts` `resolveAuthConfig`, `cognito-jwt.ts` `normalizeClaims`,
 * `session-cookie.ts` `isTokenRevoked`); this one did not.
 *
 * The request handlers below now also reject when the value is unset, so the
 * fail-open is gone regardless of whether this assertion is wired. This
 * function exists so a deployment that mounts the OAuth routes without a
 * client id does not report itself healthy — the same reasoning as
 * `assertModerationProviderAllowed`, called from `server.ts`'s boot sequence.
 *
 * A client registry replaces the check entirely in Phase 1.
 *
 * @throws when the agent client id is unset and the escape hatch is not set.
 */
export function assertAgentOAuthConfigured(env: {
  COGNITO_AGENT_CLIENT_ID?: string | undefined;
  AGENT_OAUTH_CLIENT_ID_OPTIONAL?: string | undefined;
}): void {
  if (env.COGNITO_AGENT_CLIENT_ID) return;
  if (env.AGENT_OAUTH_CLIENT_ID_OPTIONAL === "true") {
    // Explicit operator opt-out: boot proceeds, but the agent surface stays
    // closed — the handlers below still reject every client_id. This is the
    // "merge behind a toggle and flip after" rollout, not a fail-open.
    return;
  }
  throw new Error(
    "agent OAuth client id could not be resolved — set COGNITO_AGENT_CLIENT_ID. " +
      "The /oauth2 device-grant routes are mounted unconditionally; without it " +
      "there is nothing to validate a presented client_id against. Set " +
      "AGENT_OAUTH_CLIENT_ID_OPTIONAL=true to boot with the agent surface " +
      "disabled instead.",
  );
}

/**
 * Fail-closed client check for a single request. Returns a response when the
 * client_id is unacceptable, `null` when it is the registered agent client.
 */
function rejectUnknownClient(
  env: { COGNITO_AGENT_CLIENT_ID?: string | undefined },
  clientId: string,
): Response | null {
  const expectedClientId = env.COGNITO_AGENT_CLIENT_ID;
  if (!expectedClientId) {
    // Unset ⇒ no client is registered ⇒ no client is valid. Previously this
    // branch accepted every client_id.
    return jsonResponse(
      {
        error: "invalid_client",
        error_description: "No agent client is registered on this deployment",
      },
      400,
      env,
    );
  }
  if (clientId !== expectedClientId) {
    return jsonResponse(
      { error: "invalid_client", error_description: "Unknown client_id" },
      400,
      env,
    );
  }
  return null;
}

async function readForm(request: Request): Promise<Record<string, string>> {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    const out: Record<string, string> = {};
    for (const part of new URLSearchParams(text).entries()) {
      out[part[0]] = part[1];
    }
    return out;
  }
  if (ct.includes("application/json")) {
    return (await request.json()) as Record<string, string>;
  }
  return {};
}


export const oauthRoutes: Route[] = [
  {
    path: DEVICE_AUTHORIZATION_RE,
    method: "POST",
    handler: async (request, env) => {
      const form = await readForm(request);
      const parsed = DeviceAuthorizationRequestSchema.safeParse(form);
      if (!parsed.success) {
        return jsonResponse(
          { error: "invalid_request", error_description: "client_id is required" },
          400,
          env,
        );
      }

      const rejected = rejectUnknownClient(env, parsed.data.client_id);
      if (rejected) return rejected;

      const verificationUriBase =
        env.AGENT_VERIFICATION_URI_BASE ||
        "https://example.com/agents/authorize";

      const result = await startDeviceAuthorization({
        verificationUriBase,
        // HIGH-4: cap caller-supplied User-Agent at 256 bytes server-side.
        agentLabel: truncateAgentLabel(request.headers.get("user-agent")),
        sourceIp: trustedClientIp(request, env),
      });

      return jsonResponse(result, 200, env);
    },
    middleware: [corsMiddleware()],
    description: "RFC 8628 device authorization request",
  },
  {
    path: TOKEN_RE,
    method: "POST",
    handler: async (request, env) => {
      const form = await readForm(request);
      const parsed = TokenRequestSchema.safeParse(form);
      if (!parsed.success) {
        return jsonResponse(
          {
            error: "unsupported_grant_type",
            error_description: "Only device_code grant type is supported by this adapter",
          },
          400,
          env,
        );
      }

      const rejected = rejectUnknownClient(env, parsed.data.client_id);
      if (rejected) return rejected;

      const result = await pollDeviceAuth(parsed.data.device_code);
      switch (result.outcome) {
        case "ok":
          return jsonResponse(result.tokens, 200, env);
        case "pending":
          return jsonResponse({ error: "authorization_pending" }, 400, env);
        case "slow_down":
          return jsonResponse({ error: "slow_down" }, 400, env);
        case "expired":
          return jsonResponse({ error: "expired_token" }, 400, env);
        case "denied":
          return jsonResponse({ error: "access_denied" }, 400, env);
        case "gone":
          // Per spec, RFC 8628 doesn't formalise read-once gone vs unknown;
          // we use 410 to make the read-once invariant clearly observable.
          return jsonResponse(
            { error: "invalid_grant", error_description: "device_code already used or unknown" },
            410,
            env,
          );
      }
    },
    middleware: [corsMiddleware()],
    description: "RFC 8628 device-code token poll",
  },
];
