/**
 * Software HMAC-SHA256 MAC computer — the KMS `GenerateMac` fallback
 * (WS-5; redesign 02 §5).
 *
 * Scaleway Key Manager (v1alpha1) offers encrypt/decrypt/generate-data-key
 * but NO GenerateMac equivalent
 * (https://www.scaleway.com/en/developers/api/key-manager — checked
 * 2026-07-20), so on the Scaleway profile the pseudonymization MAC
 * (`lib/pseudonym.ts`) is computed in-process with `node:crypto` HMAC and a
 * key resolved from the secret port. Cryptographically equivalent output;
 * the operational difference — the key is extractable from Secret Manager,
 * unlike a KMS HSM-held key — is a documented deployment-profile property,
 * not a code concern.
 *
 * Decision recorded here (WS-5 build step 4): the Key Manager *envelope*
 * integration (a KekFetcher for `oauth/envelope-crypto.ts` backed by
 * generate-data-key) is DEFERRED — the API surface is still v1alpha1 and
 * `resolveKek()` already supports a static 32-byte KEK via
 * `DEVICE_AUTH_KEK_BASE64`, which the Scaleway profile feeds from Secret
 * Manager at deploy time. Revisit when Key Manager reaches beta/GA.
 *
 * Selection is env-driven (KV_PROVIDER pattern):
 *   PSEUDONYM_MAC_PROVIDER unset/"kms"  → KMS GenerateMac (zero AWS change)
 *   PSEUDONYM_MAC_PROVIDER="software"   → this module, wired at startup via
 *                                         {@link configurePseudonymMacFromEnv}
 * Key sources for software mode (first match wins, fail-closed when none):
 *   PSEUDONYM_HMAC_SECRET_B64   — base64 key (≥ 32 bytes decoded); local/dev
 *   PSEUDONYM_HMAC_SECRET_NAME  — Scaleway Secret Manager secret name,
 *     resolved by name+path via the foundation secrets port
 *     (`resolveScalewaySecret`), scoped by PSEUDONYM_HMAC_SECRET_PATH
 *     (default "/"), SCW_DEFAULT_PROJECT_ID and SCW_REGION (default fr-par).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { resolveScalewaySecret } from "@de-otio/saas-foundation/secrets";

import { setMacComputer, type MacComputer } from "../pseudonym.js";

/** Minimum acceptable HMAC key length (bytes) — matches HMAC-SHA256 output. */
export const MIN_HMAC_KEY_BYTES = 32;

/** Pure primitive: HMAC-SHA256 over `message` with `key`. */
export function softwareHmacSha256(key: Buffer, message: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(message).digest());
}

/**
 * Constant-time MAC comparison. Length mismatch returns false without a
 * timing-dependent byte walk (`timingSafeEqual` requires equal lengths; the
 * length itself is not secret for a fixed-size MAC).
 */
export function macEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Build a {@link MacComputer} backed by in-process HMAC-SHA256. The
 * `kmsKeyId`/`region` parameters of the MacComputer signature are ignored —
 * the key comes from `resolveKey` (typically the secret port, which owns
 * caching/TTL). A short key is rejected on every call (fail-closed even if
 * the secret is rotated to a weak value at runtime).
 */
export function createSoftwareMacComputer(
  resolveKey: () => Promise<Buffer>,
): MacComputer {
  return async (_kmsKeyId, _region, message) => {
    const key = await resolveKey();
    if (key.length < MIN_HMAC_KEY_BYTES) {
      throw new Error(
        `software MAC key too short: ${key.length} bytes (need >= ${MIN_HMAC_KEY_BYTES})`,
      );
    }
    return softwareHmacSha256(key, message);
  };
}

/** Env shape consumed by {@link configurePseudonymMacFromEnv}. */
export interface SoftwareMacEnv {
  PSEUDONYM_MAC_PROVIDER?: string;
  PSEUDONYM_HMAC_SECRET_B64?: string;
  PSEUDONYM_HMAC_SECRET_NAME?: string;
  PSEUDONYM_HMAC_SECRET_PATH?: string;
  SCW_DEFAULT_PROJECT_ID?: string;
  SCW_REGION?: string;
}

/** Injectable deps (tests). */
export interface SoftwareMacDeps {
  /** Secret-byte resolver; defaults to the foundation Scaleway resolver. */
  readonly resolveSecretBytes?: (ref: {
    name: string;
    path: string;
    projectId?: string;
    region: string;
  }) => Promise<Buffer>;
}

/**
 * Startup wiring: when `PSEUDONYM_MAC_PROVIDER=software`, validate the key
 * configuration FAIL-CLOSED and install the software MAC computer via
 * `setMacComputer`. A deployment selecting software mode with no usable key
 * source refuses to start — silently keeping the KMS default (which would
 * then fail on an empty key id) or deriving unkeyed pseudonyms are both
 * unacceptable.
 *
 * Returns true when the software computer was installed, false when the
 * provider selection leaves the KMS default in place (unset/"kms").
 */
export function configurePseudonymMacFromEnv(
  env: SoftwareMacEnv = process.env as SoftwareMacEnv,
  deps: SoftwareMacDeps = {},
): boolean {
  if (env.PSEUDONYM_MAC_PROVIDER !== "software") {
    return false; // KMS default — zero AWS change.
  }

  if (env.PSEUDONYM_HMAC_SECRET_B64) {
    const key = Buffer.from(env.PSEUDONYM_HMAC_SECRET_B64, "base64");
    if (key.length < MIN_HMAC_KEY_BYTES) {
      throw new Error(
        `PSEUDONYM_HMAC_SECRET_B64 must decode to >= ${MIN_HMAC_KEY_BYTES} bytes (got ${key.length})`,
      );
    }
    setMacComputer(createSoftwareMacComputer(async () => key));
    return true;
  }

  if (env.PSEUDONYM_HMAC_SECRET_NAME) {
    const name = env.PSEUDONYM_HMAC_SECRET_NAME;
    const path = env.PSEUDONYM_HMAC_SECRET_PATH || "/";
    const projectId = env.SCW_DEFAULT_PROJECT_ID;
    const region = env.SCW_REGION || "fr-par";
    const resolve =
      deps.resolveSecretBytes ??
      ((ref: { name: string; path: string; projectId?: string; region: string }) =>
        resolveScalewaySecret(ref));
    // The resolver is called per MAC computation; the foundation
    // SecretCache (300s TTL) makes that a memory read on the hot path
    // while still honoring rotation within minutes.
    setMacComputer(
      createSoftwareMacComputer(() => resolve({ name, path, projectId, region })),
    );
    return true;
  }

  throw new Error(
    "PSEUDONYM_MAC_PROVIDER=software but no key source is configured: set " +
      "PSEUDONYM_HMAC_SECRET_B64 (>= 32 bytes, base64) or " +
      "PSEUDONYM_HMAC_SECRET_NAME (+ PSEUDONYM_HMAC_SECRET_PATH / " +
      "SCW_DEFAULT_PROJECT_ID / SCW_REGION) for Secret Manager resolution. " +
      "Refusing to fall back to the KMS path or an unkeyed hash.",
  );
}
