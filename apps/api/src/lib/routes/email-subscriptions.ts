/**
 * Email Subscription Routes — anonymous "follow-by-email".
 *
 * The subscribe/confirm/unsubscribe endpoints are UNAUTHENTICATED by design:
 * the actor is an anonymous visitor and authority is carried by action-bound,
 * expiring capability tokens (not a session), so no CSRF token applies. GET
 * confirm/unsubscribe are inert (render a button page); the POST completes the
 * action. The owner-summary endpoint is the one authenticated route.
 *
 * NOTE: mounted in app.ts (PORTED_ROUTE_SETS) + routes/index.ts at integration.
 */

import { EmailSubscriptionHandler } from "../email-subscription-handler.js";
import { featureToggleMiddleware } from "../feature-gate-middleware.js";
import { corsMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import type { Route } from "./types.js";

export const emailSubscriptionRoutes: Route[] = [
  {
    path: "/api/subscriptions/email",
    method: "POST",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const handler = new EmailSubscriptionHandler();
      const response = await handler.handleSubscribe(request, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), featureToggleMiddleware("email_subscriptions_enabled")],
    description: "Request an anonymous email subscription (double opt-in)",
  },
  {
    path: "/api/subscriptions/email/confirm",
    method: "GET",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const handler = new EmailSubscriptionHandler();
      return securityHeaders.addSecurityHeaders(handler.handleConfirmPage(request));
    },
    middleware: [corsMiddleware(), featureToggleMiddleware("email_subscriptions_enabled")],
    description: "Confirmation page (inert; button POSTs to confirm)",
  },
  {
    path: "/api/subscriptions/email/confirm",
    method: "POST",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const handler = new EmailSubscriptionHandler();
      const response = await handler.handleConfirm(request, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), featureToggleMiddleware("email_subscriptions_enabled")],
    description: "Confirm an email subscription (double opt-in)",
  },
  {
    path: "/api/subscriptions/email/unsubscribe",
    method: "GET",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const handler = new EmailSubscriptionHandler();
      return securityHeaders.addSecurityHeaders(handler.handleUnsubscribePage(request));
    },
    middleware: [corsMiddleware(), featureToggleMiddleware("email_subscriptions_enabled")],
    description: "Unsubscribe page (inert; button POSTs to unsubscribe)",
  },
  {
    path: "/api/subscriptions/email/unsubscribe",
    method: "POST",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const handler = new EmailSubscriptionHandler();
      const response = await handler.handleUnsubscribe(request, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), featureToggleMiddleware("email_subscriptions_enabled")],
    description: "Unsubscribe from an email subscription (RFC 8058 one-click)",
  },
  {
    path: "/api/entities/:id/subscribers/summary",
    method: "GET",
    handler: async (request, env, { params }) => {
      const securityHeaders = new SecurityHeaders(env);
      const sessionManager = new SessionManager();
      const handler = new EmailSubscriptionHandler();
      const session = await sessionManager.getSession(request, env.SESSION_SECRET, env);
      if (!session) {
        return securityHeaders.createSecureResponse(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const response = await handler.handleOwnerSummary(params.id!, session, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware(), featureToggleMiddleware("email_subscriptions_enabled")],
    description: "Owner-only subscriber COUNT (never addresses)",
  },
];
