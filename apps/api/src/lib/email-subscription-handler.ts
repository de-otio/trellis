/**
 * Email Subscription Handler — anonymous "follow-by-email".
 *
 * Lets a visitor with no account subscribe to a PUBLIC target's posts by email.
 * Security posture (see plan trellis-internal/plans/open-social-web/01-follow-by-email.md):
 *   - Double opt-in: a row is PENDING until confirmed; the confirmed row IS the
 *     consent artifact. Unconfirmed rows self-expire (retentionUntil).
 *   - Email stored encrypted (per-record envelope) + keyed HMAC hash for lookup;
 *     never in plaintext beside domain data. Subscribe-time IP/UA go only through
 *     SecurityEvent (retention-bound), never onto the subscription row.
 *   - Capability tokens are action-bound and nonce-bound; the handler rotates the
 *     row nonce on state change (single-use) and renders ONE generic response for
 *     every confirm/unsubscribe failure (no existence oracle).
 *   - GET confirm/unsubscribe are inert (render a button page); only POST mutates
 *     (email-scanner-prefetch safety).
 *   - Only PUBLIC targets are followable; owners see a COUNT only, never addresses.
 */

import type { Env } from "../env.js";
import { requireEmailSubEncKey, requireEmailSubHmacSecret } from "../env.js";
import type { Session } from "./session-cookie.js";
import { decryptField, encryptField } from "./field-encryption.js";
import {
  hashEmail,
  signToken,
  verifyToken,
  type EmailSubscriptionAction,
} from "./email-subscription-token.js";

type TargetType = "user" | "entity";

const JSON_HEADERS = { "content-type": "application/json" } as const;
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" } as const;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** One identical response for every confirm/unsubscribe failure (no oracle). */
function genericBadRequest(): Response {
  return json({ error: "INVALID" }, 400);
}

function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return request.headers.get("cf-connecting-ip") || "unknown";
}

function clientUserAgent(request: Request): string {
  return request.headers.get("user-agent") || "unknown";
}

/** Minimal inert HTML page whose button POSTs to complete the action. */
function actionPage(actionUrl: string, heading: string, buttonLabel: string): Response {
  const safeUrl = actionUrl.replace(/"/g, "&quot;");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${heading}</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:48px auto;padding:0 24px;color:#1a1a1a;"><h2>${heading}</h2><form method="POST" action="${safeUrl}"><button type="submit" style="display:inline-block;background:#2563eb;color:#fff;padding:14px 28px;border:0;border-radius:8px;font-weight:600;font-size:16px;cursor:pointer;">${buttonLabel}</button></form></body></html>`;
  return new Response(html, { status: 200, headers: HTML_HEADERS });
}

export class EmailSubscriptionHandler {
  /**
   * POST /api/subscriptions/email — request a subscription. Always returns 202
   * on a well-formed request (no existence/duplication oracle); a confirmation
   * email is sent only when the target is real + public and no row exists yet.
   */
  async handleSubscribe(request: Request, env: Env): Promise<Response> {
    let hmacSecret: string;
    let encKey: Buffer;
    try {
      hmacSecret = requireEmailSubHmacSecret(env);
      encKey = requireEmailSubEncKey(env);
    } catch {
      // Feature enabled but secrets not provisioned — misconfiguration, not a
      // client error. Do not leak which secret; generic 500.
      return json({ error: "SERVICE_UNAVAILABLE" }, 500);
    }

    const { z } = await import("zod");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "VALIDATION_ERROR" }, 400);
    }
    const schema = z.object({
      targetType: z.enum(["user", "entity"]),
      targetId: z.string().min(1).max(100),
      email: z.string().email().max(320),
      locale: z.string().min(2).max(35).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return json({ error: "VALIDATION_ERROR" }, 400);
    const { targetType, targetId, email, locale } = parsed.data;

    const emailHash = hashEmail(email, hmacSecret);

    // Rate limits: per-IP, per-target (global), per-email (global — the SEC-9
    // cross-target email-bomb defense). Any breach → uniform 429.
    const { RateLimiter } = await import("./rate-limit.js");
    const limiter = new RateLimiter();
    const cfg = env.emailSubscription;
    const checks: Array<Promise<{ allowed: boolean }>> = [
      limiter.checkRateLimitKV(env, request, "email_sub_ip", cfg.ratePerIpPerHour, 3600),
      limiter.checkRateLimitKV(
        env,
        request,
        "email_sub_target",
        cfg.ratePerTargetPerHour,
        3600,
        undefined,
        `t:${targetType}:${targetId}`,
      ),
      limiter.checkRateLimitKV(
        env,
        request,
        "email_sub_email",
        cfg.ratePerEmailPerHour,
        3600,
        undefined,
        emailHash,
      ),
    ];
    const results = await Promise.all(checks);
    if (results.some((r) => !r.allowed)) {
      return json({ error: "RATE_LIMITED" }, 429);
    }

    const { createPrisma } = await import("../db.js");
    const db = createPrisma(env);

    // Resolve the target's tenant + public-followability. A missing or
    // non-public target yields a silent 202 (no oracle, no email).
    const resolved = await this.resolveTarget(db, targetType, targetId);
    if (!resolved) return json({ status: "accepted" }, 202);

    // Only create + send when no row exists for (tenant,target,emailHash).
    // If one already exists in ANY state, stay silent (prevents re-send
    // amplification and preserves suppression tombstones).
    const existing = await db.emailSubscription.findUnique({
      where: {
        tenantId_targetType_targetId_emailHash: {
          tenantId: resolved.tenantId,
          targetType,
          targetId,
          emailHash,
        },
      },
    });
    if (existing) return json({ status: "accepted" }, 202);

    const { randomUUID, randomBytes } = await import("node:crypto");
    const tokenNonce = randomBytes(18).toString("base64url");
    const id = randomUUID();
    const now = Date.now();
    const retentionUntil = new Date(now + cfg.pendingTtlHours * 3600_000);

    await db.emailSubscription.create({
      data: {
        id,
        tenantId: resolved.tenantId,
        targetType,
        targetId,
        emailHash,
        emailEnc: encryptField(email, encKey),
        tokenNonce,
        status: "PENDING",
        locale: locale ?? null,
        retentionUntil,
      },
    });

    // Sanctioned retention-bound path for the subscribe-time client IP/UA.
    await this.logSubscribeEvent(request, env, resolved.tenantId, targetType, targetId);

    // Send the double-opt-in confirmation email (best-effort; a send failure
    // must not turn the uniform 202 into an oracle).
    try {
      await this.sendConfirmationEmail({
        request,
        env,
        email,
        subId: id,
        nonce: tokenNonce,
        hmacSecret,
        targetLabel: resolved.label,
        locale,
      });
    } catch {
      // swallow — the PENDING row simply expires if never confirmed.
    }

    return json({ status: "accepted" }, 202);
  }

  /** GET confirm — inert page whose button POSTs (scanner-prefetch safe). */
  handleConfirmPage(request: Request): Response {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? "";
    const actionUrl = `${url.origin}/api/subscriptions/email/confirm?token=${encodeURIComponent(token)}`;
    return actionPage(actionUrl, "Confirm your subscription", "Confirm subscription");
  }

  /** POST confirm — the only mutating step. Uniform 200/400 (no oracle). */
  async handleConfirm(request: Request, env: Env): Promise<Response> {
    const secret = this.tryHmacSecret(env);
    if (!secret) return genericBadRequest();
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const v = verifyToken(token, { expectedAction: "confirm", masterSecret: secret });
    if (!v.valid) return genericBadRequest();

    const { createPrisma } = await import("../db.js");
    const db = createPrisma(env);
    const row = await db.emailSubscription.findUnique({ where: { id: v.subId } });
    if (!row) return genericBadRequest();
    // Nonce must still be current (single-use); idempotent success if already
    // confirmed. Everything else → the same generic 400.
    if (row.status === "CONFIRMED") return json({ status: "ok" }, 200);
    if (row.status !== "PENDING" || row.tokenNonce !== v.nonce) {
      return genericBadRequest();
    }

    const { randomBytes } = await import("node:crypto");
    const cfg = env.emailSubscription;
    await db.emailSubscription.update({
      where: { id: row.id },
      data: {
        status: "CONFIRMED",
        confirmedAt: new Date(),
        tokenNonce: randomBytes(18).toString("base64url"), // rotate: single-use
        // Confirmed rows get a long, env-driven rolling retention so a dead
        // subscription eventually ages out (threshold-secrecy: not a literal).
        retentionUntil: new Date(Date.now() + cfg.confirmedRetentionDays * 86_400_000),
      },
    });
    return json({ status: "ok" }, 200);
  }

  /** GET unsubscribe — inert page whose button POSTs. */
  handleUnsubscribePage(request: Request): Response {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? "";
    const actionUrl = `${url.origin}/api/subscriptions/email/unsubscribe?token=${encodeURIComponent(token)}`;
    return actionPage(actionUrl, "Unsubscribe", "Confirm unsubscribe");
  }

  /**
   * POST unsubscribe — also the RFC 8058 List-Unsubscribe-Post one-click target.
   * Scrubs the encrypted email, keeps the hash as a suppression tombstone.
   */
  async handleUnsubscribe(request: Request, env: Env): Promise<Response> {
    const secret = this.tryHmacSecret(env);
    if (!secret) return genericBadRequest();
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const v = verifyToken(token, { expectedAction: "unsubscribe", masterSecret: secret });
    if (!v.valid) return genericBadRequest();

    const { createPrisma } = await import("../db.js");
    const db = createPrisma(env);
    const row = await db.emailSubscription.findUnique({ where: { id: v.subId } });
    if (!row) return genericBadRequest();
    if (row.status === "UNSUBSCRIBED") return json({ status: "ok" }, 200);
    if (row.tokenNonce !== v.nonce) return genericBadRequest();

    const { randomBytes } = await import("node:crypto");
    const cfg = env.emailSubscription;
    await db.emailSubscription.update({
      where: { id: row.id },
      data: {
        status: "UNSUBSCRIBED",
        unsubscribedAt: new Date(),
        emailEnc: "", // scrub PII; emailHash retained for suppression
        tokenNonce: randomBytes(18).toString("base64url"),
        retentionUntil: new Date(Date.now() + cfg.suppressionDays * 86_400_000),
      },
    });
    return json({ status: "ok" }, 200);
  }

  /**
   * GET /api/entities/:id/subscribers/summary — owner-only aggregate. Returns a
   * COUNT only; email addresses are never exposed through any endpoint.
   */
  async handleOwnerSummary(entityId: string, session: Session, env: Env): Promise<Response> {
    const { createPrisma } = await import("../db.js");
    const db = createPrisma(env);
    const ownership = await db.entityOwnership.findFirst({
      where: { entityId, userId: session.userId },
    });
    if (!ownership) return json({ error: "FORBIDDEN" }, 403);

    const [confirmedCount, pendingCount] = await Promise.all([
      db.emailSubscription.count({
        where: { targetType: "entity", targetId: entityId, status: "CONFIRMED" },
      }),
      db.emailSubscription.count({
        where: { targetType: "entity", targetId: entityId, status: "PENDING" },
      }),
    ]);
    return json({ confirmedCount, pendingCount }, 200);
  }

  // --- internals ---------------------------------------------------------

  private tryHmacSecret(env: Env): string | null {
    try {
      return requireEmailSubHmacSecret(env);
    } catch {
      return null;
    }
  }

  private async resolveTarget(
    db: any,
    targetType: TargetType,
    targetId: string,
  ): Promise<{ tenantId: string; label: string } | null> {
    if (targetType === "entity") {
      const entity = await db.entity.findUnique({ where: { id: targetId } });
      if (!entity) return null;
      return { tenantId: entity.tenantId, label: entity.name ?? "this profile" };
    }
    const user = await db.user.findUnique({ where: { id: targetId } });
    // Only PUBLIC users are followable by an anonymous address, and we need a
    // tenant to scope the row.
    if (!user || user.profileVisibility !== "PUBLIC" || !user.personalTenantId) {
      return null;
    }
    return {
      tenantId: user.personalTenantId,
      label: user.handle ?? user.displayName ?? "this profile",
    };
  }

  private async logSubscribeEvent(
    request: Request,
    env: Env,
    tenantId: string,
    targetType: TargetType,
    targetId: string,
  ): Promise<void> {
    try {
      const { SecurityMonitor } = await import("./security-monitor.js");
      const monitor = new SecurityMonitor();
      await monitor.logSecurityEvent(
        {
          type: "email_subscription_created",
          severity: "low",
          partnerId: tenantId,
          ipAddress: clientIp(request),
          userAgent: clientUserAgent(request),
          success: true,
          metadata: { targetType, targetId },
        },
        env,
      );
    } catch {
      // forensics logging is best-effort; never blocks the subscribe flow.
    }
  }

  private async sendConfirmationEmail(args: {
    request: Request;
    env: Env;
    email: string;
    subId: string;
    nonce: string;
    hmacSecret: string;
    targetLabel: string;
    locale?: string;
  }): Promise<void> {
    const { request, env, email, subId, nonce, hmacSecret, targetLabel, locale } = args;
    const origin = new URL(request.url).origin;
    const cfg = env.emailSubscription;
    const exp = Math.floor(Date.now() / 1000) + cfg.confirmTokenTtlHours * 3600;

    const mkToken = (action: EmailSubscriptionAction) =>
      signToken({ action, subId, nonce, exp }, hmacSecret);
    const confirmUrl = `${origin}/api/subscriptions/email/confirm?token=${encodeURIComponent(mkToken("confirm"))}`;
    const unsubscribeUrl = `${origin}/api/subscriptions/email/unsubscribe?token=${encodeURIComponent(mkToken("unsubscribe"))}`;

    const { renderConfirmEmail } = await import("./email/templates/confirm.js");
    const rendered = renderConfirmEmail({ confirmUrl, targetLabel, locale, unsubscribeUrl });

    const { createEmailProvider, emailProviderConfigFromEnv } = await import("./email-provider.js");
    const provider = createEmailProvider(emailProviderConfigFromEnv(process.env));
    // Tracker-free: template carries no pixel/redirect; provider config set has
    // open/click tracking disabled (infra). The unsubscribe link is in-body.
    // FOLLOW-UP: the RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post`
    // headers need `EmailSendOptions.headers` — extend the provider abstraction
    // (all impls) in the digest phase; the one-click path lands with it.
    await provider.sendEmail({
      from: env.FROM_EMAIL || `noreply@${new URL(request.url).host}`,
      to: email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  }
}
