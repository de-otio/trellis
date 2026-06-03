/**
 * Research pseudonym derivation.
 *
 * Computes `User.anonymousId`, a KEYED pseudonym derived from the user's
 * immutable primary key. See `PSEUDONYM.md` (same directory) for the full
 * design, rotation protocol, and security caveats. Summary:
 *
 *   anonymousId = base64( HMAC-SHA256( key, "trellis.user.pseudonym:" + userId ) )
 *
 *   - DOMAIN SEPARATION: the constant prefix `trellis.user.pseudonym:` scopes
 *     the MAC so the same KMS key reused for another purpose can never collide
 *     with a user pseudonym.
 *   - INPUT is `user.id` (the immutable cuid PK) ONLY. We NEVER hash PII
 *     (email / cognitoSub / handle) — those are mutable and dictionary-
 *     reversible.
 *   - KEY is a KMS HMAC key (HMAC_SHA_256). The key lives in a FIPS HSM and
 *     never leaves KMS; we call `GenerateMac` so plaintext key material is
 *     never in this process. SSM SecureString is only a documented fallback
 *     (see PSEUDONYM.md) — we do NOT default to it here.
 *   - FAIL-SAFE: if no KMS HMAC key id is configured, this THROWS. Callers
 *     that populate anonymousId opportunistically (e.g. account creation)
 *     should catch + skip population rather than fall back to an unkeyed hash.
 *     An unkeyed SHA-256 of the PK would be trivially recomputable by anyone
 *     with the (public-ish) cuid, defeating pseudonymisation.
 */

/** Domain-separation prefix. Changing this re-keys every pseudonym. */
export const PSEUDONYM_DOMAIN = "trellis.user.pseudonym:";

/** Minimal env shape this helper needs. */
export interface PseudonymEnv {
  PSEUDONYM_HMAC_KMS_KEY_ID?: string;
  AWS_REGION?: string;
}

/**
 * Injectable MAC computer. Defaults to the AWS-SDK-backed implementation
 * (dynamic import so the API bundle has no hard `@aws-sdk/client-kms` dep —
 * same pattern as `oauth/envelope-crypto.ts`). Tests override via
 * `setMacComputer`.
 *
 * @returns the raw MAC bytes for `message` under KMS key `kmsKeyId`.
 */
export type MacComputer = (
  kmsKeyId: string,
  region: string,
  message: Uint8Array,
) => Promise<Uint8Array>;

let macComputer: MacComputer = async (kmsKeyId, region, message) => {
  // Dynamic import: only loaded when a KMS key is actually configured.
  const { KMSClient, GenerateMacCommand } = await import("@aws-sdk/client-kms");
  const client = new KMSClient({ region });
  const out = await client.send(
    new GenerateMacCommand({
      KeyId: kmsKeyId,
      MacAlgorithm: "HMAC_SHA_256",
      Message: message,
    }),
  );
  if (!out.Mac) {
    throw new Error("KMS GenerateMac returned no MAC");
  }
  return out.Mac;
};

/** Wire a custom MAC computer (production override / tests). */
export function setMacComputer(fn: MacComputer): void {
  macComputer = fn;
}

/** Reset to the default AWS-SDK-backed computer (test-only). */
export function _resetMacComputerForTest(): void {
  macComputer = async (kmsKeyId, region, message) => {
    const { KMSClient, GenerateMacCommand } = await import("@aws-sdk/client-kms");
    const client = new KMSClient({ region });
    const out = await client.send(
      new GenerateMacCommand({
        KeyId: kmsKeyId,
        MacAlgorithm: "HMAC_SHA_256",
        Message: message,
      }),
    );
    if (!out.Mac) throw new Error("KMS GenerateMac returned no MAC");
    return out.Mac;
  };
}

/**
 * Compute the keyed pseudonym for a user.
 *
 * @param userId the immutable `User.id` (cuid) PK. NEVER pass PII.
 * @param env    resolves the KMS HMAC key id + region.
 * @returns base64 of the HMAC-SHA256 MAC.
 * @throws if no KMS HMAC key id is configured (fail-safe; do not fall back to
 *   an unkeyed hash).
 */
export async function computeAnonymousId(
  userId: string,
  env: PseudonymEnv,
): Promise<string> {
  if (!userId || typeof userId !== "string") {
    throw new Error("computeAnonymousId: userId must be a non-empty string");
  }
  const kmsKeyId = env.PSEUDONYM_HMAC_KMS_KEY_ID;
  if (!kmsKeyId) {
    // Fail-safe: never derive an unkeyed pseudonym.
    throw new Error(
      "PSEUDONYM_HMAC_KMS_KEY_ID not configured: cannot derive a keyed " +
        "anonymousId. Refusing to fall back to an unkeyed hash.",
    );
  }
  const region = env.AWS_REGION || process.env.AWS_REGION || "us-east-1";
  const message = new TextEncoder().encode(PSEUDONYM_DOMAIN + userId);
  const mac = await macComputer(kmsKeyId, region, message);
  return Buffer.from(mac).toString("base64");
}
