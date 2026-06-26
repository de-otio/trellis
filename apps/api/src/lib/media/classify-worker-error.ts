/**
 * classify-worker-error.ts — pure functional core, no I/O, no AWS SDK.
 *
 * Classifies any error thrown by a media-processing worker into one of two
 * treatment buckets:
 *
 *   "poison"    — the media itself (or the job payload) is bad. A retry cannot
 *                 help: the same bytes will fail the same way. The caller must
 *                 ACK the message and move the object to moderationStatus=REVIEW
 *                 for human triage, avoiding an infinite DLQ loop.
 *
 *   "retryable" — a transient infrastructure fault: throttling, timeout, 5xx
 *                 upstream, network blip, eventual-consistency AccessDenied.
 *                 The caller lets SQS retry naturally; the 3-strike DLQ + alert
 *                 acts as the upper bound.
 *
 * DEFAULT RULE (documented here — the only operative "fallback threshold"):
 *   When the error is unknown or cannot be classified with confidence, the
 *   function returns "retryable". Rationale: an unrecognised error is more
 *   likely to be a transient infra fault than a permanent media defect, and the
 *   DLQ + 3-strike alert provides a bounded safety net. Silently sending
 *   ambiguous errors to REVIEW would suppress alerts and hide systemic infra
 *   problems. This default is deliberately fail-OPEN for retry but
 *   fail-CLOSED for approval — REVIEW is never returned from this module; the
 *   caller owns the status mapping.
 *
 * PURITY GUARANTEE: this module has no I/O, no AWS SDK dependency, no
 * Date.now/Math.random. node:crypto is NOT used. All inputs produce
 * deterministic outputs.
 */

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

/**
 * The two exclusive classifications.
 *
 * - `"poison"`    — stop retrying; ACK + route to REVIEW.
 * - `"retryable"` — let SQS retry; DLQ + alert is the backstop.
 */
export type ErrorClass = "poison" | "retryable";

// ---------------------------------------------------------------------------
// Known poison error names / codes
// ---------------------------------------------------------------------------

/**
 * Error `.name` values that indicate a permanent media/payload defect.
 * All matching is case-insensitive to absorb capitalisation variance.
 */
const POISON_ERROR_NAMES: ReadonlySet<string> = new Set([
  // Standard decode/parse failures
  "decodeerror",
  "parseerror",
  "formaterror",
  "syntaxerror",
  // Validation failures (payload, schema, duration)
  "validationerror",
  "schemaerror",
  "constrainterror",
  "durationerror",
  "durationcapexceeded",
  // Unsupported / corrupt media
  "unsupportedformaterror",
  "unsupportedmediaerror",
  "unsupportedtypeerror",
  "corrupterror",
  "corruptmediaerror",
  "corruptfileerror",
  "invalidimageerror",
  "invalidmediaerror",
  "invalidpayloaderror",
  "invalidinputerror",
  // AWS Rekognition / media-specific permanent errors
  "invalidimageexception",
  "imagetoolargeexception",
  "invalidparameter",
  "invalidparameterexception",
  "invalids3objectexception",
]);

/**
 * Error `.name` substrings (lowercased) that indicate a poison condition.
 * Used when the name doesn't match exactly but carries an indicative fragment.
 */
const POISON_NAME_FRAGMENTS: readonly string[] = [
  "decode",
  "parse",
  "corrupt",
  "invalid",
  "unsupported",
  "format",
  "duration",
  "validation",
  "schema",
  "constraint",
  "payload",
];

/**
 * Error message substrings (lowercased) that indicate a permanent media fault
 * even when the error name itself is generic (e.g. plain `Error`).
 */
const POISON_MESSAGE_FRAGMENTS: readonly string[] = [
  "decode",
  "corrupt",
  "unsupported format",
  "unsupported media",
  "unsupported type",
  "invalid format",
  "invalid image",
  "invalid media",
  "invalid payload",
  "invalid input",
  "duration cap",
  "duration exceeded",
  "duration limit",
  "too large",
  "cannot parse",
  "failed to parse",
  "failed to decode",
  "not a valid",
  "malformed",
];

// ---------------------------------------------------------------------------
// Known retryable error names / codes
// ---------------------------------------------------------------------------

/**
 * HTTP status codes (from AWS SDK `$metadata.httpStatusCode` or elsewhere) that
 * indicate a transient upstream fault. 4xx codes are explicitly enumerated —
 * only the "transient 4xx" set (429 + 503/504 aliases sometimes arrive as 4xx
 * depending on SDK version) are retryable; all other 4xx are poison (client
 * error, not fixable by retry).
 */
const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([
  429, // Too Many Requests / throttle
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
]);

/**
 * AWS SDK error `.name` values (and common equivalents) that map to transient
 * infrastructure faults. Matched case-insensitively.
 */
const RETRYABLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  // AWS throttle / quota
  "throttlingexception",
  "requestlimitexceeded",
  "provisionedthroughputexceededexception",
  "limitsexceededexception",
  "servicequotaexceededexception",
  "toomanyrequestsexception",
  // AWS transient service errors
  "serviceexception",
  "internalfailure",
  "internalservererror",
  "serviceunavailableexception",
  "serviceunavailable",
  "requesttimeoutexception",
  "requestexpired",
  "requesttimeout",
  // AWS eventual-consistency access issues (retryable — policy propagation lag)
  "accessdeniedexception",
  // Network / socket
  "networkerror",
  "networktimeout",
  "connectionerror",
  "connectionreset",
  "connectiontimeout",
  "sockettimeout",
  "econnreset",
  "econnrefused",
  "enotfound",
  "etimedout",
  "ehostunreach",
  // Generic timeout
  "timeouterror",
  "aborterror",
  "fetcherror",
]);

/**
 * Error message substrings (lowercased) that indicate a transient fault even
 * when the error name is generic.
 */
const RETRYABLE_MESSAGE_FRAGMENTS: readonly string[] = [
  "throttl",
  "rate limit",
  "rate exceeded",
  "quota exceeded",
  "too many requests",
  "timeout",
  "timed out",
  "connection reset",
  "network error",
  "socket hang up",
  "econnreset",
  "econnrefused",
  "service unavailable",
  "temporarily unavailable",
  "try again",
  "please retry",
  "internal server error",
  "502",
  "503",
  "504",
];

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

/**
 * Classifies `err` as `"poison"` or `"retryable"`.
 *
 * - TOTAL: never throws for any input (including null, undefined, non-Error objects).
 * - FAIL-CLOSED on unknown: returns `"retryable"` when the error cannot be
 *   classified with confidence (DLQ + alert is the bounded backstop).
 * - Poison wins over retryable when signals conflict (conservative for serving
 *   safety: a bad payload that also triggers throttle is still bad).
 */
export function classifyWorkerError(err: unknown): ErrorClass {
  // --- 1. Pull every signal we can out of the value, safely. ---

  const name = safeString(extractName(err));
  const message = safeString(extractMessage(err));
  const httpStatus = extractHttpStatus(err);
  const code = safeString(extractCode(err));

  // --- 2. Poison checks (take priority). ---

  if (isPoisonByName(name)) return "poison";
  if (isPoisonByMessage(message)) return "poison";
  // String errors that look like decode/parse failures
  if (typeof err === "string" && isPoisonByMessage(err.toLowerCase())) {
    return "poison";
  }

  // --- 3. Retryable checks. ---

  if (httpStatus !== undefined && RETRYABLE_HTTP_STATUS.has(httpStatus)) {
    return "retryable";
  }
  if (isRetryableByName(name)) return "retryable";
  if (isRetryableByName(code)) return "retryable";
  if (isRetryableByMessage(message)) return "retryable";
  if (typeof err === "string" && isRetryableByMessage(err.toLowerCase())) {
    return "retryable";
  }

  // --- 4. Unknown — default to retryable (see module-level docstring). ---
  return "retryable";
}

// ---------------------------------------------------------------------------
// Predicate helpers
// ---------------------------------------------------------------------------

function isPoisonByName(name: string): boolean {
  if (!name) return false;
  if (POISON_ERROR_NAMES.has(name)) return true;
  // Fragment scan: e.g. "UnsupportedFormatException" contains "format"
  return POISON_NAME_FRAGMENTS.some((f) => name.includes(f));
}

function isPoisonByMessage(msg: string): boolean {
  if (!msg) return false;
  return POISON_MESSAGE_FRAGMENTS.some((f) => msg.includes(f));
}

function isRetryableByName(name: string): boolean {
  if (!name) return false;
  return RETRYABLE_ERROR_NAMES.has(name);
}

function isRetryableByMessage(msg: string): boolean {
  if (!msg) return false;
  return RETRYABLE_MESSAGE_FRAGMENTS.some((f) => msg.includes(f));
}

// ---------------------------------------------------------------------------
// Safe extraction helpers — never throw
// ---------------------------------------------------------------------------

function extractName(err: unknown): unknown {
  if (err === null || err === undefined) return undefined;
  if (typeof err === "object") {
    return (err as Record<string, unknown>).name;
  }
  return undefined;
}

function extractMessage(err: unknown): unknown {
  if (err === null || err === undefined) return undefined;
  if (typeof err === "object") {
    return (err as Record<string, unknown>).message;
  }
  return undefined;
}

function extractCode(err: unknown): unknown {
  if (err === null || err === undefined) return undefined;
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    // AWS SDK v3 uses .code or .__type; normalise both
    return o.code ?? o.__type;
  }
  return undefined;
}

function extractHttpStatus(err: unknown): number | undefined {
  if (err === null || err === undefined) return undefined;
  if (typeof err !== "object") return undefined;
  const o = err as Record<string, unknown>;

  // AWS SDK v3: err.$metadata.httpStatusCode
  const meta = o.$metadata;
  if (meta !== null && meta !== undefined && typeof meta === "object") {
    const status = (meta as Record<string, unknown>).httpStatusCode;
    if (typeof status === "number") return status;
  }

  // Generic: err.statusCode or err.status
  const statusCode = o.statusCode ?? o.status;
  if (typeof statusCode === "number") return statusCode;

  return undefined;
}

/**
 * Coerce an extracted value to a lowercase string for matching.
 * Returns `""` for anything that cannot be cleanly turned into a string.
 */
function safeString(value: unknown): string {
  if (typeof value === "string") return value.toLowerCase();
  return "";
}
