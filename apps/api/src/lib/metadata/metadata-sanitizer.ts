import { METADATA_LIMITS } from "./metadata-config.js";
import { MetadataValidationError } from "./metadata-errors.js";

export function sanitizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Remove NULs and control chars (keep common whitespace)
  const cleaned = value
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();

  if (!cleaned) return undefined;
  if (cleaned.length <= METADATA_LIMITS.MAX_STRING_FIELD_LENGTH) return cleaned;
  return cleaned.slice(0, METADATA_LIMITS.MAX_STRING_FIELD_LENGTH);
}

export function validateGPS(
  lat: unknown,
  lng: unknown,
): { latitude: number; longitude: number } | undefined {
  if (lat === null || lat === undefined || lng === null || lng === undefined)
    return undefined;
  if (typeof lat !== "number" || typeof lng !== "number") return undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (lat < -90 || lat > 90) return undefined;
  if (lng < -180 || lng > 180) return undefined;
  return { latitude: lat, longitude: lng };
}

export function validateKeywords(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const s = sanitizeString(item);
    if (!s) continue;
    const kw =
      s.length <= METADATA_LIMITS.MAX_KEYWORD_LENGTH
        ? s
        : s.slice(0, METADATA_LIMITS.MAX_KEYWORD_LENGTH);
    out.push(kw);
    if (out.length >= METADATA_LIMITS.MAX_KEYWORDS) break;
  }
  return out.length ? out : undefined;
}

export function validateDate(value: unknown): string | undefined {
  // Accept Date, ISO string, or epoch ms/seconds.
  let d: Date | undefined;

  if (value instanceof Date) d = value;
  else if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) d = parsed;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: treat 10-digit as seconds, 13-digit as ms
    const ms = value < 2_000_000_000 ? value * 1000 : value;
    const parsed = new Date(ms);
    if (!Number.isNaN(parsed.getTime())) d = parsed;
  }

  if (!d) return undefined;

  const min = new Date("1900-01-01T00:00:00.000Z").getTime();
  const max = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).getTime();
  const t = d.getTime();
  if (t < min || t > max) return undefined;

  return new Date(t).toISOString();
}

export function validateMetadataSize(obj: unknown): void {
  try {
    const json = JSON.stringify(obj ?? null);
    const bytes = new TextEncoder().encode(json).byteLength;
    if (bytes > METADATA_LIMITS.MAX_METADATA_SIZE_BYTES) {
      throw new MetadataValidationError(
        "Metadata payload exceeds maximum size",
        {
          code: "size_exceeded",
          issues: { bytes, maxBytes: METADATA_LIMITS.MAX_METADATA_SIZE_BYTES },
        },
      );
    }
  } catch (e) {
    if (e instanceof MetadataValidationError) throw e;
    // If serialization fails, treat as validation failure
    throw new MetadataValidationError(
      "Failed to serialize metadata for size validation",
      {
        issues: String(e),
      },
    );
  }
}
