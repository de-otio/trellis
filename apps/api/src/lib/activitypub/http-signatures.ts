/**
 * HTTP Signatures — the ONE verifier.
 *
 * Trellis previously had two divergent HTTP-signature implementations, and
 * that divergence was the root cause of four findings, not a stylistic wart:
 *
 *   - `listeners/http-signatures.ts` resolved a REMOTE keyId to a LOCAL
 *     database user (`db.user.findUnique({ where: { username } })`), so remote
 *     signatures were verified against whatever local username happened to
 *     collide with the path segment. Legitimate federation could never
 *     verify; a local collision verified the wrong key. That module is now a
 *     thin deprecated shim over this one.
 *   - Neither verifier authenticated the BODY. Both reconstructed the
 *     signature string from the header list the *client* supplied, so a
 *     minimal `headers="(request-target)"` was accepted and the JSON payload
 *     was never covered. Capture one valid signature, swap the body freely.
 *   - Neither bounded `date`, so a captured request replayed forever.
 *   - Nothing tied the signing key to the activity's claimed `actor`.
 *
 * What this implementation requires, and refuses without:
 *
 *   1. The signature must COVER `(request-target)`, `host`, `date` and — for
 *      any request with a body — `digest`. A client-chosen header list that
 *      omits one of these is rejected outright.
 *   2. The `Digest` (or RFC 9530 `Content-Digest`) header must match SHA-256
 *      of the RAW body, compared in constant time, BEFORE the signature is
 *      verified. The authenticated bytes are returned to the caller so it
 *      parses exactly what was signed rather than re-reading the request.
 *   3. `date` must be within ±5 minutes, and an optional short-TTL nonce cache
 *      rejects exact replays inside that window.
 *   4. The key is fetched from the REMOTE actor document over TLS (through the
 *      SSRF-safe fetcher), and `publicKey.id` must equal the `keyId`.
 *   5. The key's owner is returned so callers can bind it to `activity.actor`
 *      (see {@link assertActorBinding}).
 *
 * Everything here is gated behind `ACTIVITYPUB_ENABLED`, which is off. None of
 * it is live; all of it must land before federation is ever enabled.
 */

import * as crypto from "crypto";
import { getLogger, Logger } from "../logger.js";

export interface HttpSignatureEnv {
  LOG_LEVEL?: string;
  ACTIVITYPUB_BASE_URL?: string;
  [key: string]: any; // Allow additional properties to be compatible with Env
}

/** Why a verification failed. Surfaced in logs, never to the remote peer. */
export type SignatureFailureReason =
  | "missing-signature"
  | "malformed-signature"
  | "unsupported-algorithm"
  | "missing-covered-header"
  | "missing-digest"
  | "digest-mismatch"
  | "unsupported-digest-algorithm"
  | "missing-date"
  | "stale-date"
  | "replayed"
  | "key-unavailable"
  | "keyid-mismatch"
  | "bad-signature"
  | "error";

export interface SignatureVerificationSuccess {
  readonly valid: true;
  /** The keyId that signed, exactly as presented. */
  readonly keyId: string;
  /**
   * URI of the actor that OWNS the signing key, taken from the fetched actor
   * document (`publicKey.owner`, falling back to the document's own `id`).
   * This — not anything in the request body — is the authenticated identity.
   */
  readonly owner: string;
  /**
   * The exact body bytes the digest authenticated. Callers MUST parse these
   * rather than re-reading the request, so there is no gap between what was
   * verified and what gets processed.
   */
  readonly body: Buffer;
}

export interface SignatureVerificationFailure {
  readonly valid: false;
  readonly reason: SignatureFailureReason;
  readonly detail?: string;
}

export type SignatureVerificationResult =
  | SignatureVerificationSuccess
  | SignatureVerificationFailure;

/** Store for replay suppression. Any TTL-capable KV shape will do. */
export interface NonceStore {
  /** Returns true if `key` was newly recorded, false if already present. */
  add(key: string, ttlSeconds: number): Promise<boolean>;
}

export interface VerifyOptions {
  /** Clock skew tolerance in seconds. Default 300 (±5 minutes). */
  maxSkewSeconds?: number;
  /** Replay suppression. Omitted means "skew window only". */
  nonceStore?: NonceStore;
  /**
   * Require a digest even for a body-less request. Default: required whenever
   * the request carries a body.
   */
  requireDigest?: boolean;
  /** Injected key fetcher (tests). Default: the remote actor document. */
  fetchKey?: (
    keyId: string,
    env: HttpSignatureEnv,
  ) => Promise<{ pem: string; owner: string } | null>;
}

/** Headers whose coverage by the signature is non-negotiable. */
const REQUIRED_COVERED_HEADERS = ["(request-target)", "host", "date"] as const;

const DEFAULT_MAX_SKEW_SECONDS = 300;
const NONCE_TTL_SECONDS = 600;

/**
 * Default in-process nonce store. Adequate for a single replica; a deployment
 * running several should inject a shared (Postgres/KV) store, exactly as the
 * inbox rate limiter does.
 */
export class InMemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>();

  async add(key: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    // Opportunistic sweep; the map only ever holds one skew-window of traffic.
    if (this.seen.size > 10_000) {
      for (const [k, expires] of this.seen) {
        if (expires <= now) this.seen.delete(k);
      }
    }
    const existing = this.seen.get(key);
    if (existing !== undefined && existing > now) return false;
    this.seen.set(key, now + ttlSeconds * 1000);
    return true;
  }
}

export class HttpSignatureService {
  /**
   * Sign outgoing request.
   *
   * Signs `(request-target)`, `host`, `date` and, when a body is supplied,
   * `digest` — matching what {@link verifyRequest} demands, so we hold
   * ourselves to the bar we hold peers to.
   */
  static signRequest(
    method: string,
    path: string,
    host: string,
    privateKey: string,
    keyId: string,
    body?: string | Buffer,
  ): { signature: string; date: string; digest?: string } {
    const date = new Date().toUTCString();

    const covered: string[] = [
      `(request-target): ${method.toLowerCase()} ${path}`,
      `host: ${host}`,
      `date: ${date}`,
    ];
    const headerNames = ["(request-target)", "host", "date"];

    let digest: string | undefined;
    if (body !== undefined) {
      digest = `SHA-256=${crypto
        .createHash("sha256")
        .update(typeof body === "string" ? Buffer.from(body, "utf8") : body)
        .digest("base64")}`;
      covered.push(`digest: ${digest}`);
      headerNames.push("digest");
    }

    const sign = crypto.createSign("RSA-SHA256");
    sign.update(covered.join("\n"));
    sign.end();
    const signature = sign.sign(privateKey, "base64");

    const signatureHeader = [
      `keyId="${keyId}"`,
      'algorithm="rsa-sha256"',
      `headers="${headerNames.join(" ")}"`,
      `signature="${signature}"`,
    ].join(",");

    return { signature: signatureHeader, date, digest };
  }

  /**
   * Add HTTP Signature headers to request.
   */
  static addSignatureHeaders(
    request: Request,
    privateKey: string,
    keyId: string,
    body?: string | Buffer,
  ): Headers {
    const url = new URL(request.url);
    // `(request-target)` is path AND query — that is what peers (and our own
    // verifier) reconstruct; signing the bare path fails at any inbox URL
    // that carries a query string.
    const { signature, date, digest } = this.signRequest(
      request.method,
      `${url.pathname}${url.search}`,
      url.host,
      privateKey,
      keyId,
      body,
    );

    const headers = new Headers(request.headers);
    headers.set("Signature", signature);
    headers.set("Date", date);
    if (digest) headers.set("Digest", digest);

    return headers;
  }

  /**
   * Verify the HTTP Signature on an incoming request.
   *
   * Returns the authenticated key owner and body on success. See the module
   * header for the full list of what must hold.
   */
  static async verifyRequest(
    request: Request,
    env: HttpSignatureEnv,
    options: VerifyOptions = {},
  ): Promise<SignatureVerificationResult> {
    const logger = getLogger();

    try {
      const signatureHeader = request.headers.get("Signature");
      if (!signatureHeader) {
        return fail(logger, "missing-signature", "no Signature header");
      }

      let params: {
        keyId: string;
        algorithm: string;
        headers: string;
        signature: string;
      };
      try {
        params = this.parseSignatureHeader(signatureHeader);
      } catch (error) {
        return fail(
          logger,
          "malformed-signature",
          (error as Error).message,
        );
      }

      const { keyId, algorithm, headers: headerList, signature } = params;

      if (algorithm !== "rsa-sha256") {
        return fail(logger, "unsupported-algorithm", algorithm);
      }

      const coveredHeaders = headerList
        .split(/\s+/)
        .filter(Boolean)
        .map((h) => h.toLowerCase());

      // ---- (1) The client does not get to choose what is covered ----------
      for (const required of REQUIRED_COVERED_HEADERS) {
        if (!coveredHeaders.includes(required)) {
          return fail(
            logger,
            "missing-covered-header",
            `signature does not cover "${required}" (covers: ${coveredHeaders.join(" ")})`,
          );
        }
      }

      // ---- (2) Authenticate the body BEFORE verifying the signature -------
      const body = Buffer.from(await request.clone().arrayBuffer());
      const hasBody = body.length > 0;
      const digestRequired = options.requireDigest ?? hasBody;

      if (digestRequired) {
        if (!coveredHeaders.includes("digest")) {
          return fail(
            logger,
            "missing-covered-header",
            'signature does not cover "digest" — the body would be unauthenticated',
          );
        }
        const digestCheck = this.verifyDigest(request, body);
        if (!digestCheck.ok) {
          return fail(logger, digestCheck.reason, digestCheck.detail);
        }
      }

      // ---- (3) Freshness, then replay suppression -------------------------
      const dateHeader = request.headers.get("date");
      if (!dateHeader) {
        return fail(logger, "missing-date", "no Date header");
      }
      const skewCheck = this.checkDateSkew(
        dateHeader,
        options.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS,
      );
      if (!skewCheck.ok) {
        return fail(logger, skewCheck.reason, skewCheck.detail);
      }

      // ---- (4) The key comes from the REMOTE actor document ---------------
      const fetchKey = options.fetchKey ?? defaultFetchKey;
      let key = await fetchKey(keyId, env);
      if (!key) {
        return fail(logger, "key-unavailable", `keyId=${keyId}`);
      }

      // ---- (5) Verify over the reconstructed string ------------------------
      let signatureString: string;
      try {
        signatureString = this.reconstructSignatureString(
          request,
          coveredHeaders,
        );
      } catch (error) {
        return fail(
          logger,
          "malformed-signature",
          (error as Error).message,
        );
      }

      let isValid = verifySignature(signatureString, key.pem, signature);

      // A peer that rotated its key is refused for as long as its actor
      // document sits in our cache. When the DEFAULT fetcher is in play (a
      // test-injected one has no cache to bust), evict and try exactly once
      // more with a freshly dereferenced key. One retry, never a loop.
      if (!isValid && !options.fetchKey) {
        await invalidateActorCache(keyId);
        const fresh = await defaultFetchKey(keyId, env);
        if (fresh && fresh.pem !== key.pem) {
          key = fresh;
          isValid = verifySignature(signatureString, key.pem, signature);
        }
      }
      if (!isValid) {
        return fail(logger, "bad-signature", `keyId=${keyId}`);
      }

      // ---- (6) Replay suppression, AFTER the signature is proven ----------
      // Recording only authenticated signatures means unverified traffic
      // cannot fill the cache. The signature is the nonce: it is unique per
      // (key, request, timestamp), and an exact replay reproduces it byte for
      // byte. Note this also collapses a genuine duplicate delivery inside the
      // window, which for an inbox is the desired idempotency anyway.
      if (options.nonceStore) {
        const fresh = await options.nonceStore.add(
          `apsig:${crypto.createHash("sha256").update(signature).digest("hex")}`,
          NONCE_TTL_SECONDS,
        );
        if (!fresh) {
          return fail(logger, "replayed", `keyId=${keyId}`);
        }
      }

      return { valid: true, keyId, owner: key.owner, body };
    } catch (error) {
      return fail(logger, "error", (error as Error).message);
    }
  }

  /**
   * Compare SHA-256 of the raw body against the `Digest` / `Content-Digest`
   * header in constant time.
   */
  private static verifyDigest(
    request: Request,
    body: Buffer,
  ):
    | { ok: true }
    | { ok: false; reason: SignatureFailureReason; detail: string } {
    const legacy = request.headers.get("digest");
    const structured = request.headers.get("content-digest");
    const header = legacy ?? structured;
    if (!header) {
      return {
        ok: false,
        reason: "missing-digest",
        detail: "no Digest or Content-Digest header",
      };
    }

    const expected = crypto.createHash("sha256").update(body).digest();

    // `Digest: SHA-256=<base64>` (RFC 3230) — a comma-separated list is legal,
    // so look for the sha-256 member specifically rather than assuming one.
    // `Content-Digest: sha-256=:<base64>:` (RFC 9530) uses byte-sequence
    // delimiters.
    for (const part of header.split(",")) {
      const trimmed = part.trim();
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const alg = trimmed.slice(0, eq).trim().toLowerCase();
      if (alg !== "sha-256" && alg !== "sha256") continue;
      const raw = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^:|:$/g, "");
      const provided = Buffer.from(raw, "base64");
      if (
        provided.length === expected.length &&
        crypto.timingSafeEqual(provided, expected)
      ) {
        return { ok: true };
      }
      return {
        ok: false,
        reason: "digest-mismatch",
        detail: "body does not match the signed digest",
      };
    }

    return {
      ok: false,
      reason: "unsupported-digest-algorithm",
      detail: `no sha-256 member in "${header.slice(0, 120)}"`,
    };
  }

  /** Reject a Date outside the tolerated skew window. */
  private static checkDateSkew(
    dateHeader: string,
    maxSkewSeconds: number,
  ):
    | { ok: true }
    | { ok: false; reason: SignatureFailureReason; detail: string } {
    const parsed = Date.parse(dateHeader);
    if (Number.isNaN(parsed)) {
      return {
        ok: false,
        reason: "missing-date",
        detail: `unparseable Date: ${dateHeader}`,
      };
    }
    const skewSeconds = Math.abs(Date.now() - parsed) / 1000;
    if (skewSeconds > maxSkewSeconds) {
      return {
        ok: false,
        reason: "stale-date",
        detail: `${Math.round(skewSeconds)}s outside the ±${maxSkewSeconds}s window`,
      };
    }
    return { ok: true };
  }

  /**
   * Parse Signature header.
   */
  private static parseSignatureHeader(header: string): {
    keyId: string;
    algorithm: string;
    headers: string;
    signature: string;
  } {
    const params: Record<string, string> = {};
    header.split(",").forEach((param) => {
      const trimmed = param.trim();
      const equalIndex = trimmed.indexOf("=");
      if (equalIndex === -1) {
        throw new Error(`Invalid signature parameter: ${trimmed}`);
      }
      const key = trimmed.substring(0, equalIndex).trim();
      const value = trimmed
        .substring(equalIndex + 1)
        .trim()
        .replace(/^"|"$/g, "");
      params[key] = value;
    });

    if (
      !params.keyId ||
      !params.algorithm ||
      !params.headers ||
      !params.signature
    ) {
      throw new Error("Missing required signature parameters");
    }

    return {
      keyId: params.keyId,
      algorithm: params.algorithm,
      headers: params.headers,
      signature: params.signature,
    };
  }

  /**
   * Reconstruct the signature string from the covered-header list.
   *
   * Note this runs only AFTER the list has been checked to include the
   * mandatory set, so an attacker cannot shrink what is signed.
   */
  private static reconstructSignatureString(
    request: Request,
    coveredHeaders: readonly string[],
  ): string {
    const lines: string[] = [];

    for (const headerName of coveredHeaders) {
      if (headerName === "(request-target)") {
        const url = new URL(request.url);
        lines.push(
          `(request-target): ${request.method.toLowerCase()} ${url.pathname}${url.search}`,
        );
        continue;
      }
      const value = request.headers.get(headerName);
      if (value === null) {
        throw new Error(`Missing required header: ${headerName}`);
      }
      lines.push(`${headerName}: ${value}`);
    }

    return lines.join("\n");
  }
}

/** RSA-SHA256 over the reconstructed string; a malformed key or signature is simply "not valid". */
function verifySignature(
  signatureString: string,
  pem: string,
  signature: string,
): boolean {
  try {
    const verify = crypto.createVerify("RSA-SHA256");
    verify.update(signatureString);
    return verify.verify(pem, signature, "base64");
  } catch {
    return false;
  }
}

/** Drop the cached actor document behind a keyId so the next fetch is fresh. */
async function invalidateActorCache(keyId: string): Promise<void> {
  const actorUri = keyId.split("#")[0];
  if (!actorUri) return;
  const { RemoteFetchService } = await import("./remote-fetch-service.js");
  RemoteFetchService.invalidateCache(actorUri);
}

/**
 * Default key fetcher: dereference the actor document named by the keyId over
 * TLS and take `publicKey.publicKeyPem`.
 *
 * The fetch goes through `RemoteFetchService`, which is https-only, SSRF-
 * guarded, and — since the 2026-09-06 deep pass — refuses any document whose
 * `id` is not the URL it was served from. This function adds the identity
 * rules on top. They exist because the previous version took
 * `publicKey.owner` (falling back to `actor.id`) VERBATIM from the fetched
 * document: an attacker hosting `https://attacker.example/users/evil` could
 * serve `{ id: "https://victim.example/users/admin", publicKey: { id:
 * "<attacker keyId>", owner: "https://victim.example/users/admin",
 * publicKeyPem: <attacker key> } }`, sign with their own key, and the actor
 * binding then compared the victim with the victim. Full impersonation of any
 * actor on any instance, from any instance. The rules:
 *
 *   1. The instance is not on the blocklist. Checked BEFORE the fetch — a
 *      defederated instance must not be able to make us dereference it on
 *      every delivery.
 *   2. `actor.id` equals the URL we dereferenced (the fetcher enforces this;
 *      asserted again here so the rule does not depend on a cache path).
 *   3. `publicKey.id === keyId`.
 *   4. `keyId` and `actor.id` share an origin — a key document cannot vouch
 *      for an actor on another host.
 *   5. `publicKey.owner`, when present, equals `actor.id`. It never CHOOSES
 *      the owner; the owner is `actor.id`, full stop.
 */
async function defaultFetchKey(
  keyId: string,
  env: HttpSignatureEnv,
): Promise<{ pem: string; owner: string } | null> {
  const logger = getLogger();
  const actorUri = keyId.split("#")[0];
  if (!actorUri) return null;

  const { isRemoteUri, isStandaloneModeEnabled } = await import(
    "./standalone-mode.js"
  );

  if (!isRemoteUri(actorUri, env as any)) {
    // A LOCAL keyId on an inbound request is not a legitimate federation
    // pattern — it is someone claiming to be us. The old code path resolved
    // exactly this case against the local user table and verified against our
    // own key; refusing it is the point of the rewrite.
    logger.warn("[HttpSignatureService] Refusing a local keyId on an inbound request", {
      keyId,
    });
    return null;
  }

  // (1) Blocklist before any network I/O.
  const { parseBlockedDomains, isDomainBlocked, instanceDomainOf } =
    await import("./services/abuse-prevention.js");
  const keyDomain = instanceDomainOf(actorUri);
  if (!keyDomain) {
    logger.warn("[HttpSignatureService] keyId has no resolvable host", { keyId });
    return null;
  }
  if (
    isDomainBlocked(
      keyDomain,
      parseBlockedDomains((env as any).ACTIVITYPUB_BLOCKED_DOMAINS),
    )
  ) {
    logger.warn("[HttpSignatureService] Refusing key fetch from a blocked instance", {
      keyId,
      domain: keyDomain,
    });
    return null;
  }

  if (await isStandaloneModeEnabled(env as any)) {
    logger.info(
      "[HttpSignatureService] Rejecting remote signature verification (standalone mode enabled)",
      { actorUri },
    );
    return null;
  }

  const { RemoteFetchService } = await import("./remote-fetch-service.js");
  const actor = (await RemoteFetchService.fetchActor(
    actorUri,
    env as any,
    logger,
  )) as any;
  if (!actor) {
    logger.warn("[HttpSignatureService] Failed to fetch remote actor document", {
      actorUri,
    });
    return null;
  }

  // (2) The document is authoritative only for the URL it came from.
  const actorId = typeof actor.id === "string" ? actor.id : null;
  if (!actorId || !sameUri(actorId, actorUri)) {
    logger.warn("[HttpSignatureService] Actor document id does not match the keyId's actor URI", {
      actorUri,
      actorId,
    });
    return null;
  }

  const publicKey = actor.publicKey;
  if (!publicKey || typeof publicKey !== "object") {
    logger.warn("[HttpSignatureService] Actor document missing publicKey", {
      actorUri,
    });
    return null;
  }

  // (3)
  if (publicKey.id !== keyId) {
    logger.warn("[HttpSignatureService] KeyId mismatch", {
      expected: keyId,
      actual: publicKey.id,
    });
    return null;
  }

  // (4)
  if (!sameOrigin(keyId, actorId)) {
    logger.warn("[HttpSignatureService] keyId is not on the actor's origin", {
      keyId,
      actorId,
    });
    return null;
  }

  // (5) `owner` may confirm the actor; it may never nominate a different one.
  if (
    publicKey.owner !== undefined &&
    (typeof publicKey.owner !== "string" || !sameUri(publicKey.owner, actorId))
  ) {
    logger.warn("[HttpSignatureService] publicKey.owner does not match the actor document", {
      actorId,
      owner: publicKey.owner,
    });
    return null;
  }

  const pem = publicKey.publicKeyPem;
  if (typeof pem !== "string" || pem.length === 0) {
    logger.warn("[HttpSignatureService] Actor publicKey has no publicKeyPem", {
      actorUri,
    });
    return null;
  }

  return { pem, owner: actorId };
}

function fail(
  logger: Logger,
  reason: SignatureFailureReason,
  detail?: string,
): SignatureVerificationFailure {
  logger.warn("[HttpSignatureService] Signature rejected", { reason, detail });
  return { valid: false, reason, detail };
}

/** Outcome of binding an authenticated key owner to a claimed actor. */
export interface ActorBindingResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Bind `keyId → owner → activity.actor` (F1).
 *
 * Verifying a signature only proves *someone holding that key* sent the
 * request. Without this check the inbox then independently trusted
 * `activity.actor` from the body, so an attacker could sign with their own
 * valid key and set `"actor": "https://victim.example/users/admin"` — the
 * activity was stored and processed as the victim.
 *
 * The rule: the signing key's owner must BE the claimed actor. Where an object
 * is carried, its `attributedTo` (or its own origin) must share the actor's
 * origin, so a legitimately-signed activity cannot smuggle in another
 * instance's content.
 */
export function assertActorBinding(
  owner: string,
  activity: unknown,
): ActorBindingResult {
  const act = activity as Record<string, any> | null;
  if (!act || typeof act !== "object") {
    return { ok: false, reason: "activity is not an object" };
  }

  const claimedActor =
    typeof act.actor === "string"
      ? act.actor
      : typeof act.actor?.id === "string"
        ? act.actor.id
        : null;

  if (!claimedActor) {
    return { ok: false, reason: "activity has no resolvable actor" };
  }

  if (!sameUri(owner, claimedActor)) {
    return {
      ok: false,
      reason: `signing key owner ${owner} does not match activity.actor ${claimedActor}`,
    };
  }

  // The embedded object, when present, must not come from a third instance.
  const object = act.object;
  if (object && typeof object === "object") {
    const attributedTo =
      typeof object.attributedTo === "string"
        ? object.attributedTo
        : typeof object.attributedTo?.id === "string"
          ? object.attributedTo.id
          : null;

    if (attributedTo && !sameOrigin(attributedTo, claimedActor)) {
      return {
        ok: false,
        reason: `object.attributedTo ${attributedTo} is not on the actor's origin (${claimedActor})`,
      };
    }

    if (
      typeof object.id === "string" &&
      object.id.length > 0 &&
      !sameOrigin(object.id, claimedActor)
    ) {
      return {
        ok: false,
        reason: `object.id ${object.id} is not on the actor's origin (${claimedActor})`,
      };
    }
  }

  return { ok: true };
}

/** Exact URI equality, ignoring a trailing slash and fragment. */
function sameUri(a: string, b: string): boolean {
  const norm = (s: string) => {
    try {
      const u = new URL(s);
      u.hash = "";
      return `${u.origin}${u.pathname.replace(/\/$/, "")}${u.search}`;
    } catch {
      return s;
    }
  };
  return norm(a) === norm(b);
}

/** Same scheme+host+port. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
