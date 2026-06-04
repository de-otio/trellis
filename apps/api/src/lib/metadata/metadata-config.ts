/**
 * Metadata extraction configuration and security limits.
 *
 * IMPORTANT: We store best-effort extracted metadata, but we must never allow
 * unbounded parsing, huge strings/arrays, or accidental PII logging.
 */

export const METADATA_LIMITS = {
  // Overall JSON payload size limit for each metadata blob (post-sanitization)
  MAX_METADATA_SIZE_BYTES: 32 * 1024, // 32KB

  // IPTC keywords limits
  MAX_KEYWORDS: 100,
  MAX_KEYWORD_LENGTH: 64,

  // Generic string truncation
  MAX_STRING_FIELD_LENGTH: 1024,

  // Extraction timeout budget (best-effort). Must be short for Workers.
  EXTRACTION_TIMEOUT_MS: 1500,
} as const;

export type MetadataLimits = typeof METADATA_LIMITS;

export type MetadataTruncationPolicy = "truncate" | "reject";

// Current policy: truncate overlong strings/arrays; reject only if total size exceeds max.
export const METADATA_TRUNCATION_POLICY: MetadataTruncationPolicy = "truncate";
