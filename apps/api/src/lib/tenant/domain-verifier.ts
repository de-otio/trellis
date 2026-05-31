/**
 * Domain Verifier
 *
 * Performs DNS TXT record lookups to confirm that a tenant controls a domain.
 *
 * Protocol:
 *   1. Tenant claims a domain → receives a token.
 *   2. Tenant adds TXT record: `_trellis-verify.{domain}` = `trellis-verify={token}`
 *   3. POST …/verify → this module resolves the TXT record and checks for the token.
 *
 * Fail-closed: any DNS error (NXDOMAIN, timeout, network failure) returns
 * { verified: false, reason: "DNS_ERROR" }. The token must match exactly.
 */

import { promises as dns } from "node:dns";

export interface VerifyResult {
  verified: true;
}

export interface VerifyFailure {
  verified: false;
  reason: "TOKEN_MISMATCH" | "NO_RECORDS" | "DNS_ERROR";
}

export type DnsVerifyOutcome = VerifyResult | VerifyFailure;

const TXT_PREFIX = "_trellis-verify.";

/**
 * Resolves the TXT record at `_trellis-verify.{domain}` and checks whether
 * any value equals `trellis-verify={token}` exactly.
 *
 * Uses `dns.promises.resolveTxt` which does not follow HTTP redirects —
 * there is no SSRF vector here.
 */
export async function verifyDomainToken(
  domain: string,
  token: string,
): Promise<DnsVerifyOutcome> {
  const lookupName = `${TXT_PREFIX}${domain}`;
  const expected = `trellis-verify=${token}`;

  let txtRecords: string[][];
  try {
    txtRecords = await dns.resolveTxt(lookupName);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENODATA" || code === "ENOTFOUND") {
      return { verified: false, reason: "NO_RECORDS" };
    }
    return { verified: false, reason: "DNS_ERROR" };
  }

  if (!txtRecords || txtRecords.length === 0) {
    return { verified: false, reason: "NO_RECORDS" };
  }

  // TXT records are returned as arrays of strings (chunks). Join each record's
  // chunks and compare against the expected value.
  for (const chunks of txtRecords) {
    const value = chunks.join("");
    if (value === expected) {
      return { verified: true };
    }
  }

  return { verified: false, reason: "TOKEN_MISMATCH" };
}
