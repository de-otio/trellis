/**
 * Inbox HTTP-signature entry point.
 *
 * This module used to carry a SECOND, weaker signature verifier. For a remote
 * keyId it parsed `/users/{username}` out of the URL and did
 * `db.user.findUnique({ where: { username } })` — a LOCAL user — then verified
 * the remote signature against that local user's public key
 * (`dispatchers/user-actor.ts` `getKeyPair`). Two consequences, both bad:
 * legitimate remote federation could never verify, and a remote keyId whose
 * final path segment collided with a local username was verified against our
 * own key material. It also authenticated no body and bounded no date.
 *
 * That path is DELETED. Everything now goes through the single spec-compliant
 * `HttpSignatureService.verifyRequest`, which fetches the remote actor
 * document over TLS through the SSRF-safe fetcher, asserts
 * `publicKey.id === keyId`, requires the signature to cover
 * `(request-target)`, `host`, `date` and `digest`, verifies the digest against
 * the raw body in constant time, and bounds `date` to ±5 minutes.
 *
 * `verifyHttpSignature` is kept as a boolean-returning shim for call sites
 * that only need the yes/no. Anything that goes on to trust `activity.actor`
 * must instead use `verifyInboxRequest`, which returns the authenticated key
 * owner so the actor binding can be enforced.
 */

import type { Env } from "../../../env.js";
import { getLogger } from "../../logger.js";
import {
  HttpSignatureService,
  InMemoryNonceStore,
  type NonceStore,
  type SignatureVerificationResult,
  type VerifyOptions,
} from "../http-signatures.js";

/**
 * Process-wide replay suppression for the inbox.
 *
 * Single-replica scope, like any in-memory store. A multi-replica deployment
 * should inject a shared store via `verifyInboxRequest`'s options; the ±5-min
 * skew window remains the backstop either way.
 */
const inboxNonceStore: NonceStore = new InMemoryNonceStore();

/**
 * Verify an inbound inbox request and return the authenticated identity.
 *
 * On success the result carries `owner` (the actor URI that owns the signing
 * key) and `body` (the exact bytes the digest authenticated). Callers must
 * parse THAT body — not re-read the request — and must pass `owner` to
 * `assertActorBinding` before trusting `activity.actor`.
 *
 * @param request - Incoming request
 * @param env - Environment
 * @param options - Overrides (tests, or a shared nonce store)
 * @returns Verification result
 */
export async function verifyInboxRequest(
  request: Request,
  env: Env,
  options: VerifyOptions = {},
): Promise<SignatureVerificationResult> {
  return HttpSignatureService.verifyRequest(request, env as any, {
    nonceStore: inboxNonceStore,
    ...options,
  });
}

/**
 * Boolean-only wrapper, for call sites that do not need the identity.
 *
 * Prefer {@link verifyInboxRequest}: a bare boolean is what allowed the
 * original spoofing bug, because "the signature verified" was silently treated
 * as "the body's claimed actor is genuine".
 *
 * @param request - Incoming request
 * @param env - Environment
 * @returns True if signature is valid, false otherwise
 */
export async function verifyHttpSignature(
  request: Request,
  env: Env,
): Promise<boolean> {
  const result = await verifyInboxRequest(request, env);
  return result.valid;
}

/**
 * Sign an outgoing request with a local actor's key.
 *
 * Delegates to the shared signer so outbound requests cover the same header
 * set inbound requests are required to cover (`digest` included when there is
 * a body) — we hold ourselves to the bar we hold peers to.
 *
 * @param request - Outgoing request
 * @param env - Environment
 * @param actorUri - Local actor URI to sign as
 * @returns Request with signature headers
 */
export async function signRequest(
  request: Request,
  env: Env,
  actorUri: string,
): Promise<Request> {
  const logger = getLogger();

  try {
    const { UserActorDispatcher } = await import("../dispatchers/user-actor.js");
    const dispatcher = new UserActorDispatcher(env);

    // Signing is the one legitimate use of the LOCAL key lookup: we are
    // proving our own identity, not checking someone else's.
    const keyPair = await dispatcher.getKeyPair(actorUri);
    if (!keyPair) {
      logger.warn("[HTTP Signatures] Key pair not found for signing", {
        actorUri,
      });
      return request; // Return original request if no key
    }

    const body = request.body
      ? Buffer.from(await request.clone().arrayBuffer())
      : undefined;

    const headers = HttpSignatureService.addSignatureHeaders(
      request,
      (keyPair as any).privateKey,
      `${actorUri}#main-key`,
      body && body.length > 0 ? body : undefined,
    );

    return new Request(request.url, {
      method: request.method,
      headers,
      body: body && body.length > 0 ? body : undefined,
    });
  } catch (error) {
    logger.error("[HTTP Signatures] Error signing request", {
      error: (error as Error).message,
      actorUri,
    });
    return request; // Return original request on error
  }
}
