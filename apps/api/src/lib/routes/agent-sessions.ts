/**
 * User-facing agent session management (T9b-d).
 *
 *   GET  /api/users/me/agent-sessions
 *   POST /api/users/me/agent-sessions/{id}/revoke
 *   POST /api/users/me/agent-sessions/global-sign-out
 *
 * Backed by the AGENT_REFRESH_TABLE rows written by the device-auth flow.
 *
 * D.1 — the two POSTs are deliberately different instruments and are named
 * for it. `…/{id}/revoke` disconnects ONE agent and nothing else.
 * `…/global-sign-out` is the account-compromise button: it signs the caller
 * out of every session they hold, everywhere. The first used to do the second,
 * which made a partner's "disconnect this app" a denial of service on the
 * user's own account.
 */

import {
  adminGlobalSignOutUser,
  getAgentSession,
  listAgentSessions,
  revokeAgentSession,
  type AgentSessionRecord,
  type CognitoRevoker,
  type SessionTokenBlocklist,
} from "../oauth/refresh-detection.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { TenantAuditEmitter } from "../audit-composer.js";
import {
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { createPrisma } from "../../db.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { trustedClientIp } from "../net/trusted-client-ip.js";
import { SecurityHeaders } from "../security-headers.js";
import { structuredError, unauthorizedError } from "./errors.js";
import type { Route } from "./types.js";

interface AgentSessionDeps {
  cognito?: CognitoRevoker;
  auditEmitter?: TenantAuditEmitter;
}

let deps: AgentSessionDeps = {};

export function _setAgentSessionDepsForTest(d: AgentSessionDeps): void {
  deps = d;
}

export function _resetAgentSessionDepsForTest(): void {
  deps = {};
}

function getCognito(): CognitoRevoker {
  if (deps.cognito) return deps.cognito;
  const region = process.env.COGNITO_REGION || process.env.AWS_REGION || "us-east-1";
  const client = new CognitoIdentityProviderClient({ region });
  return {
    async globalSignOut(input) {
      await client.send(
        new AdminUserGlobalSignOutCommand({
          UserPoolId: input.userPoolId,
          Username: input.cognitoUsername,
        }),
      );
    },
  };
}

function getAudit(): TenantAuditEmitter {
  return deps.auditEmitter ?? new TenantAuditEmitter();
}

/**
 * The `SESSION_BLOCKLIST_KV` binding, if this deployment has one. Local dev
 * and the unit-test envs bind no KV; `revokeAgentSession` reports that back
 * rather than pretending the token was blocklisted.
 */
function getBlocklist(env: unknown): SessionTokenBlocklist | undefined {
  const kv = (env as { SESSION_BLOCKLIST_KV?: SessionTokenBlocklist } | undefined)
    ?.SESSION_BLOCKLIST_KV;
  return kv && typeof kv.put === "function" ? kv : undefined;
}

function publicShape(rec: AgentSessionRecord): Record<string, unknown> {
  return {
    id: rec.sessionId,
    agentLabel: rec.agentLabel ?? null,
    sourceIp: rec.sourceIp ?? null,
    createdAt: new Date(rec.createdAt * 1000).toISOString(),
    lastUsedAt: new Date(rec.lastUsedAt * 1000).toISOString(),
    status: rec.status,
  };
}

const REVOKE_RE = /^\/api\/users\/me\/agent-sessions\/([^/]+)\/revoke$/;
const GLOBAL_SIGN_OUT_PATH = "/api/users/me/agent-sessions/global-sign-out";

export const agentSessionsRoutes: Route[] = [
  {
    path: "/api/users/me/agent-sessions",
    method: "GET",
    handler: async (request, env) => {
      const sec = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(sec);

      const sessions = await listAgentSessions(auth.userId);
      return sec.createSecureResponse(
        JSON.stringify({ sessions: sessions.map(publicShape) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    middleware: [corsMiddleware()],
    description: "List active agent sessions for the current user",
  },

  {
    // NOTE: this literal path must be registered BEFORE `REVOKE_RE` only if
    // the two could collide. They cannot — `global-sign-out` carries no
    // `/revoke` suffix — but keeping it first documents the intent.
    path: GLOBAL_SIGN_OUT_PATH,
    method: "POST",
    handler: async (request, env) => {
      const sec = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(sec);

      const userPoolId = env.COGNITO_USER_POOL_ID;
      if (!userPoolId) {
        return sec.createSecureResponse(
          JSON.stringify({ error: "not_configured" }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }

      const cognito = getCognito();
      const audit = getAudit();
      const prisma = createPrisma(env);

      // Self-service only: the subject signed out is always the caller's own
      // Cognito sub, never a value taken from the request.
      const result = await adminGlobalSignOutUser({
        userId: auth.userId,
        cognitoUsername: auth.sub,
        userPoolId,
        cognito,
        audit: {
          emit: async (input) => audit.emit(input as never, prisma as never),
        },
        tenantId: auth.activeTenantId,
        actorUserId: auth.userId,
        reason: "user-initiated global sign-out",
        sourceIp: trustedClientIp(request, env),
      });

      return sec.createSecureResponse(
        JSON.stringify({
          status: "signed_out_everywhere",
          agentSessionsRevoked: result.agentSessionsRevoked,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description:
      "Sign the current user out of every session everywhere (account-compromise action)",
  },

  {
    path: REVOKE_RE,
    method: "POST",
    handler: async (request, env, { pathname }) => {
      const sec = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(sec);

      const sessionId = pathname.match(REVOKE_RE)?.[1];
      if (!sessionId) {
        return structuredError(400, {
          error: "INVALID_REQUEST",
          message: "Session ID is required.",
          remediation: "Ensure the session ID is included in the URL path.",
        }, sec);
      }

      const session = await getAgentSession(sessionId);
      if (!session || session.userId !== auth.userId) {
        // 404 — don't reveal cross-user existence.
        return structuredError(404, {
          error: "NOT_FOUND",
          message: "Agent session not found.",
          remediation: "Verify the session ID and ensure it belongs to your account.",
        }, sec);
      }

      const audit = getAudit();
      // Audit emitter wants a Prisma client — supply the standard shape.
      const prisma = createPrisma(env);

      // D.1 — session-scoped. No Cognito call: this must not touch the user's
      // other sessions. `tokenBlocklisted: false` means the session predates
      // `accessTokenHash` or no blocklist KV is bound, so its already-issued
      // access token lives out its (short) TTL; the session row and its
      // refresh jti are gone either way. Reported rather than glossed over.
      const blocklist = getBlocklist(env);
      const { tokenBlocklisted } = await revokeAgentSession({
        sessionId,
        audit: {
          emit: async (input) => audit.emit(input as never, prisma as never),
        },
        tenantId: session.tenantId,
        actorUserId: auth.userId,
        sourceIp: trustedClientIp(request, env),
        ...(blocklist ? { blocklist } : {}),
      });

      return sec.createSecureResponse(
        JSON.stringify({ status: "revoked", tokenBlocklisted }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Revoke a single agent session (does not affect other sessions)",
  },
];
