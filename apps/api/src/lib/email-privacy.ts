/**
 * Email Privacy Utilities
 *
 * Hashes emails for privacy-preserving lookups. Plain SHA-256 over the
 * normalized email (lowercased + trimmed). For pepper-based HMAC use
 * `node:crypto` directly at the call site.
 */

import { createHash } from "node:crypto";

/**
 * Hash a normalized email via SHA-256. Returns hex.
 *
 * @throws if `email` is empty / non-string / empty after normalization.
 */
export async function hashEmail(email: string): Promise<string> {
  if (!email || typeof email !== "string") {
    throw new Error("Email must be a non-empty string");
  }

  const normalized = email.toLowerCase().trim();
  if (normalized.length === 0) {
    throw new Error("Email cannot be empty after normalization");
  }

  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
