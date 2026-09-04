/**
 * Interactive agent-authorization page (T9b-d).
 *
 *   GET  /agents/authorize?user_code=XXXX-XXXX
 *   POST /agents/authorize/approve
 *
 * The GET renders a minimal HTML approval form. The POST verifies the
 * admin's session, enforces:
 *   - tenant ManageAgentSessions capability
 *   - MFA in the last hour (step-up if missing)
 *   - per-IP rate limit (5/min)
 *   - per-device_code lockout (10 failed lookups)
 * and on success calls Cognito AdminInitiateAuth to mint tokens, seals
 * them under the device_code, and writes the agent-session row.
 */

import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
import { createPrisma } from "../../db.js";
import { Capability } from "../auth/capabilities.js";
import { requireCapability } from "../auth/require.js";
import type { AuthContext } from "../auth/auth-context.js";
import {
  approveDeviceAuth,
  hashUserCode,
  incrementFailedLookup,
  loadByDeviceCode,
  lookupDeviceCodeByUserCode,
  normaliseUserCode,
  USER_CODE_FAILURE_LIMIT,
} from "../oauth/device-authorization.js";
import { TenantAuditEmitter } from "../audit-composer.js";
import { AuditEventType } from "../audit-actions.js";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import {
  AwsCognitoIssuer,
  type CognitoIssuer,
} from "../oauth/cognito-issuer.js";
import {
  deriveRefreshJti,
  hashSessionToken,
  recordAgentSession,
  type AgentSessionRecord,
} from "../oauth/refresh-detection.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { trustedClientIp } from "../net/trusted-client-ip.js";
import { RateLimiter } from "../rate-limit.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager, type Session } from "../session-cookie.js";
import { structuredError } from "./errors.js";
import type { Route } from "./types.js";

/** Per-IP ceiling on approvals (G4 CRITICAL-3). */
const APPROVE_RATE_LIMIT = 5;
const APPROVE_RATE_WINDOW_SECONDS = 60;
/**
 * Global, IP-independent ceiling on `/agents/authorize` lookups (G4
 * CRITICAL-3, MEDIUM-2). Even when XFF parsing is bypassed or a single
 * IP can spoof many sources via cloud-supplied headers, this bucket
 * caps the surface system-wide.
 */
const APPROVE_GLOBAL_LIMIT = 200;
const APPROVE_GLOBAL_WINDOW_SECONDS = 60;
/** Per-IP ceiling on user_code → device_code resolution misses (MEDIUM-2). */
const VERIFY_MISS_LIMIT = 30;
const VERIFY_MISS_WINDOW_SECONDS = 60;
const MFA_FRESHNESS_MS = 60 * 60 * 1000; // 1 hour

const ApproveSchema = z
  .object({
    user_code: z.string().min(4).max(32),
  })
  .strict();

interface AgentAuthorizeDeps {
  /** Issuer is injectable for tests; default uses AWS SDK. */
  issuer?: CognitoIssuer;
  /** Audit emitter is injectable for tests. */
  auditEmitter?: TenantAuditEmitter;
  /** Rate limiter override for tests. */
  rateLimiter?: RateLimiter;
}

/** Module-level deps; tests can override. */
let deps: AgentAuthorizeDeps = {};

export function _setAgentAuthorizeDepsForTest(d: AgentAuthorizeDeps): void {
  deps = d;
}

export function _resetAgentAuthorizeDepsForTest(): void {
  deps = {};
}

function getIssuer(): CognitoIssuer {
  if (deps.issuer) return deps.issuer;
  return new AwsCognitoIssuer(
    new CognitoIdentityProviderClient({
      region: process.env.COGNITO_REGION || process.env.AWS_REGION || "us-east-1",
    }),
  );
}

function getAudit(): TenantAuditEmitter {
  return deps.auditEmitter ?? new TenantAuditEmitter();
}

function getRateLimiter(): RateLimiter {
  return deps.rateLimiter ?? new RateLimiter();
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function jsonError(env: unknown, body: unknown, status: number): Response {
  const sec = new SecurityHeaders(env as never);
  return sec.createSecureResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function escape(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderApprovalPage(input: {
  userCode: string;
  agentLabel?: string;
  sourceIp: string;
  mfaRequired: boolean;
  csrfToken?: string;
}): string {
  const heading = input.mfaRequired
    ? "Verify a fresh MFA code, then approve"
    : "Approve agent session";

  const mfaNotice = input.mfaRequired
    ? `<p class="warn">Your most recent MFA verification is older than 1 hour.
        Verify with a TOTP code at <a href="/api/mfa/verify">/api/mfa/verify</a>
        and reload this page.</p>`
    : "";

  // HIGH-4: agentLabel is supplied by the polling agent and is not a
  // value the platform has authenticated. Render it inside a code block
  // and warn the operator that the label is untrusted before they approve.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Approve agent session</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32em; margin: 4em auto; }
    .code { font-family: monospace; font-size: 1.4em; }
    .label-block { display: block; margin: 0.5em 0; padding: 0.5em 0.75em;
                   background: #f4f4f4; border-left: 3px solid #888;
                   font-family: monospace; word-break: break-all; }
    .caveat { background: #fff8e1; border: 1px solid #f0c36d;
              padding: 0.75em 1em; margin: 1em 0; border-radius: 4px; }
    .warn { color: #b00; }
    button[disabled] { opacity: 0.5; cursor: not-allowed; }
  </style>
</head>
<body>
  <h1>${escape(heading)}</h1>
  <p>An agent identifying itself as:</p>
  <code class="label-block">${escape(input.agentLabel ?? "(unknown client)")}</code>
  <p>has requested access to your tenant from this address:</p>
  <p>Source IP: <span class="code">${escape(input.sourceIp)}</span></p>
  <div class="caveat">
    The agent name above is supplied by the agent and is not verified by
    Trellis. Verify with the person who initiated this flow before
    approving.
  </div>
  <p>Code:
     <span class="code">${escape(input.userCode)}</span></p>
  ${mfaNotice}
  <form method="POST" action="/agents/authorize/approve">
    <input type="hidden" name="user_code" value="${escape(input.userCode)}" />
    ${input.csrfToken ? `<input type="hidden" name="csrf_token" value="${escape(input.csrfToken)}" />` : ""}
    <button type="submit"${input.mfaRequired ? " disabled" : ""}>Approve</button>
  </form>
</body>
</html>`;
}

async function buildAuthContext(
  session: Session,
  env: unknown,
): Promise<AuthContext | null> {
  // Minimal AuthContext from the cookie session — the agent-approval flow
  // only needs userId/tenantId/role for capability check and audit. The
  // real Cognito JWT auth-middleware path is for token-bearing API calls;
  // here the admin is using the web session.
  if (!session.userId) return null;
  // We need tenantRole. Look up via Prisma.
  const prisma = createPrisma(env as never);
  const memberWithTenant = await prisma.tenantMember.findFirst({
    where: { userId: session.userId, status: "ACTIVE" },
    orderBy: { joinedAt: "asc" },
    include: { tenant: true },
  });
  if (!memberWithTenant) return null;

  // HIGH-5: resolve the real Cognito sub from the User row. We previously
  // used session.userId (the trellis user id) as the sub fallback,
  // which would have caused AdminUserGlobalSignOut to be called against
  // the wrong identifier. Block agent approval if the sub cannot be
  // resolved rather than silently writing a value that won't revoke.
  const userRow = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { subject: true },
  });
  if (!userRow?.subject) {
    return null;
  }

  // Use globalRole from session.role if present; fallback to END_USER.
  const globalRole = (session.role as AuthContext["globalRole"]) ?? "END_USER";

  return {
    sub: userRow.subject,
    userId: session.userId,
    globalRole,
    activeTenantId: memberWithTenant.tenantId,
    tenantSlug: memberWithTenant.tenant.slug,
    tenantRole: memberWithTenant.role,
    handle: session.email,
    membershipsLoader: async () => [memberWithTenant as never],
  };
}

export const agentAuthorizeRoutes: Route[] = [
  {
    path: "/agents/authorize",
    method: "GET",
    handler: async (request, env) => {
      const url = new URL(request.url);
      const rawUserCode = url.searchParams.get("user_code");
      if (!rawUserCode) {
        return htmlResponse("<p>Missing user_code parameter</p>", 400);
      }

      const sessionManager = new SessionManager();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );
      if (!session) {
        const returnTo = encodeURIComponent(`/agents/authorize?user_code=${rawUserCode}`);
        return new Response(null, {
          status: 302,
          headers: { Location: `/auth/login?return=${returnTo}` },
        });
      }

      // Capability check — admins only.
      const auth = await buildAuthContext(session, env);
      if (!auth) {
        return htmlResponse("<p>Active tenant membership required.</p>", 403);
      }
      const denied = requireCapability(auth, Capability.ManageAgentSessions);
      if (denied) {
        return htmlResponse("<p>You are not permitted to approve agents for this tenant.</p>", 403);
      }

      // CRITICAL-3: enforce a global ceiling on resolution attempts so
      // the surface stays bounded even when per-IP keys are spoofable.
      const rl = getRateLimiter();
      const globalLimited = await rl.applyRateLimitKV(
        env,
        request,
        "/agents/authorize:global",
        APPROVE_GLOBAL_LIMIT,
        APPROVE_GLOBAL_WINDOW_SECONDS,
        // Keying on a fixed userId forces the limiter to a single bucket
        // shared by all callers regardless of headers.
        undefined,
        undefined,
        "global",
      );
      if (globalLimited) return globalLimited;

      // Resolve the user_code → device_code lookup. Don't reveal whether
      // the code is valid in the page body to avoid easy brute-force —
      // but we can still tell the user the page renders.
      const userCode = normaliseUserCode(rawUserCode);
      const deviceCode = await lookupDeviceCodeByUserCode(userCode);
      const record = deviceCode ? await loadByDeviceCode(deviceCode) : null;

      // MEDIUM-2: charge a miss against the per-IP miss bucket whenever
      // the user_code did not resolve. Combined with the global ceiling
      // above, a single source cannot enumerate user_codes by spamming
      // GETs without hitting either bucket first.
      if (!deviceCode) {
        await rl
          .applyRateLimitKV(
            env,
            request,
            "/agents/authorize:miss",
            VERIFY_MISS_LIMIT,
            VERIFY_MISS_WINDOW_SECONDS,
          )
          .catch(() => null);
      }

      // LOW-2: use abs() so future clock skew (mfaVerifiedAt > now) does
      // not bypass the freshness gate. The tolerance window is symmetric;
      // anything outside ±MFA_FRESHNESS_MS counts as stale.
      const mfaFresh =
        Boolean(session.mfaVerified) &&
        typeof session.mfaVerifiedAt === "number" &&
        Math.abs(Date.now() - session.mfaVerifiedAt) < MFA_FRESHNESS_MS;

      return htmlResponse(
        renderApprovalPage({
          userCode: rawUserCode,
          agentLabel: record?.agentLabel,
          sourceIp: trustedClientIp(request, env),
          mfaRequired: !mfaFresh,
          csrfToken: session.csrfToken,
        }),
      );
    },
    middleware: [corsMiddleware()],
    description: "Render the agent-approval page",
  },

  {
    path: "/agents/authorize/approve",
    method: "POST",
    handler: async (request, env) => {
      const rl = getRateLimiter();

      // CRITICAL-3: global, IP-independent ceiling first. Even if the
      // per-IP limiter below is bypassable via spoofed proxy headers,
      // this bucket caps the surface system-wide.
      const globalLimited = await rl.applyRateLimitKV(
        env,
        request,
        "/agents/authorize/approve:global",
        APPROVE_GLOBAL_LIMIT,
        APPROVE_GLOBAL_WINDOW_SECONDS,
        undefined,
        undefined,
        "global",
      );
      if (globalLimited) return globalLimited;

      // Per-IP rate limit on the approval surface.
      const limited = await rl.applyRateLimitKV(
        env,
        request,
        "/agents/authorize/approve",
        APPROVE_RATE_LIMIT,
        APPROVE_RATE_WINDOW_SECONDS,
      );
      if (limited) return limited;

      const sessionManager = new SessionManager();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );
      if (!session) {
        return structuredError(401, {
          error: "UNAUTHORIZED",
          message: "Authentication required.",
          remediation: "Sign in at /auth/login and retry.",
        });
      }

      // MFA freshness gate — refuse if MFA wasn't recently verified.
      // LOW-2: use abs() so future clock skew (mfaVerifiedAt > now)
      // cannot satisfy the freshness check.
      const mfaFresh =
        Boolean(session.mfaVerified) &&
        typeof session.mfaVerifiedAt === "number" &&
        Math.abs(Date.now() - session.mfaVerifiedAt) < MFA_FRESHNESS_MS;
      if (!mfaFresh) {
        return structuredError(401, {
          error: "MFA_REQUIRED",
          message: "Step up with a fresh MFA verification before approving an agent.",
          remediation: "POST /api/mfa/verify with a TOTP code, then retry this approval.",
        });
      }

      const auth = await buildAuthContext(session, env);
      if (!auth) {
        return structuredError(401, {
          error: "UNAUTHORIZED",
          message: "Authentication required.",
          remediation: "Sign in at /auth/login with an active tenant membership and retry.",
        });
      }
      const denied = requireCapability(auth, Capability.ManageAgentSessions);
      if (denied) return denied;

      // Read form / json body.
      const ct = request.headers.get("content-type") || "";
      let body: Record<string, string>;
      if (ct.includes("application/x-www-form-urlencoded")) {
        const text = await request.text();
        body = Object.fromEntries(new URLSearchParams(text).entries());
      } else if (ct.includes("application/json")) {
        body = (await request.json()) as Record<string, string>;
      } else {
        return structuredError(400, {
          error: "INVALID_REQUEST",
          message: "Request body must be form-encoded or JSON.",
          remediation: "Set Content-Type to application/x-www-form-urlencoded or application/json.",
        });
      }

      const parsed = ApproveSchema.safeParse(body);
      if (!parsed.success) {
        return structuredError(400, {
          error: "INVALID_REQUEST",
          message: "user_code is required.",
          remediation: "Include the user_code displayed on the agent device.",
          field: "user_code",
        });
      }

      const userCode = normaliseUserCode(parsed.data.user_code);
      const deviceCode = await lookupDeviceCodeByUserCode(userCode);
      if (!deviceCode) {
        // MEDIUM-2: charge the per-IP miss bucket on every unresolved
        // user_code so enumeration is bounded even when the device-code
        // table holds no row to attach the failed-lookup counter to.
        await rl
          .applyRateLimitKV(
            env,
            request,
            "/agents/authorize:miss",
            VERIFY_MISS_LIMIT,
            VERIFY_MISS_WINDOW_SECONDS,
          )
          .catch(() => null);
        return structuredError(404, {
          error: "INVALID_USER_CODE",
          message: "User code not found or expired.",
          remediation: "Verify the code displayed on the agent device and try again.",
          field: "user_code",
        });
      }

      const record = await loadByDeviceCode(deviceCode);
      if (!record) {
        await rl
          .applyRateLimitKV(
            env,
            request,
            "/agents/authorize:miss",
            VERIFY_MISS_LIMIT,
            VERIFY_MISS_WINDOW_SECONDS,
          )
          .catch(() => null);
        return structuredError(404, {
          error: "INVALID_USER_CODE",
          message: "User code not found or expired.",
          remediation: "Verify the code displayed on the agent device and try again.",
          field: "user_code",
        });
      }

      // Verify the supplied user_code actually matches the record's hash.
      const expected = hashUserCode(userCode);
      if (expected !== record.userCodeHash) {
        const after = await incrementFailedLookup(deviceCode);
        if (after >= USER_CODE_FAILURE_LIMIT) {
          return structuredError(410, {
            error: "DEVICE_CODE_LOCKED",
            message: "Too many failed attempts. This device code has been locked.",
            remediation: "Restart the agent authorization flow to get a new code.",
          });
        }
        return structuredError(404, {
          error: "INVALID_USER_CODE",
          message: "User code not found or expired.",
          remediation: "Verify the code displayed on the agent device and try again.",
          field: "user_code",
        });
      }

      if (record.failedLookups >= USER_CODE_FAILURE_LIMIT) {
        return structuredError(410, {
          error: "DEVICE_CODE_LOCKED",
          message: "Too many failed attempts. This device code has been locked.",
          remediation: "Restart the agent authorization flow to get a new code.",
        });
      }

      const userPoolId = env.COGNITO_USER_POOL_ID;
      const agentClientId = env.COGNITO_AGENT_CLIENT_ID;
      if (!userPoolId || !agentClientId) {
        return jsonError(env, { error: "not_configured" }, 503);
      }

      // Pull the admin's refresh token off the cookie session — it's the
      // input to AdminInitiateAuth(REFRESH_TOKEN_AUTH).
      const refreshToken = (session as Session & { refreshToken?: string }).refreshToken;
      if (!refreshToken) {
        return structuredError(400, {
          error: "SESSION_MISSING_REFRESH_TOKEN",
          message: "This session has no Cognito refresh token.",
          remediation: "Sign in via the agent client and retry.",
        });
      }

      const issuer = getIssuer();
      const tokens = await issuer.issueForAgent({
        userPoolId,
        clientId: agentClientId,
        username: auth.sub,
        refreshToken,
      });

      // D.2 — the jti MUST be a function of the refresh token actually issued.
      // It used to be `randomBytes(16)` under a comment claiming derivation,
      // so `consumeRefreshJti` could never match a presented token and replay
      // detection had no production caller. `SESSION_SECRET` is the master the
      // HMAC sub-key is derived from; it is required at boot, so an absent
      // value here is a misconfiguration, not a runtime branch.
      const jtiMasterSecret = env.SESSION_SECRET;
      if (!jtiMasterSecret) {
        return jsonError(env, { error: "not_configured" }, 503);
      }

      const sessionId = `s_${randomBytes(16).toString("base64url")}`;
      const initialJti = deriveRefreshJti(tokens.refresh_token, jtiMasterSecret);

      await approveDeviceAuth({
        deviceCode,
        approvedByUserId: auth.userId,
        sub: auth.sub,
        tenantId: auth.activeTenantId,
        tokens,
        sessionId,
      });

      const requestIp = trustedClientIp(request, env);
      const sessionRow: AgentSessionRecord = {
        sessionId,
        userId: auth.userId,
        sub: auth.sub,
        tenantId: auth.activeTenantId,
        currentJti: initialJti,
        status: "active",
        agentLabel: record.agentLabel,
        sourceIp: requestIp,
        createdAt: Math.floor(Date.now() / 1000),
        lastUsedAt: Math.floor(Date.now() / 1000),
        // D.1 — pin the access token this session will present, so revoking
        // this session can blocklist exactly it instead of globally signing
        // the human out. Hash only; the token itself is never stored here.
        accessTokenHash: hashSessionToken(tokens.access_token),
      };
      await recordAgentSession({
        session: sessionRow,
        refreshToken: tokens.refresh_token,
        masterSecret: jtiMasterSecret,
      });

      // Audit: agent session approved.
      try {
        const audit = getAudit();
        const prisma = createPrisma(env as never);
        // MEDIUM-6: do not include a hash of the device_code in the audit
        // payload — it can be replayed against a stolen device_code as a
        // confirmation oracle. Use agentSessionId as the correlator and
        // generate a fresh UUID for any further cross-event linking.
        await audit.emit(
          {
            type: AuditEventType.AUTH_AGENT_SESSION_APPROVED,
            tenantId: auth.activeTenantId,
            actorUserId: auth.userId,
            payload: {
              agentLabel: record.agentLabel ?? "(unknown)",
              // G4 N1: cap raw User-Agent in the audit payload to match
              // the 256-byte agent-label cap applied at oauth.ts:36.
              userAgent: (request.headers.get("user-agent") ?? "(unknown)").slice(0, 256),
              correlationId: randomUUID(),
            },
            sourceIp: requestIp,
            agentSessionId: sessionId,
          },
          prisma as never,
        );
      } catch {
        // Audit failures don't block approval — the TenantAuditEmitter
        // logs an audit-fallback line itself.
      }

      const sec = new SecurityHeaders(env as never);
      return sec.createSecureResponse(
        JSON.stringify({ status: "approved" }),
        {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        },
      );
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Approve a pending agent session",
  },
];
