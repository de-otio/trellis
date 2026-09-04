/**
 * POST /auth/magic-link — provider-neutral magic-link initiation (WS-3.3).
 *
 * Routes the API's initiate path through the `IdentityProviderPort` behind
 * the `IDENTITY_PROVIDER` flag (default cognito — zero AWS change; the
 * client-driven Amplify CUSTOM_AUTH flow remains untouched, this endpoint is
 * additive).
 *
 * ## Inherited responsibilities (G2 exit report)
 *
 *  - **Per-email rate limit stays in this caller, NOT the port** (S-6): the
 *    same 5-per-900s policy the create-auth-challenge trigger enforces —
 *    now as a token bucket (capacity 5, refill 5/900s), closing G2 F5's
 *    fixed-window boundary-straddle. Fail CLOSED when the limiter backend is
 *    unreachable (sensitive auth surface).
 *  - **Account-enumeration stance (C-13/F10, app layer):** an unknown email
 *    returns the SAME 200 {"status":"sent"} as a known one; the
 *    `unknown_user` reason is logged, never surfaced.
 *  - **The app owns the S-8 email:** when the provider returns a link
 *    (Keycloak, send_email=false), this handler sends the shared template via
 *    the email-provider abstraction. On Cognito the trigger chain already
 *    sent it (`emailSent: true`).
 *
 * ## Redirect-URI containment
 *
 * A caller-supplied `redirect_uri` must sit on the app domain
 * (`https://<APP_DOMAIN>/…`); anything else is rejected 400 before reaching
 * the IdP. The IdP's exact-match client registration (G2 C-12) remains the
 * hard gate — this is defense-in-depth, not the boundary.
 */

import type { Env } from "../../env.js";
import {
  IdentityProviderError,
  type IdentityProviderPort,
} from "@de-otio/saas-foundation/identity";
import {
  createEmailProvider,
  emailProviderConfigFromEnv,
  type EmailSendOptions,
} from "../email-provider.js";
import { getLogger } from "../logger.js";
import { buildRateLimitResponse, type RateLimiter } from "../rate-limit.js";
import { getIdentityProvider } from "./identity-provider.js";
import { buildMagicLinkEmail } from "./magic-link-email.js";

/** Same policy the Cognito create-auth-challenge trigger enforces (S-6). */
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 900; // 15 minutes

/** Link validity — matches today's 5-minute magic-link TTL (G2 S-5). */
const LINK_EXPIRATION_SECONDS = 300;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
/** Sane bound on the OAuth passthrough params (state/nonce/code_challenge). */
const MAX_PARAM_LENGTH = 512;

type SendEmailFn = (options: EmailSendOptions) => Promise<unknown>;

let emailSenderOverride: SendEmailFn | null = null;

/** Test seam: inject the email sender (pass null to reset). */
export function __setMagicLinkEmailSenderForTest(fn: SendEmailFn | null): void {
  emailSenderOverride = fn;
}

function defaultSendEmail(options: EmailSendOptions): Promise<unknown> {
  const provider = createEmailProvider(emailProviderConfigFromEnv(process.env));
  return provider.sendEmail(options);
}

interface InitiateBody {
  email?: unknown;
  redirect_uri?: unknown;
  state?: unknown;
  nonce?: unknown;
  code_challenge?: unknown;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function optionalParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PARAM_LENGTH
    ? value
    : undefined;
}

/**
 * Handle POST /auth/magic-link. `corsHeaders` are merged into every response
 * (the caller owns CORS policy).
 */
export async function handleMagicLinkInitiate(
  request: Request,
  env: Env,
  rateLimiter: RateLimiter,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const logger = getLogger();

  let body: InitiateBody;
  try {
    body = (await request.json()) as InitiateBody;
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" }, corsHeaders);
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return jsonResponse(400, { error: "A valid email is required" }, corsHeaders);
  }

  // ── Per-email rate limit (G2 inherited, S-6; token bucket closes F5) ──────
  // Fail CLOSED: if the limiter backend is unreachable we refuse the request
  // rather than allowing an unmetered email-sending path.
  let limit: { allowed: boolean; resetAt: number; retryAfter?: number };
  try {
    limit = await rateLimiter.checkRateLimitKVStrict(
      env,
      request,
      "/auth/magic-link",
      RATE_LIMIT_MAX,
      RATE_LIMIT_WINDOW_SECONDS,
      undefined,
      email,
    );
  } catch (err) {
    logger.error("magic-link.rate_limit_unavailable", err);
    return jsonResponse(503, { error: "Service temporarily unavailable" }, corsHeaders);
  }
  if (!limit.allowed) {
    const retryAfter =
      limit.retryAfter ?? Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000));
    const response = buildRateLimitResponse(RATE_LIMIT_MAX, retryAfter, limit.resetAt);
    for (const [key, value] of Object.entries(corsHeaders)) response.headers.set(key, value);
    return response;
  }

  // ── Redirect-URI containment (defense-in-depth before the IdP's C-12) ─────
  const appDomain = env.APP_DOMAIN;
  const requestedRedirect = optionalParam(body.redirect_uri);
  let redirectUri: string;
  if (requestedRedirect !== undefined) {
    if (!appDomain || !requestedRedirect.startsWith(`https://${appDomain}/`)) {
      return jsonResponse(400, { error: "redirect_uri is not permitted" }, corsHeaders);
    }
    redirectUri = requestedRedirect;
  } else {
    // [F4] Default app verify route. FAIL CLOSED when APP_DOMAIN is unset:
    // sending an empty redirect_uri to the IdP is a misconfiguration, not a
    // valid request (an empty redirect_uri would be rejected by — or, worse,
    // mishandled at — the provider). Refuse with 503 (same posture as the
    // limiter-outage path) rather than proceed. APP_DOMAIN is also enforced at
    // boot when IDENTITY_PROVIDER=keycloak / in prod (env-schema.ts).
    if (!appDomain) {
      logger.error("magic-link.app_domain_unset");
      return jsonResponse(503, { error: "Service temporarily unavailable" }, corsHeaders);
    }
    redirectUri = `https://${appDomain}/auth/verify`;
  }

  const identity: IdentityProviderPort = getIdentityProvider();
  try {
    const result = await identity.initiateMagicLink(email, {
      expirationSeconds: LINK_EXPIRATION_SECONDS,
      redirectUri,
      ...(optionalParam(body.state) !== undefined ? { state: optionalParam(body.state) } : {}),
      ...(optionalParam(body.nonce) !== undefined ? { nonce: optionalParam(body.nonce) } : {}),
      ...(optionalParam(body.code_challenge) !== undefined
        ? { codeChallenge: optionalParam(body.code_challenge) }
        : {}),
    });

    // The app owns the S-8 email: deliver when the provider handed us a link.
    if (result.link !== undefined && !result.emailSent) {
      const brandName = env.EMAIL_BRAND_NAME || "Trellis";
      const content = buildMagicLinkEmail(result.link, brandName);
      // Sender address: env.FROM_EMAIL (mirrors email-subscription-handler.ts)
      // is REQUIRED for a validated-domain provider (Scaleway TEM rejects an
      // unvalidated From domain outright). Only fall back to the
      // `noreply@${APP_DOMAIN}` construction when FROM_EMAIL is unset, so
      // existing deployments that never set it keep booting unchanged.
      const from = env.FROM_EMAIL
        ? `${brandName} <${env.FROM_EMAIL}>`
        : appDomain
          ? `${brandName} <noreply@${appDomain}>`
          : `${brandName} <noreply@localhost>`;
      const send = emailSenderOverride ?? defaultSendEmail;
      await send({
        from,
        to: email,
        subject: content.subject,
        html: content.html,
        text: content.text,
      });
    }

    // Never echo the link. The Cognito continuation handle (Session) goes back
    // to the initiating client — it is unusable without the emailed proof.
    return jsonResponse(
      200,
      { status: "sent", ...(result.handle !== undefined ? { session: result.handle } : {}) },
      corsHeaders,
    );
  } catch (err) {
    if (err instanceof IdentityProviderError && err.reason === "unknown_user") {
      // C-13/F10 enumeration stance: indistinguishable from success.
      logger.info("magic-link.unknown_email", { emailDomain: email.split("@")[1] });
      return jsonResponse(200, { status: "sent" }, corsHeaders);
    }
    logger.error("magic-link.initiate_failed", {
      reason: err instanceof IdentityProviderError ? err.reason : "unexpected",
    });
    return jsonResponse(503, { error: "Service temporarily unavailable" }, corsHeaders);
  }
}
