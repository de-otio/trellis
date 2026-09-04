/**
 * Structured error helper for federation-surface 4xx responses.
 *
 * All in-scope federation handlers (tenants, domains, IdP, members,
 * role-mappings, audit, compliance, auth-discover, oauth, agent-authorize,
 * agent-sessions) must use `structuredError` for every 4xx response.
 *
 * Shape:
 *   { error: "CODE_IDENTIFIER", message: "...", remediation: "...", field?: "...",
 *     request_id: "...", docs_url?: "..." }
 *
 * `request_id` and `docs_url` (plan 034, lane C.3) are additive — every
 * existing `{error, message, remediation, field}` consumer keeps working
 * unchanged; nothing about the original four fields' values or presence
 * changed.
 */

import { getRequestContext } from "@de-otio/saas-foundation/request-context";
import { generateRequestId } from "../logger.js";
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

/** Additive envelope fields every `structuredError` response carries. */
export interface ErrorEnvelope extends StructuredError {
  /** Per-request correlator. Always present, never empty. */
  request_id: string;
  /** Present only when the route is `publicSpec` and declares an `operationId`. */
  docs_url?: string;
}

/**
 * Route metadata `structuredError` needs to decide whether to attach
 * `docs_url`. Optional — callers that don't have a `Route` object handy
 * (or whose route isn't public) simply omit it and get `request_id` alone.
 */
export interface ErrorRouteMeta {
  operationId?: string;
  publicSpec?: boolean;
}

/**
 * Resolve the per-request id.
 *
 * Prefers the ambient `RequestContext` (`@de-otio/saas-foundation/request-context`,
 * AsyncLocalStorage-backed — the same mechanism `getLogger()` uses for
 * request-scoped logging elsewhere in this codebase) so that once something
 * enters that scope for an HTTP request, every error on that request
 * reflects the same id its logs do. Nothing in the trellis HTTP entrypoint
 * enters that scope today, so `getRequestContext()` currently always
 * returns `null` in production — the fallback (`generateRequestId()`, the
 * same UUID generator already used ad hoc for audit correlation elsewhere)
 * is what actually runs, and guarantees the field is never empty either way.
 */
function resolveRequestId(): string {
  return getRequestContext()?.requestId ?? generateRequestId();
}

/**
 * Build the anchor into the published spec (`/openapi.json`) for a public
 * operation. Relative and host-free — `structuredError` has no reliable
 * access to the deployment's own origin, and a relative fragment resolves
 * correctly against whatever host served the error.
 */
function buildDocsUrl(operationId: string): string {
  return `/openapi.json#operation/${operationId}`;
}

/**
 * Build a structured 4xx Response.
 *
 * If `securityHeaders` is supplied the response is wrapped with
 * `addSecurityHeaders` before it is returned. Route-level callers that
 * already hold a SecurityHeaders instance can pass it here; handler-level
 * callers that construct an inline Response can omit it.
 *
 * `routeMeta` is optional and additive: pass a route's `{ operationId,
 * publicSpec }` to get `docs_url` attached when both are present. Omit it
 * (the common case today, since no call site is yet wired to its route's
 * metadata) and the response still carries a non-empty `request_id`.
 */
export function structuredError(
  status: number,
  body: StructuredError,
  securityHeaders?: SecurityHeaders,
  routeMeta?: ErrorRouteMeta,
): Response {
  const envelope: ErrorEnvelope = {
    ...body,
    request_id: resolveRequestId(),
  };
  if (routeMeta?.publicSpec && routeMeta.operationId) {
    envelope.docs_url = buildDocsUrl(routeMeta.operationId);
  }
  const response = new Response(JSON.stringify(envelope), {
    status,
    headers: { "content-type": "application/json" },
  });
  if (securityHeaders) {
    return securityHeaders.addSecurityHeaders(response);
  }
  return response;
}

// ── Pre-built factories for the most common codes ──────────────────────────

export function unauthorizedError(
  securityHeaders?: SecurityHeaders,
  routeMeta?: ErrorRouteMeta,
): Response {
  return structuredError(
    401,
    {
      error: "UNAUTHORIZED",
      message: "Authentication required.",
      remediation: "Include a valid Bearer token in the Authorization header and retry.",
    },
    securityHeaders,
    routeMeta,
  );
}

export function forbiddenError(
  message = "You do not have permission to perform this action.",
  securityHeaders?: SecurityHeaders,
  routeMeta?: ErrorRouteMeta,
): Response {
  return structuredError(
    403,
    {
      error: "FORBIDDEN",
      message,
      remediation: "Request a higher-privileged role from your tenant administrator.",
    },
    securityHeaders,
    routeMeta,
  );
}

export function notFoundError(
  resource = "Resource",
  securityHeaders?: SecurityHeaders,
  routeMeta?: ErrorRouteMeta,
): Response {
  return structuredError(
    404,
    {
      error: "NOT_FOUND",
      message: `${resource} not found.`,
      remediation: "Verify the ID in the URL is correct.",
    },
    securityHeaders,
    routeMeta,
  );
}
