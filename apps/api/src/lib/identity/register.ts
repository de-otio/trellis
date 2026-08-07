/**
 * POST /auth/register — invitation-gated registration on a brokered IdP.
 *
 * The Cognito path has never needed this: the client calls `Amplify.Auth.signUp`
 * and the PreSignUp trigger (`lambda/pre-signup.ts`) runs the invitation gate
 * server-side, with the signup attributes riding along on the trigger event.
 * A brokered IdP has no equivalent hook the client can reach, and the client
 * must never hold the realm admin credential, so registration has to be a
 * server endpoint. Without it a Keycloak deployment can sign EXISTING users in
 * and cannot register new ones at all.
 *
 * ## Order of operations, and why it is this order
 *
 * 1. **Validate the invitation FIRST, before the user exists.** Fail-closed:
 *    `assertInvitationValid` throws on anything but a valid, unused, unexpired
 *    code, and any lookup error propagates rather than admitting. Creating the
 *    user first would leave an orphaned account behind every rejected attempt —
 *    and, worse, that account would then be able to receive a sign-in link.
 * 2. **Create the user with the signup attributes.** They are what the
 *    application provisions from on first sign-in (`jit-claims.ts` →
 *    `provision-confirmed-user.ts`): `invitationCode` drives the invite
 *    consumption, `dateOfBirth` drives the age tier, `guardianEmail` links a
 *    CHILD to a guardian. A registration that omits them does not fail — it
 *    produces an un-gated adult account, which is why they are validated here
 *    rather than trusted later.
 *
 * It deliberately stops there: registration does NOT send the sign-in link.
 * That mirrors the Cognito contract exactly (`Amplify.Auth.signUp` returns and
 * the caller then requests the link), so one client flow drives both providers,
 * and it keeps the per-email sign-in rate limit governing link sends in one
 * place instead of two.
 *
 * The invitation record is *consumed* at provisioning time, not here — the
 * single writer stays `invitation-presignup-record.ts`. So an abandoned
 * registration does not burn the code.
 *
 * ## Enumeration stance
 *
 * An already-registered email returns exactly what a fresh one does
 * (`200 {"status":"registered"}`), matching `magic-link-initiate.ts`'s C-13/F10
 * posture. The adapter guarantees the existing user is never rewritten, so a
 * replayed registration cannot overwrite someone's date of birth or re-point
 * their guardian.
 *
 * Invitation-code errors ARE surfaced verbatim — the messages are part of the
 * contract the Cognito path already established and clients render them.
 */

import type { Env } from "../../env.js";
import {
  IdentityProviderError,
  type IdentityProviderPort,
} from "@de-otio/saas-foundation/identity";
import type { KvStore } from "@de-otio/saas-foundation/kv";
import { getKvStore } from "../kv/kv-provider.js";
import { getLogger } from "../logger.js";
import { buildRateLimitResponse, type RateLimiter } from "../rate-limit.js";
import { assertInvitationValid } from "./invitation-gate.js";
import { getIdentityProvider } from "./identity-provider.js";

let _invitationStore: KvStore | null = null;

function invitationStore(): KvStore {
  if (_invitationStore === null) _invitationStore = getKvStore("invitations");
  return _invitationStore;
}

/** Test seam: inject a `KvStore` (e.g. `MemoryKvStore`); pass null to reset. */
export function __setInvitationStoreForTest(s: KvStore | null): void {
  _invitationStore = s;
}

/**
 * Registration is cheaper to attempt than a sign-in and creates state, so it
 * gets its own bucket rather than sharing the magic-link budget — a burst of
 * registration attempts must not lock a legitimate user out of signing in.
 */
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_SECONDS = 900;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_CODE_LENGTH = 128;
/** ISO calendar date, `YYYY-MM-DD` — the shape the age tier is computed from. */
const DOB_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Nobody registering is older than this; a typo'd year must not pass. */
const MAX_AGE_YEARS = 120;

interface RegisterBody {
  email?: unknown;
  dateOfBirth?: unknown;
  invitationCode?: unknown;
  guardianEmail?: unknown;
  handle?: unknown;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function str(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value.trim()
    : undefined;
}

/**
 * Parse and sanity-check a `YYYY-MM-DD` date of birth.
 *
 * Rejects the future and the implausibly distant past. Both matter because the
 * value feeds the age tier: a future date would compute as an infant (the most
 * restricted tier, locking a real user out) and a year typo like `0202` would
 * sail through a bare `Date` parse.
 */
export function parseDateOfBirth(raw: string, now: Date): Date | undefined {
  if (!DOB_RE.test(raw)) return undefined;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  // Round-trip guard: `new Date("2025-02-31")` silently becomes March 3.
  if (!parsed.toISOString().startsWith(raw)) return undefined;
  if (parsed.getTime() >= now.getTime()) return undefined;
  const oldest = new Date(now.getTime());
  oldest.setUTCFullYear(oldest.getUTCFullYear() - MAX_AGE_YEARS);
  if (parsed.getTime() < oldest.getTime()) return undefined;
  return parsed;
}

/**
 * Handle POST /auth/register. `corsHeaders` are merged into every response
 * (the caller owns CORS policy).
 */
export async function handleRegister(
  request: Request,
  env: Env,
  rateLimiter: RateLimiter,
  corsHeaders: Record<string, string>,
  now: () => number = Date.now,
): Promise<Response> {
  const logger = getLogger();

  const identity: IdentityProviderPort = getIdentityProvider();
  if (typeof identity.registerUser !== "function") {
    // Cognito: registration is the client's `Amplify.Auth.signUp`, gated by the
    // PreSignUp trigger. Say so plainly rather than 404-ing — a client hitting
    // this on a Cognito deployment is misconfigured, not lost, and a silent
    // failure here would look like a registration that quietly did nothing.
    return jsonResponse(
      501,
      {
        error: "Registration is not handled by this API on the configured identity provider.",
      },
      corsHeaders,
    );
  }

  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" }, corsHeaders);
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return jsonResponse(400, { error: "A valid email is required" }, corsHeaders);
  }

  let limit: { allowed: boolean; resetAt: number; retryAfter?: number };
  try {
    limit = await rateLimiter.checkRateLimitKVStrict(
      env,
      request,
      "/auth/register",
      RATE_LIMIT_MAX,
      RATE_LIMIT_WINDOW_SECONDS,
      undefined,
      email,
    );
  } catch (err) {
    // Fail CLOSED, as the magic-link path does: this creates accounts and sends
    // mail, so an unmetered fallback is worse than an outage.
    logger.error("register.rate_limit_unavailable", err);
    return jsonResponse(503, { error: "Service temporarily unavailable" }, corsHeaders);
  }
  if (!limit.allowed) {
    const retryAfter =
      limit.retryAfter ?? Math.max(1, Math.ceil((limit.resetAt - now()) / 1000));
    const response = buildRateLimitResponse(RATE_LIMIT_MAX, retryAfter, limit.resetAt);
    for (const [key, value] of Object.entries(corsHeaders)) response.headers.set(key, value);
    return response;
  }

  const dobRaw = str(body.dateOfBirth, 32);
  if (!dobRaw) {
    return jsonResponse(
      400,
      { error: "A date of birth (YYYY-MM-DD) is required" },
      corsHeaders,
    );
  }
  const dateOfBirth = parseDateOfBirth(dobRaw, new Date(now()));
  if (!dateOfBirth) {
    return jsonResponse(400, { error: "Invalid date of birth" }, corsHeaders);
  }

  const guardianEmail = str(body.guardianEmail, MAX_EMAIL_LENGTH)?.toLowerCase();
  if (guardianEmail !== undefined && !EMAIL_RE.test(guardianEmail)) {
    return jsonResponse(400, { error: "Invalid guardian email" }, corsHeaders);
  }

  const invitationCode = str(body.invitationCode, MAX_CODE_LENGTH);
  const handle = str(body.handle, 64);

  // ── Invitation gate — BEFORE the user exists (see the header) ─────────────
  try {
    await assertInvitationValid(invitationCode, { store: invitationStore(), now });
  } catch (err) {
    // The gate's messages are the contract the Cognito trigger established and
    // clients surface them ("already been used", "has expired", …).
    return jsonResponse(
      403,
      { error: err instanceof Error ? err.message : "Invalid or expired invitation code." },
      corsHeaders,
    );
  }

  // ── Create, then send the link ────────────────────────────────────────────
  try {
    const result = await identity.registerUser({
      email,
      // emailVerified deliberately left to the port's `false` default — the
      // magic link below is what proves the address.
      attributes: {
        ...(invitationCode !== undefined ? { invitationCode: [invitationCode] } : {}),
        dateOfBirth: [dobRaw],
        ...(guardianEmail !== undefined ? { guardianEmail: [guardianEmail] } : {}),
        ...(handle !== undefined ? { handle: [handle] } : {}),
        signupMethod: ["MAGIC_LINK"],
      },
    });

    if (result === "exists") {
      // Not an error the caller may distinguish (C-13/F10). The existing user
      // is untouched — the adapter fails-not-overwrites — and the response is
      // byte-identical to a fresh registration.
      logger.info("register.email_exists", { emailDomain: email.split("@")[1] });
    }
  } catch (err) {
    logger.error("register.create_failed", {
      reason: err instanceof IdentityProviderError ? err.reason : "unexpected",
    });
    return jsonResponse(503, { error: "Service temporarily unavailable" }, corsHeaders);
  }

  return jsonResponse(200, { status: "registered" }, corsHeaders);
}
