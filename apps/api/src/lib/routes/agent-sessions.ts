/**
 * User-facing agent session management (T9b-d).
 *
 *   GET  /api/users/me/agent-sessions
 *   POST /api/users/me/agent-sessions/{id}/revoke
 *
 * Backed by the AGENT_REFRESH_TABLE rows written by the device-auth flow.
 */

import {
  getAgentSession,
  listAgentSessions,
  revokeAgentSession,
  type AgentSessionRecord,
  type CognitoRevoker,
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

      const userPoolId = env.COGNITO_USER_POOL_ID;
      if (!userPoolId) {
        return sec.createSecureResponse(
          JSON.stringify({ error: "not_configured" }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }

      const cognito = getCognito();
      const audit = getAudit();
      // Audit emitter wants a Prisma client — supply the standard shape.
      const prisma = createPrisma(env);

      await revokeAgentSession({
        sessionId,
        userPoolId,
        cognitoUsername: session.cognitoSub,
        cognito,
        audit: {
          emit: async (input) => audit.emit(input as never, prisma as never),
        },
        tenantId: session.tenantId,
        actorUserId: auth.userId,
        sourceIp: trustedClientIp(request, env),
      });

      return sec.createSecureResponse(
        JSON.stringify({ status: "revoked" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Revoke an agent session",
  },
];
