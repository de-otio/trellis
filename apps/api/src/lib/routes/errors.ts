/**
 * Structured error helper for federation-surface 4xx responses.
 *
 * All in-scope federation handlers (tenants, domains, IdP, members,
 * role-mappings, audit, compliance, auth-discover, oauth, agent-authorize,
 * agent-sessions) must use `structuredError` for every 4xx response.
 *
 * Shape:
 *   { error: "CODE_IDENTIFIER", message: "...", remediation: "...", field?: "..." }
 */

import { SecurityHeaders } from "../security-headers.js";

export interface StructuredError {
  /** SCREAMING_SNAKE_CASE machine-readable code. */
  error: string;
  /** Short, human-readable description. */
  message: string;
  /** Actionable guidance — what the caller should do next. */
  remediation: string;
  /** Optional field name for validation errors. */
  field?: string;
}

/**
 * Build a structured 4xx Response.
 *
 * If `securityHeaders` is supplied the response is wrapped with
 * `addSecurityHeaders` before it is returned. Route-level callers that
 * already hold a SecurityHeaders instance can pass it here; handler-level
 * callers that construct an inline Response can omit it.
 */
export function structuredError(
  status: number,
  body: StructuredError,
  securityHeaders?: SecurityHeaders,
): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  if (securityHeaders) {
    return securityHeaders.addSecurityHeaders(response);
  }
  return response;
}

// ── Pre-built factories for the most common codes ──────────────────────────

export function unauthorizedError(securityHeaders?: SecurityHeaders): Response {
  return structuredError(
    401,
    {
      error: "UNAUTHORIZED",
      message: "Authentication required.",
      remediation: "Include a valid Bearer token in the Authorization header and retry.",
    },
    securityHeaders,
  );
}

export function forbiddenError(
  message = "You do not have permission to perform this action.",
  securityHeaders?: SecurityHeaders,
): Response {
  return structuredError(
    403,
    {
      error: "FORBIDDEN",
      message,
      remediation: "Request a higher-privileged role from your tenant administrator.",
    },
    securityHeaders,
  );
}

export function notFoundError(
  resource = "Resource",
  securityHeaders?: SecurityHeaders,
): Response {
  return structuredError(
    404,
    {
      error: "NOT_FOUND",
      message: `${resource} not found.`,
      remediation: "Verify the ID in the URL is correct.",
    },
    securityHeaders,
  );
}
