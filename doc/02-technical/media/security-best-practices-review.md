# Security and Best Practices Review

**Purpose:** Comprehensive security and best practices review of the metadata specification.

**Date:** January 2025  
**Status:** Review Complete

---

## Executive Summary

This review identifies **12 security issues** and **8 best practice improvements** that should be addressed before implementation. The specification is generally well-designed but needs additional input validation, sanitization, and security controls.

### Critical Issues (Must Fix)

1. **Missing input validation** for extracted metadata
2. **No sanitization** of string fields (XSS risk)
3. **No GPS coordinate validation** (injection risk)
4. **No size limits** on metadata JSON (DoS risk)
5. **Missing Zod schemas** for validation

### High Priority Issues (Should Fix)

6. **No rate limiting** on metadata extraction
7. **Missing transaction handling** for database updates
8. **No validation** of IPTC keywords content
9. **Missing size limits** on keywords array

### Best Practice Improvements

10. Enhanced error handling
11. Security logging
12. Performance optimizations

---

## Security Issues

### 1. Missing Input Validation for Extracted Metadata

**Risk Level:** 🔴 **CRITICAL**

**Issue:** The `MetadataExtractor` class does not validate extracted metadata before storing it in the database. Malformed or malicious metadata could cause:

- Database injection (if not properly parameterized)
- JSON parsing errors
- Application crashes

**Current Code:**

```typescript
const exifData = await exifr.parse(bytes, { ... });
// No validation before storing
await db.mediaFile.create({ data: { exifData: JSON.stringify(exifData) } });
```

**Recommendation:**

```typescript
import { z } from 'zod';

const EXIFDataSchema = z.object({
  Make: z.string().max(100).optional(),
  Model: z.string().max(100).optional(),
  Software: z.string().max(200).optional(),
  Orientation: z.number().int().min(1).max(8).optional(),
  ISO: z.number().int().positive().max(1000000).optional(),
  FNumber: z.number().positive().max(100).optional(),
  ExposureTime: z.string().max(50).optional(),
  FocalLength: z.number().positive().max(10000).optional(),
  Flash: z.boolean().optional(),
  WhiteBalance: z.string().max(50).optional(),
  DateTimeOriginal: z.string().datetime().optional(),
  DateTimeDigitized: z.string().datetime().optional(),
  GPSLatitude: z.number().min(-90).max(90).optional(),
  GPSLongitude: z.number().min(-180).max(180).optional(),
  GPSAltitude: z.number().min(-500).max(9000).optional(),
  // ... other fields with appropriate limits
}).passthrough(); // Allow additional fields but validate known ones

// In extractEXIF method:
const rawExifData = await exifr.parse(bytes, { ... });
const validatedExifData = EXIFDataSchema.parse(rawExifData);
return validatedExifData;
```

**Files to Update:**

- `apps/api/src/lib/metadata-extractor.ts`

---

### 2. No Sanitization of String Fields

**Risk Level:** 🔴 **CRITICAL**

**Issue:** String fields from EXIF/IPTC metadata are not sanitized, which could lead to:

- XSS attacks if metadata is displayed in HTML
- SQL injection (if not using parameterized queries)
- Storage of malicious content

**Current Code:**

```typescript
// No sanitization
exifData.Make = rawData.Make; // Could contain malicious content
```

**Recommendation:**

```typescript
import { InputSanitizer } from "./input-sanitizer";

// Sanitize all string fields
if (exifData.Make) {
  exifData.Make = InputSanitizer.sanitizeText(exifData.Make).substring(0, 100);
}
if (exifData.Model) {
  exifData.Model = InputSanitizer.sanitizeText(exifData.Model).substring(
    0,
    100,
  );
}
// ... sanitize all string fields
```

**Files to Update:**

- `apps/api/src/lib/metadata-extractor.ts`

---

### 3. No GPS Coordinate Validation

**Risk Level:** 🔴 **CRITICAL**

**Issue:** GPS coordinates are not validated, which could allow:

- Invalid coordinates causing errors
- Potential injection if coordinates are used in queries
- Privacy violations if coordinates are outside expected ranges

**Current Code:**

```typescript
GPSLatitude: exifData?.GPSLatitude || null, // No validation
```

**Recommendation:**

```typescript
const validateGPS = (lat?: number, lon?: number, alt?: number) => {
  if (lat !== undefined && (lat < -90 || lat > 90 || !isFinite(lat))) {
    throw new Error("Invalid GPS latitude");
  }
  if (lon !== undefined && (lon < -180 || lon > 180 || !isFinite(lon))) {
    throw new Error("Invalid GPS longitude");
  }
  if (alt !== undefined && (alt < -500 || alt > 9000 || !isFinite(alt))) {
    throw new Error("Invalid GPS altitude");
  }
  return { lat, lon, alt };
};

// In extraction methods:
if (exifData.GPSLatitude !== undefined || exifData.GPSLongitude !== undefined) {
  const validated = validateGPS(
    exifData.GPSLatitude,
    exifData.GPSLongitude,
    exifData.GPSAltitude,
  );
  exifData.GPSLatitude = validated.lat;
  exifData.GPSLongitude = validated.lon;
  exifData.GPSAltitude = validated.alt;
}
```

**Files to Update:**

- `apps/api/src/lib/metadata-extractor.ts`
- `apps/api/src/lib/metadata-extractor.ts` (video metadata)

---

### 4. No Size Limits on Metadata JSON

**Risk Level:** 🔴 **CRITICAL**

**Issue:** No limits on the size of metadata JSON stored in the database, which could lead to:

- DoS attacks via extremely large metadata
- Database performance issues
- Memory exhaustion

**Current Code:**

```typescript
exifData: exifData ? JSON.stringify(exifData) : null, // No size limit
```

**Recommendation:**

```typescript
const MAX_METADATA_SIZE = 50 * 1024; // 50KB limit per metadata type

const validateMetadataSize = (metadata: any, type: string): void => {
  const jsonString = JSON.stringify(metadata);
  if (jsonString.length > MAX_METADATA_SIZE) {
    throw new Error(
      `${type} metadata exceeds maximum size of ${MAX_METADATA_SIZE} bytes`,
    );
  }
};

// Before storing:
if (exifData) {
  validateMetadataSize(exifData, "EXIF");
  // ... store
}
```

**Files to Update:**

- `apps/api/src/lib/metadata-extractor.ts`
- `apps/api/src/lib/routes/media.ts` (upload handler)

---

### 5. Missing Zod Schemas for API Validation

**Risk Level:** 🔴 **CRITICAL**

**Issue:** API endpoints do not use Zod schemas for validating metadata visibility updates, which could allow:

- Invalid data types
- Missing required fields
- Type confusion attacks

**Current Code:**

```typescript
const body = await request.json();
const { metadataVisible, locationVisible } = body; // No validation
```

**Recommendation:**

```typescript
import { z } from "zod";
import { validateRequest } from "../validation/validate-request";

const MetadataVisibilitySchema = z
  .object({
    metadataVisible: z.boolean().optional(),
    locationVisible: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.metadataVisible !== undefined || data.locationVisible !== undefined,
    { message: "At least one field must be provided" },
  );

// In endpoint handler:
const validation = await validateRequest(request, MetadataVisibilitySchema);
if (!validation.success) {
  return validation.error;
}
const { metadataVisible, locationVisible } = validation.data;
```

**Files to Update:**

- `apps/api/src/lib/routes/media.ts` (metadata-visibility endpoint)

---

### 6. No Rate Limiting on Metadata Extraction

**Risk Level:** 🟡 **HIGH**

**Issue:** No rate limiting on metadata extraction during upload, which could allow:

- Resource exhaustion attacks
- DoS via rapid uploads with large metadata

**Recommendation:**

```typescript
// In upload handler, before extraction:
const rateLimitResponse = await rateLimiter.applyRateLimitKV(
  env,
  request,
  "/api/media/upload",
  10, // 10 uploads
  60, // per 60 seconds
  session.userId,
);
if (rateLimitResponse) {
  return rateLimitResponse;
}
```

**Files to Update:**

- `apps/api/src/lib/routes/media.ts` (upload handler)

---

### 7. Missing Transaction Handling for Database Updates

**Risk Level:** 🟡 **HIGH**

**Issue:** Database updates for metadata and privacy settings are not wrapped in transactions, which could lead to:

- Data inconsistency
- Partial updates on failure
- Race conditions

**Current Code:**

```typescript
await db.mediaFile.create({
  data: {
    // ... metadata fields
  },
});
// If this fails, previous operations are not rolled back
```

**Recommendation:**

```typescript
await db.$transaction(async (tx) => {
  const media = await tx.mediaFile.create({
    data: {
      // ... basic fields
    },
  });

  // Extract metadata
  const metadata = await extractor.extractAll(fileBuffer, mimeType);

  // Update with metadata in same transaction
  await tx.mediaFile.update({
    where: { id: media.id },
    data: {
      exifData: metadata.exif ? JSON.stringify(metadata.exif) : null,
      iptcData: metadata.iptc ? JSON.stringify(metadata.iptc) : null,
      videoMetadata: metadata.video ? JSON.stringify(metadata.video) : null,
    },
  });
});
```

**Files to Update:**

- `apps/api/src/lib/routes/media.ts` (upload handler)
- `apps/api/src/lib/routes/media.ts` (metadata-visibility endpoint)

---

### 8. No Validation of IPTC Keywords Content

**Risk Level:** 🟡 **HIGH**

**Issue:** IPTC keywords are not validated for:

- Array size limits (DoS)
- Individual keyword length
- Content sanitization
- Duplicate keywords

**Current Code:**

```typescript
Keywords: iptcData.Keywords || [], // No validation
```

**Recommendation:**

```typescript
const MAX_KEYWORDS = 100;
const MAX_KEYWORD_LENGTH = 100;

const validateKeywords = (keywords: any): string[] => {
  if (!Array.isArray(keywords)) {
    return [];
  }

  if (keywords.length > MAX_KEYWORDS) {
    throw new Error(`Maximum ${MAX_KEYWORDS} keywords allowed`);
  }

  return keywords
    .map((k) => {
      if (typeof k !== "string") return null;
      const sanitized = InputSanitizer.sanitizeText(k).trim();
      return sanitized.length > 0 && sanitized.length <= MAX_KEYWORD_LENGTH
        ? sanitized
        : null;
    })
    .filter((k): k is string => k !== null)
    .filter((k, i, arr) => arr.indexOf(k) === i); // Remove duplicates
};

// In extractIPTC:
iptcData.Keywords = validateKeywords(iptcData.Keywords);
```

**Files to Update:**

- `apps/api/src/lib/metadata-extractor.ts`

---

### 9. Missing Size Limits on Keywords Array

**Risk Level:** 🟡 **HIGH**

**Issue:** No limit on the number of keywords, which could cause:

- DoS via extremely large arrays
- Database performance issues
- Memory exhaustion

**Recommendation:**
See Issue #8 above - already addressed in the validation function.

---

### 10. No Date Format Validation

**Risk Level:** 🟠 **MEDIUM**

**Issue:** Date fields are not validated for:

- Valid ISO 8601 format
- Reasonable date ranges (not far in future/past)
- Timezone handling

**Current Code:**

```typescript
DateTimeOriginal: new Date(exifData.DateTimeOriginal).toISOString(),
// No validation if date is valid or reasonable
```

**Recommendation:**

```typescript
const validateDate = (
  dateStr: string | Date,
  fieldName: string,
): string | null => {
  try {
    const date = typeof dateStr === "string" ? new Date(dateStr) : dateStr;

    if (isNaN(date.getTime())) {
      throw new Error(`Invalid date: ${fieldName}`);
    }

    // Reject dates far in future or past
    const now = new Date();
    const minDate = new Date(1900, 0, 1);
    const maxDate = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // 1 year in future

    if (date < minDate || date > maxDate) {
      throw new Error(`Date out of range: ${fieldName}`);
    }

    return date.toISOString();
  } catch (error) {
    return null; // Return null instead of throwing to allow graceful degradation
  }
};

// In extraction:
exifData.DateTimeOriginal = validateDate(
  exifData.DateTimeOriginal,
  "DateTimeOriginal",
);
```

**Files to Update:**

- `apps/api/src/lib/metadata-extractor.ts`

---

### 11. Missing Security Logging

**Risk Level:** 🟠 **MEDIUM**

**Issue:** No logging for security-relevant events:

- Location data access
- Privacy setting changes
- Metadata extraction failures
- Validation failures

**Recommendation:**

```typescript
// In getMediaDetails when location is accessed:
if (
  media.locationVisible &&
  (exifData?.GPSLatitude || videoMetadata?.GPSLatitude)
) {
  logger.info("Location data accessed", {
    userId: session.userId,
    mediaId: mediaId,
    action: "view_location",
    timestamp: new Date().toISOString(),
  });
}

// In metadata visibility update:
logger.info("Metadata visibility updated", {
  userId: session.userId,
  mediaId: mediaId,
  changes: { metadataVisible, locationVisible },
  timestamp: new Date().toISOString(),
});

// In extraction failures:
logger.warn("Metadata extraction failed", {
  userId: session.userId,
  mimeType,
  error: error.message,
  type: "EXIF" | "IPTC" | "VIDEO",
});
```

**Files to Update:**

- `apps/api/src/lib/media-handler.ts`
- `apps/api/src/lib/routes/media.ts`
- `apps/api/src/lib/metadata-extractor.ts`

---

### 12. No Protection Against Metadata Injection

**Risk Level:** 🟠 **MEDIUM**

**Issue:** No protection against malicious metadata that could:

- Contain executable code
- Cause JSON parsing errors
- Exploit application logic

**Recommendation:**

- Use strict JSON parsing with size limits
- Validate all fields against schemas
- Sanitize all string fields
- Use parameterized database queries (already done via Prisma)
- Reject metadata that doesn't match expected structure

**Files to Update:**

- All extraction and storage code

---

## Best Practice Improvements

### 1. Enhanced Error Handling

**Issue:** Error handling could be more granular and informative.

**Recommendation:**

```typescript
class MetadataExtractionError extends Error {
  constructor(
    message: string,
    public readonly type: "EXIF" | "IPTC" | "VIDEO",
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "MetadataExtractionError";
  }
}

// In extraction methods:
try {
  // ... extraction logic
} catch (error: any) {
  if (error instanceof MetadataExtractionError) {
    throw error; // Re-throw our custom errors
  }
  throw new MetadataExtractionError(
    `Failed to extract ${type} metadata`,
    type,
    error,
  );
}
```

---

### 2. Performance Optimization: Parallel Extraction

**Current:** EXIF and IPTC are extracted in parallel (good), but error handling could be better.

**Recommendation:**

```typescript
const [exifResult, iptcResult] = await Promise.allSettled([
  extractor.extractEXIF(fileBuffer, mimeType),
  extractor.extractIPTC(fileBuffer, mimeType),
]);

const exif = exifResult.status === "fulfilled" ? exifResult.value : null;
const iptc = iptcResult.status === "fulfilled" ? iptcResult.value : null;

if (exifResult.status === "rejected") {
  logger.warn("EXIF extraction failed", { error: exifResult.reason });
}
if (iptcResult.status === "rejected") {
  logger.warn("IPTC extraction failed", { error: iptcResult.reason });
}
```

---

### 3. Database Index Optimization

**Issue:** Missing indexes for common queries.

**Recommendation:**

```sql
-- Add composite index for date queries (EXIF or video)
CREATE INDEX idx_media_files_date_taken
ON media_files(COALESCE(exif_datetime_original, video_datetime_original))
WHERE exif_datetime_original IS NOT NULL OR video_datetime_original IS NOT NULL;

-- Add index for keyword search
CREATE INDEX idx_media_files_iptc_keywords_gin
ON media_files USING GIN(iptc_keywords)
WHERE array_length(iptc_keywords, 1) > 0;
```

---

### 4. API Response Optimization

**Issue:** No caching headers for metadata responses.

**Recommendation:**

```typescript
// In getMediaDetails response:
const response = new Response(JSON.stringify(mediaDetails), {
  headers: {
    "content-type": "application/json",
    "cache-control": "private, max-age=300", // Cache for 5 minutes
  },
});
```

---

### 5. Type Safety Improvements

**Issue:** Some types are `any` or too loose.

**Recommendation:**

```typescript
// Use strict types instead of any
type MetadataType = "EXIF" | "IPTC" | "VIDEO";

interface ExtractionResult {
  exif: EXIFData | null;
  iptc: IPTCData | null;
  video: VideoMetadata | null;
  errors: Array<{ type: MetadataType; error: string }>;
}
```

---

### 6. Configuration Management

**Issue:** Hard-coded limits and settings.

**Recommendation:**

```typescript
// Create configuration object
const MetadataConfig = {
  MAX_METADATA_SIZE: parseInt(env.METADATA_MAX_SIZE || "51200"), // 50KB default
  MAX_KEYWORDS: parseInt(env.METADATA_MAX_KEYWORDS || "100"),
  MAX_KEYWORD_LENGTH: parseInt(env.METADATA_MAX_KEYWORD_LENGTH || "100"),
  EXTRACTION_TIMEOUT: parseInt(env.METADATA_EXTRACTION_TIMEOUT || "5000"), // 5s
} as const;
```

---

### 7. Testing Coverage

**Issue:** Specification mentions tests but doesn't specify security test cases.

**Recommendation:**
Add security test cases:

- Test with malicious metadata (XSS payloads)
- Test with extremely large metadata
- Test with invalid GPS coordinates
- Test with malformed dates
- Test with oversized keyword arrays
- Test rate limiting
- Test access control

---

### 8. Documentation Updates

**Issue:** Security considerations document exists but needs updates for new metadata types.

**Recommendation:**

- Update `security-considerations.md` to include IPTC and video metadata
- Add threat model for keywords (content discovery attacks)
- Document rate limiting strategy
- Add security testing checklist

---

## Implementation Priority

### Phase 1: Critical Security Fixes (Before Implementation)

1. ✅ Add input validation with Zod schemas
2. ✅ Add sanitization for all string fields
3. ✅ Add GPS coordinate validation
4. ✅ Add size limits on metadata JSON
5. ✅ Add Zod schemas for API validation

### Phase 2: High Priority Fixes (During Implementation)

6. ✅ Add rate limiting
7. ✅ Add transaction handling
8. ✅ Add keyword validation
9. ✅ Add date validation

### Phase 3: Best Practices (Post-Implementation)

10. Enhanced error handling
11. Security logging
12. Performance optimizations
13. Documentation updates

---

## Security Checklist

### Pre-Implementation

- [ ] Create Zod schemas for all metadata types
- [ ] Implement input sanitization
- [ ] Add GPS coordinate validation
- [ ] Add size limits on all metadata
- [ ] Add API validation schemas
- [ ] Review dependency vulnerabilities (`exifr`)

### During Implementation

- [ ] Add rate limiting to upload endpoint
- [ ] Wrap database operations in transactions
- [ ] Add keyword validation
- [ ] Add date validation
- [ ] Add security logging
- [ ] Test with malicious inputs

### Post-Implementation

- [ ] Security audit
- [ ] Penetration testing
- [ ] Performance testing
- [ ] Documentation review
- [ ] Team training on security measures

---

## Dependencies Review

### `exifr` Package

**Version:** ^7.1.3

**Security Check:**

- ✅ Check for known vulnerabilities: `npm audit`
- ✅ Review package maintenance status
- ✅ Verify target-runtime compatibility
- ✅ Check license compatibility

**Recommendation:**

- Pin exact version in production: `7.1.3` (not `^7.1.3`)
- Set up Dependabot for security updates
- Review changelog before updates

---

## Compliance Considerations

### GDPR

- ✅ Location data is personal data - must be protected
- ✅ User consent required for location visibility
- ✅ Right to deletion includes metadata
- ✅ Data export must include metadata
- ✅ Privacy by default (location hidden)

### Data Retention

- ✅ Metadata deleted when media is deleted
- ✅ No separate retention policy needed
- ✅ Logs should be retained per compliance requirements

---

## Conclusion

The specification is well-designed but requires **critical security enhancements** before implementation. The main areas of concern are:

1. **Input validation and sanitization** - Must be added
2. **Size limits** - Must be enforced
3. **GPS validation** - Must be validated
4. **API validation** - Must use Zod schemas

Once these are addressed, the specification will be ready for secure implementation.

---

**Next Steps:**

1. Update specification with security fixes
2. Create implementation tickets with security requirements
3. Review with security team
4. Begin implementation with security-first approach
