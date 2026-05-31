/**
 * Domain Validator
 *
 * Validates domain strings for tenant domain claims:
 * - Format: valid hostname, no protocol, no path, lowercase
 * - PSL check: rejects registrable-domain roots and public suffixes themselves
 * - Trellis namespace: rejects *.example.com sub-claims
 *
 * Uses a bundled PSL snapshot to avoid runtime network fetches.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── PSL loader (cached at module init) ─────────────────────────────────────

interface PslData {
  exact: Set<string>;
  wildcards: Set<string>;
  exceptions: Set<string>;
}

let pslCache: PslData | null = null;

function loadPsl(): PslData {
  if (pslCache) return pslCache;

  const snapshotPath = join(import.meta.dirname, "psl-snapshot.txt");
  const lines = readFileSync(snapshotPath, "utf-8").split("\n");

  const exact = new Set<string>();
  const wildcards = new Set<string>();
  const exceptions = new Set<string>();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;

    if (line.startsWith("!")) {
      exceptions.add(line.slice(1).toLowerCase());
    } else if (line.startsWith("*.")) {
      wildcards.add(line.slice(2).toLowerCase());
    } else {
      exact.add(line.toLowerCase());
    }
  }

  pslCache = { exact, wildcards, exceptions };
  return pslCache;
}

// ─── Public suffix check ─────────────────────────────────────────────────────

/**
 * Returns true when `domain` is itself a public suffix or would be "owned"
 * by a wildcard rule (i.e. not enough labels to form a registrable domain).
 *
 * Examples:
 *   isPublicSuffix("com")        → true
 *   isPublicSuffix("co.uk")      → true
 *   isPublicSuffix("example.com") → false  (has a registrable label)
 *   isPublicSuffix("foo.*.ck")   → false   (exception *.ck: !www.ck applies)
 */
function isPublicSuffix(domain: string): boolean {
  const psl = loadPsl();
  const labels = domain.split(".");

  if (psl.exact.has(domain)) return true;

  // Check wildcard: if parent suffix matches a wildcard rule, this domain is
  // itself just the minimum-registrable level — only subdomains of it are
  // "registrable" beyond the PSL boundary.
  if (labels.length >= 2) {
    const parent = labels.slice(1).join(".");
    if (psl.wildcards.has(parent)) {
      if (!psl.exceptions.has(domain)) return true;
    }
  }

  return false;
}

// ─── Basic hostname format check ─────────────────────────────────────────────

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_DOMAIN_LENGTH = 253;

function isValidHostname(domain: string): boolean {
  if (!domain || domain.length > MAX_DOMAIN_LENGTH) return false;
  if (domain.startsWith("-") || domain.endsWith("-")) return false;
  if (domain.startsWith(".") || domain.endsWith(".")) return false;

  const labels = domain.split(".");
  if (labels.length < 2) return false;

  for (const label of labels) {
    if (!LABEL_RE.test(label)) return false;
  }

  const tld = labels[labels.length - 1];
  if (!tld || /^\d+$/.test(tld)) return false;

  return true;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface DomainValidationResult {
  ok: true;
  domain: string;
}

export interface DomainValidationError {
  ok: false;
  code: string;
  message: string;
}

export type DomainValidationOutcome = DomainValidationResult | DomainValidationError;

const TRELLIS_SUFFIX = ".example.com";

/**
 * Validates and normalises a domain string for tenant claiming.
 *
 * Returns `{ ok: true, domain }` with the normalised domain on success,
 * or `{ ok: false, code, message }` with a rejection reason on failure.
 */
export function validateDomain(raw: string): DomainValidationOutcome {
  if (typeof raw !== "string" || !raw) {
    return { ok: false, code: "INVALID_DOMAIN", message: "Domain must be a non-empty string" };
  }

  // Strip leading/trailing whitespace and convert to lowercase.
  // Handle IDN: Node's URL parser supports punycode implicitly via WHATWG URL.
  let domain = raw.trim().toLowerCase();

  // Reject if it looks like a URL.
  if (domain.includes("://") || domain.includes("/") || domain.includes("?")) {
    return { ok: false, code: "INVALID_DOMAIN", message: "Domain must not include a protocol or path" };
  }

  // Strip port if present (e.g. "example.com:8080").
  const colonIdx = domain.indexOf(":");
  if (colonIdx !== -1) {
    domain = domain.slice(0, colonIdx);
  }

  // Attempt IDN normalisation via WHATWG URL.
  try {
    const url = new URL(`http://${domain}`);
    domain = url.hostname;
  } catch {
    return { ok: false, code: "INVALID_DOMAIN", message: "Domain is not a valid hostname" };
  }

  // Check for public suffix before hostname validation so single-label TLDs
  // ("com", "net") return PUBLIC_SUFFIX rather than INVALID_DOMAIN.
  if (isPublicSuffix(domain)) {
    return {
      ok: false,
      code: "PUBLIC_SUFFIX",
      message: "Cannot claim a public suffix domain (e.g. com, co.uk, gmail.com is fine but co.uk is not)",
    };
  }

  if (!isValidHostname(domain)) {
    return { ok: false, code: "INVALID_DOMAIN", message: "Domain is not a valid hostname" };
  }

  // Reject *.example.com sub-claims.
  if (domain.endsWith(TRELLIS_SUFFIX) || domain === "example.com") {
    return {
      ok: false,
      code: "RESERVED_DOMAIN",
      message: "Cannot claim a example.com subdomain",
    };
  }

  return { ok: true, domain };
}
