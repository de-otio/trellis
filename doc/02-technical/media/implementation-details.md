# Media Metadata Implementation Details

> Code paths refer to the trellis core (`apps/api/src/lib/media/`). The reference deployment stores originals in object storage (S3 or compatible) and uses JWT bearer auth.

**Purpose:** Provide code examples and implementation details for EXIF, IPTC, and video metadata extraction and integration.

**⚠️ SECURITY:** This implementation includes all security measures from the [Security & Best Practices Review](./security-best-practices-review.md).

---

## Metadata Extraction Libraries

### EXIF Extraction: `exifr`

**NPM Package:** `exifr` (version 7.1.3 - pinned for security)

**Why `exifr`:**

- Lightweight and fast
- Pure-JS; runs in any standard Node.js or edge runtime
- Good TypeScript support
- Handles various image formats
- Well-maintained
- Also supports IPTC extraction

**Security Note:** Pin exact version (not `^7.1.3`) in production and monitor for vulnerabilities.

**Installation:**

```bash
npm install exifr@7.1.3
npm audit  # Check for vulnerabilities
```

### IPTC Extraction: `exifr` (same library)

The `exifr` library also supports IPTC data extraction, so no additional package needed.

### Video Metadata Extraction: `exifr` + custom parsing

For video metadata, `exifr` can extract some data from QuickTime/MOV files. For MP4 and other formats, we may need additional parsing or use the existing `MediaMetadataExtractor` for basic info.

---

## Configuration

### Metadata Configuration

Create configuration object for all limits and settings:

```typescript
// apps/api/src/lib/metadata-config.ts
export const MetadataConfig = {
  MAX_METADATA_SIZE: parseInt(process.env.METADATA_MAX_SIZE || "51200"), // 50KB default
  MAX_KEYWORDS: parseInt(process.env.METADATA_MAX_KEYWORDS || "100"),
  MAX_KEYWORD_LENGTH: parseInt(
    process.env.METADATA_MAX_KEYWORD_LENGTH || "100",
  ),
  EXTRACTION_TIMEOUT: parseInt(
    process.env.METADATA_EXTRACTION_TIMEOUT || "5000",
  ), // 5s
  MAX_STRING_FIELD_LENGTH: {
    MAKE: 100,
    MODEL: 100,
    SOFTWARE: 200,
    COPYRIGHT: 500,
    DEFAULT: 200,
  },
} as const;
```

---

## Validation Schemas

### Zod Schemas for Metadata Validation

Create validation schemas using Zod:

```typescript
// apps/api/src/lib/metadata-schemas.ts
import { z } from "zod";
import { MetadataConfig } from "./metadata-config";

// GPS coordinate validation helper
const gpsLatitudeSchema = z
  .number()
  .min(-90, "Latitude must be between -90 and 90")
  .max(90, "Latitude must be between -90 and 90")
  .finite("Latitude must be a finite number")
  .optional();

const gpsLongitudeSchema = z
  .number()
  .min(-180, "Longitude must be between -180 and 180")
  .max(180, "Longitude must be between -180 and 180")
  .finite("Longitude must be a finite number")
  .optional();

const gpsAltitudeSchema = z
  .number()
  .min(-500, "Altitude must be between -500m and 9000m")
  .max(9000, "Altitude must be between -500m and 9000m")
  .finite("Altitude must be a finite number")
  .optional();

// Date validation helper
const validateDate = (dateStr: string | Date): string | null => {
  try {
    const date = typeof dateStr === "string" ? new Date(dateStr) : dateStr;
    if (isNaN(date.getTime())) return null;

    const now = new Date();
    const minDate = new Date(1900, 0, 1);
    const maxDate = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // 1 year in future

    if (date < minDate || date > maxDate) return null;
    return date.toISOString();
  } catch {
    return null;
  }
};

const isoDateStringSchema = z
  .string()
  .datetime()
  .refine((date) => validateDate(date) !== null, {
    message: "Date must be between 1900-01-01 and 1 year in the future",
  })
  .optional();

// EXIF Data Schema
export const EXIFDataSchema = z
  .object({
    // Camera/Device
    Make: z
      .string()
      .max(MetadataConfig.MAX_STRING_FIELD_LENGTH.MAKE, "Make field too long")
      .optional(),
    Model: z
      .string()
      .max(MetadataConfig.MAX_STRING_FIELD_LENGTH.MODEL, "Model field too long")
      .optional(),
    Software: z
      .string()
      .max(
        MetadataConfig.MAX_STRING_FIELD_LENGTH.SOFTWARE,
        "Software field too long",
      )
      .optional(),
    Orientation: z.number().int().min(1).max(8).optional(),

    // Camera Settings
    ISO: z.number().int().positive().max(1000000).optional(),
    FNumber: z.number().positive().max(100).optional(),
    ExposureTime: z.string().max(50).optional(),
    FocalLength: z.number().positive().max(10000).optional(),
    Flash: z.boolean().optional(),
    WhiteBalance: z.string().max(50).optional(),

    // Date/Time
    DateTimeOriginal: isoDateStringSchema,
    DateTimeDigitized: isoDateStringSchema,

    // Location (validated)
    GPSLatitude: gpsLatitudeSchema,
    GPSLongitude: gpsLongitudeSchema,
    GPSAltitude: gpsAltitudeSchema,

    // Image Properties
    ColorSpace: z.string().max(50).optional(),
    XResolution: z.number().positive().max(100000).optional(),
    YResolution: z.number().positive().max(100000).optional(),

    // Optional
    ExposureMode: z.string().max(50).optional(),
    MeteringMode: z.string().max(50).optional(),
    LensModel: z.string().max(200).optional(),
    Artist: z.string().max(200).optional(),
    Copyright: z
      .string()
      .max(MetadataConfig.MAX_STRING_FIELD_LENGTH.COPYRIGHT)
      .optional(),
  })
  .passthrough(); // Allow additional fields but validate known ones

// IPTC Keywords Schema
const keywordSchema = z
  .string()
  .max(
    MetadataConfig.MAX_KEYWORD_LENGTH,
    `Keyword must be ${MetadataConfig.MAX_KEYWORD_LENGTH} characters or less`,
  )
  .min(1, "Keyword cannot be empty");

// IPTC Data Schema
export const IPTCDataSchema = z
  .object({
    Keywords: z
      .array(keywordSchema)
      .max(
        MetadataConfig.MAX_KEYWORDS,
        `Maximum ${MetadataConfig.MAX_KEYWORDS} keywords allowed`,
      )
      .optional(),
    Copyright: z
      .string()
      .max(MetadataConfig.MAX_STRING_FIELD_LENGTH.COPYRIGHT)
      .optional(),
    CopyrightOwner: z.string().max(200).optional(),
    RightsUsageTerms: z.string().max(500).optional(),
    Caption: z.string().max(2000).optional(),
    Headline: z.string().max(200).optional(),
    Description: z.string().max(5000).optional(),
    Creator: z.string().max(200).optional(),
    CreatorContact: z.string().max(500).optional(),
    Credit: z.string().max(200).optional(),
  })
  .passthrough();

// Video Metadata Schema
export const VideoMetadataSchema = z
  .object({
    DateTimeOriginal: isoDateStringSchema,
    DateTimeDigitized: isoDateStringSchema,
    GPSLatitude: gpsLatitudeSchema,
    GPSLongitude: gpsLongitudeSchema,
    GPSAltitude: gpsAltitudeSchema,
    Codec: z.string().max(50).optional(),
    FrameRate: z.number().positive().max(1000).optional(),
    Bitrate: z.number().int().positive().max(1000000000).optional(), // 1 Gbps max
    Duration: z.number().positive().max(86400).optional(), // 24 hours max
    Make: z.string().max(100).optional(),
    Model: z.string().max(100).optional(),
  })
  .passthrough();

// API Validation Schema
export const MetadataVisibilitySchema = z
  .object({
    metadataVisible: z.boolean().optional(),
    locationVisible: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.metadataVisible !== undefined || data.locationVisible !== undefined,
    { message: "At least one field must be provided" },
  );
```

---

## Security Utilities

### Input Sanitization

```typescript
// apps/api/src/lib/metadata-sanitizer.ts
import { InputSanitizer } from "./input-sanitizer";
import { MetadataConfig } from "./metadata-config";

export class MetadataSanitizer {
  /**
   * Sanitize a string field
   */
  static sanitizeString(
    value: string | undefined,
    maxLength: number = MetadataConfig.MAX_STRING_FIELD_LENGTH.DEFAULT,
  ): string | undefined {
    if (!value || typeof value !== "string") return undefined;
    const sanitized = InputSanitizer.sanitizeText(value);
    return sanitized.length > maxLength
      ? sanitized.substring(0, maxLength)
      : sanitized;
  }

  /**
   * Validate and sanitize GPS coordinates
   */
  static validateGPS(
    lat?: number,
    lon?: number,
    alt?: number,
  ): {
    lat?: number;
    lon?: number;
    alt?: number;
  } | null {
    if (lat === undefined && lon === undefined && alt === undefined) {
      return null;
    }

    const validated: { lat?: number; lon?: number; alt?: number } = {};

    if (lat !== undefined) {
      if (!isFinite(lat) || lat < -90 || lat > 90) {
        throw new Error("Invalid GPS latitude");
      }
      validated.lat = lat;
    }

    if (lon !== undefined) {
      if (!isFinite(lon) || lon < -180 || lon > 180) {
        throw new Error("Invalid GPS longitude");
      }
      validated.lon = lon;
    }

    if (alt !== undefined) {
      if (!isFinite(alt) || alt < -500 || alt > 9000) {
        throw new Error("Invalid GPS altitude");
      }
      validated.alt = alt;
    }

    return validated;
  }

  /**
   * Validate and sanitize keywords
   */
  static validateKeywords(keywords: any): string[] {
    if (!Array.isArray(keywords)) {
      return [];
    }

    if (keywords.length > MetadataConfig.MAX_KEYWORDS) {
      throw new Error(
        `Maximum ${MetadataConfig.MAX_KEYWORDS} keywords allowed`,
      );
    }

    const validated = keywords
      .map((k) => {
        if (typeof k !== "string") return null;
        const sanitized = InputSanitizer.sanitizeText(k).trim();
        return sanitized.length > 0 &&
          sanitized.length <= MetadataConfig.MAX_KEYWORD_LENGTH
          ? sanitized
          : null;
      })
      .filter((k): k is string => k !== null)
      .filter((k, i, arr) => arr.indexOf(k) === i); // Remove duplicates

    return validated;
  }

  /**
   * Validate date and convert to ISO string
   */
  static validateDate(
    dateStr: string | Date | undefined,
    fieldName: string,
  ): string | null {
    if (!dateStr) return null;

    try {
      const date = typeof dateStr === "string" ? new Date(dateStr) : dateStr;

      if (isNaN(date.getTime())) {
        return null;
      }

      const now = new Date();
      const minDate = new Date(1900, 0, 1);
      const maxDate = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

      if (date < minDate || date > maxDate) {
        return null;
      }

      return date.toISOString();
    } catch {
      return null;
    }
  }

  /**
   * Validate metadata size
   */
  static validateMetadataSize(metadata: any, type: string): void {
    const jsonString = JSON.stringify(metadata);
    if (jsonString.length > MetadataConfig.MAX_METADATA_SIZE) {
      throw new Error(
        `${type} metadata exceeds maximum size of ${MetadataConfig.MAX_METADATA_SIZE} bytes`,
      );
    }
  }
}
```

### Custom Error Classes

```typescript
// apps/api/src/lib/metadata-errors.ts
export class MetadataExtractionError extends Error {
  constructor(
    message: string,
    public readonly type: "EXIF" | "IPTC" | "VIDEO",
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "MetadataExtractionError";
    Error.captureStackTrace(this, this.constructor);
  }
}

export class MetadataValidationError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "MetadataValidationError";
    Error.captureStackTrace(this, this.constructor);
  }
}
```

---

## Metadata Extraction Utilities

### MetadataExtractor Class

Create a new utility file: `apps/api/src/lib/metadata-extractor.ts`

```typescript
import exifr from "exifr";
import { Logger } from "./logger";
import { InputSanitizer } from "./input-sanitizer";
import { MetadataSanitizer } from "./metadata-sanitizer";
import { MetadataConfig } from "./metadata-config";
import { z } from "zod";
import {
  EXIFDataSchema,
  IPTCDataSchema,
  VideoMetadataSchema,
} from "./metadata-schemas";
import {
  MetadataExtractionError,
  MetadataValidationError,
} from "./metadata-errors";

// Import interfaces from data-model.md definitions
export interface EXIFData {
  Make?: string;
  Model?: string;
  Software?: string;
  Orientation?: number;
  ISO?: number;
  FNumber?: number;
  ExposureTime?: string;
  FocalLength?: number;
  Flash?: boolean;
  WhiteBalance?: string;
  DateTimeOriginal?: string;
  DateTimeDigitized?: string;
  GPSLatitude?: number;
  GPSLongitude?: number;
  GPSAltitude?: number;
  ColorSpace?: string;
  XResolution?: number;
  YResolution?: number;
  ExposureMode?: string;
  MeteringMode?: string;
  LensModel?: string;
  Artist?: string;
  Copyright?: string;
}

export interface IPTCData {
  Keywords?: string[];
  Copyright?: string;
  CopyrightOwner?: string;
  RightsUsageTerms?: string;
  Caption?: string;
  Headline?: string;
  Description?: string;
  Creator?: string;
  CreatorContact?: string;
  Credit?: string;
}

export interface VideoMetadata {
  DateTimeOriginal?: string;
  DateTimeDigitized?: string;
  GPSLatitude?: number;
  GPSLongitude?: number;
  GPSAltitude?: number;
  Codec?: string;
  FrameRate?: number;
  Bitrate?: number;
  Duration?: number;
  Make?: string;
  Model?: string;
}

export class MetadataExtractor {
  private logger: Logger;

  constructor(env?: any) {
    this.logger = Logger.getInstance(env);
  }

  /**
   * Extract and validate EXIF data from image
   */
  async extractEXIF(
    imageBuffer: ArrayBuffer | Uint8Array,
    mimeType: string,
  ): Promise<EXIFData | null> {
    // Only extract from images
    if (!mimeType.startsWith("image/")) {
      return null;
    }

    // Only extract from formats that support EXIF
    const supportedFormats = ["image/jpeg", "image/tiff"];
    if (!supportedFormats.includes(mimeType)) {
      return null;
    }

    try {
      const bytes =
        imageBuffer instanceof Uint8Array
          ? imageBuffer
          : new Uint8Array(imageBuffer);

      const rawExifData = await exifr.parse(bytes, {
        pick: [
          "Make",
          "Model",
          "Software",
          "Orientation",
          "ISO",
          "FNumber",
          "ExposureTime",
          "FocalLength",
          "Flash",
          "WhiteBalance",
          "DateTimeOriginal",
          "DateTimeDigitized",
          "GPSLatitude",
          "GPSLongitude",
          "GPSAltitude",
          "ColorSpace",
          "XResolution",
          "YResolution",
          "ExposureMode",
          "MeteringMode",
          "LensModel",
          "Artist",
          "Copyright",
        ],
        translateKeys: true,
        translateValues: true,
        reviveValues: true,
      });

      if (!rawExifData) {
        return null;
      }

      // Sanitize all string fields
      if (rawExifData.Make) {
        rawExifData.Make = MetadataSanitizer.sanitizeString(
          rawExifData.Make,
          MetadataConfig.MAX_STRING_FIELD_LENGTH.MAKE,
        );
      }
      if (rawExifData.Model) {
        rawExifData.Model = MetadataSanitizer.sanitizeString(
          rawExifData.Model,
          MetadataConfig.MAX_STRING_FIELD_LENGTH.MODEL,
        );
      }
      if (rawExifData.Software) {
        rawExifData.Software = MetadataSanitizer.sanitizeString(
          rawExifData.Software,
          MetadataConfig.MAX_STRING_FIELD_LENGTH.SOFTWARE,
        );
      }
      if (rawExifData.LensModel) {
        rawExifData.LensModel = MetadataSanitizer.sanitizeString(
          rawExifData.LensModel,
          200,
        );
      }
      if (rawExifData.Artist) {
        rawExifData.Artist = MetadataSanitizer.sanitizeString(
          rawExifData.Artist,
          200,
        );
      }
      if (rawExifData.Copyright) {
        rawExifData.Copyright = MetadataSanitizer.sanitizeString(
          rawExifData.Copyright,
          MetadataConfig.MAX_STRING_FIELD_LENGTH.COPYRIGHT,
        );
      }
      if (rawExifData.WhiteBalance) {
        rawExifData.WhiteBalance = MetadataSanitizer.sanitizeString(
          rawExifData.WhiteBalance,
          50,
        );
      }
      if (rawExifData.ColorSpace) {
        rawExifData.ColorSpace = MetadataSanitizer.sanitizeString(
          rawExifData.ColorSpace,
          50,
        );
      }
      if (rawExifData.ExposureMode) {
        rawExifData.ExposureMode = MetadataSanitizer.sanitizeString(
          rawExifData.ExposureMode,
          50,
        );
      }
      if (rawExifData.MeteringMode) {
        rawExifData.MeteringMode = MetadataSanitizer.sanitizeString(
          rawExifData.MeteringMode,
          50,
        );
      }

      // Format shutter speed
      if (rawExifData?.ExposureTime) {
        if (rawExifData.ExposureTime < 1) {
          rawExifData.ExposureTime = `1/${Math.round(1 / rawExifData.ExposureTime)}`;
        } else {
          rawExifData.ExposureTime = rawExifData.ExposureTime.toString();
        }
        // Sanitize the formatted string
        rawExifData.ExposureTime =
          MetadataSanitizer.sanitizeString(rawExifData.ExposureTime, 50) || "";
      }

      // Validate and convert dates
      if (rawExifData?.DateTimeOriginal) {
        rawExifData.DateTimeOriginal =
          MetadataSanitizer.validateDate(
            rawExifData.DateTimeOriginal,
            "DateTimeOriginal",
          ) || undefined;
      }
      if (rawExifData?.DateTimeDigitized) {
        rawExifData.DateTimeDigitized =
          MetadataSanitizer.validateDate(
            rawExifData.DateTimeDigitized,
            "DateTimeDigitized",
          ) || undefined;
      }

      // Validate GPS coordinates
      if (
        rawExifData.GPSLatitude !== undefined ||
        rawExifData.GPSLongitude !== undefined
      ) {
        try {
          const validatedGPS = MetadataSanitizer.validateGPS(
            rawExifData.GPSLatitude,
            rawExifData.GPSLongitude,
            rawExifData.GPSAltitude,
          );
          if (validatedGPS) {
            rawExifData.GPSLatitude = validatedGPS.lat;
            rawExifData.GPSLongitude = validatedGPS.lon;
            rawExifData.GPSAltitude = validatedGPS.alt;
          } else {
            delete rawExifData.GPSLatitude;
            delete rawExifData.GPSLongitude;
            delete rawExifData.GPSAltitude;
          }
        } catch (error: any) {
          this.logger.warn("Invalid GPS coordinates in EXIF data", {
            error: error.message,
            lat: rawExifData.GPSLatitude,
            lon: rawExifData.GPSLongitude,
          });
          delete rawExifData.GPSLatitude;
          delete rawExifData.GPSLongitude;
          delete rawExifData.GPSAltitude;
        }
      }

      // Validate with Zod schema
      const validatedExifData = EXIFDataSchema.parse(rawExifData);

      // Validate size
      MetadataSanitizer.validateMetadataSize(validatedExifData, "EXIF");

      return validatedExifData;
    } catch (error: any) {
      if (error instanceof MetadataValidationError) {
        throw error;
      }
      if (error instanceof z.ZodError) {
        this.logger.warn("EXIF data validation failed", {
          error: error.errors,
          mimeType,
        });
        throw new MetadataValidationError(
          "EXIF data validation failed",
          undefined,
          error,
        );
      }
      this.logger.warn("Failed to extract EXIF data", {
        error: error.message,
        mimeType,
      });
      throw new MetadataExtractionError(
        "Failed to extract EXIF data",
        "EXIF",
        error,
      );
    }
  }

  /**
   * Extract and validate IPTC data from image
   */
  async extractIPTC(
    imageBuffer: ArrayBuffer | Uint8Array,
    mimeType: string,
  ): Promise<IPTCData | null> {
    // Only extract from images
    if (!mimeType.startsWith("image/")) {
      return null;
    }

    // Only extract from formats that support IPTC
    const supportedFormats = ["image/jpeg", "image/tiff"];
    if (!supportedFormats.includes(mimeType)) {
      return null;
    }

    try {
      const bytes =
        imageBuffer instanceof Uint8Array
          ? imageBuffer
          : new Uint8Array(imageBuffer);

      const rawIptcData = await exifr.parse(bytes, {
        iptc: true, // Extract IPTC data
        pick: [
          "Keywords",
          "Copyright",
          "CopyrightNotice",
          "RightsUsageTerms",
          "Caption",
          "Headline",
          "Description",
          "Creator",
          "CreatorContactInfo",
          "Credit",
        ],
        translateKeys: true,
        translateValues: true,
      });

      if (!rawIptcData) {
        return null;
      }

      // Normalize keywords (ensure array)
      if (rawIptcData.Keywords) {
        if (typeof rawIptcData.Keywords === "string") {
          rawIptcData.Keywords = [rawIptcData.Keywords];
        } else if (!Array.isArray(rawIptcData.Keywords)) {
          rawIptcData.Keywords = [];
        }
      }

      // Validate and sanitize keywords
      if (rawIptcData.Keywords) {
        try {
          rawIptcData.Keywords = MetadataSanitizer.validateKeywords(
            rawIptcData.Keywords,
          );
        } catch (error: any) {
          this.logger.warn("Invalid keywords in IPTC data", {
            error: error.message,
            keywordCount: rawIptcData.Keywords?.length,
          });
          rawIptcData.Keywords = [];
        }
      }

      // Sanitize all string fields
      if (rawIptcData.Copyright) {
        rawIptcData.Copyright = MetadataSanitizer.sanitizeString(
          rawIptcData.Copyright || rawIptcData.CopyrightNotice,
          MetadataConfig.MAX_STRING_FIELD_LENGTH.COPYRIGHT,
        );
      }
      if (rawIptcData.CopyrightOwner) {
        rawIptcData.CopyrightOwner = MetadataSanitizer.sanitizeString(
          rawIptcData.CopyrightOwner,
          200,
        );
      }
      if (rawIptcData.RightsUsageTerms) {
        rawIptcData.RightsUsageTerms = MetadataSanitizer.sanitizeString(
          rawIptcData.RightsUsageTerms,
          500,
        );
      }
      if (rawIptcData.Caption) {
        rawIptcData.Caption = MetadataSanitizer.sanitizeString(
          rawIptcData.Caption,
          2000,
        );
      }
      if (rawIptcData.Headline) {
        rawIptcData.Headline = MetadataSanitizer.sanitizeString(
          rawIptcData.Headline,
          200,
        );
      }
      if (rawIptcData.Description) {
        rawIptcData.Description = MetadataSanitizer.sanitizeString(
          rawIptcData.Description,
          5000,
        );
      }
      if (rawIptcData.Creator) {
        rawIptcData.Creator = MetadataSanitizer.sanitizeString(
          rawIptcData.Creator,
          200,
        );
      }
      if (rawIptcData.CreatorContactInfo) {
        rawIptcData.CreatorContact = MetadataSanitizer.sanitizeString(
          rawIptcData.CreatorContactInfo,
          500,
        );
      }
      if (rawIptcData.Credit) {
        rawIptcData.Credit = MetadataSanitizer.sanitizeString(
          rawIptcData.Credit,
          200,
        );
      }

      // Validate with Zod schema
      const validatedIptcData = IPTCDataSchema.parse(rawIptcData);

      // Validate size
      MetadataSanitizer.validateMetadataSize(validatedIptcData, "IPTC");

      return validatedIptcData;
    } catch (error: any) {
      if (error instanceof MetadataValidationError) {
        throw error;
      }
      if (error instanceof z.ZodError) {
        this.logger.warn("IPTC data validation failed", {
          error: error.errors,
          mimeType,
        });
        throw new MetadataValidationError(
          "IPTC data validation failed",
          undefined,
          error,
        );
      }
      this.logger.warn("Failed to extract IPTC data", {
        error: error.message,
        mimeType,
      });
      throw new MetadataExtractionError(
        "Failed to extract IPTC data",
        "IPTC",
        error,
      );
    }
  }

  /**
   * Extract and validate video metadata
   */
  async extractVideoMetadata(
    videoBuffer: ArrayBuffer | Uint8Array,
    mimeType: string,
  ): Promise<VideoMetadata | null> {
    // Only extract from videos
    if (!mimeType.startsWith("video/")) {
      return null;
    }

    try {
      const bytes =
        videoBuffer instanceof Uint8Array
          ? videoBuffer
          : new Uint8Array(videoBuffer);

      // exifr supports QuickTime/MOV metadata
      if (mimeType === "video/quicktime" || mimeType === "video/mp4") {
        const rawVideoData = await exifr.parse(bytes, {
          pick: [
            "DateTimeOriginal",
            "DateTimeDigitized",
            "GPSLatitude",
            "GPSLongitude",
            "GPSAltitude",
            "Make",
            "Model",
          ],
          translateKeys: true,
          translateValues: true,
          reviveValues: true,
        });

        if (!rawVideoData) {
          return null;
        }

        // Validate and convert dates
        if (rawVideoData.DateTimeOriginal) {
          rawVideoData.DateTimeOriginal =
            MetadataSanitizer.validateDate(
              rawVideoData.DateTimeOriginal,
              "DateTimeOriginal",
            ) || undefined;
        }
        if (rawVideoData.DateTimeDigitized) {
          rawVideoData.DateTimeDigitized =
            MetadataSanitizer.validateDate(
              rawVideoData.DateTimeDigitized,
              "DateTimeDigitized",
            ) || undefined;
        }

        // Sanitize string fields
        if (rawVideoData.Make) {
          rawVideoData.Make = MetadataSanitizer.sanitizeString(
            rawVideoData.Make,
            100,
          );
        }
        if (rawVideoData.Model) {
          rawVideoData.Model = MetadataSanitizer.sanitizeString(
            rawVideoData.Model,
            100,
          );
        }
        if (rawVideoData.Codec) {
          rawVideoData.Codec = MetadataSanitizer.sanitizeString(
            rawVideoData.Codec,
            50,
          );
        }

        // Validate GPS coordinates
        if (
          rawVideoData.GPSLatitude !== undefined ||
          rawVideoData.GPSLongitude !== undefined
        ) {
          try {
            const validatedGPS = MetadataSanitizer.validateGPS(
              rawVideoData.GPSLatitude,
              rawVideoData.GPSLongitude,
              rawVideoData.GPSAltitude,
            );
            if (validatedGPS) {
              rawVideoData.GPSLatitude = validatedGPS.lat;
              rawVideoData.GPSLongitude = validatedGPS.lon;
              rawVideoData.GPSAltitude = validatedGPS.alt;
            } else {
              delete rawVideoData.GPSLatitude;
              delete rawVideoData.GPSLongitude;
              delete rawVideoData.GPSAltitude;
            }
          } catch (error: any) {
            this.logger.warn("Invalid GPS coordinates in video metadata", {
              error: error.message,
              lat: rawVideoData.GPSLatitude,
              lon: rawVideoData.GPSLongitude,
            });
            delete rawVideoData.GPSLatitude;
            delete rawVideoData.GPSLongitude;
            delete rawVideoData.GPSAltitude;
          }
        }

        // Note: Codec, frame rate, bitrate may need additional parsing
        // from video file headers (can use existing MediaMetadataExtractor)

        // Validate with Zod schema
        const validatedVideoData = VideoMetadataSchema.parse(rawVideoData);

        // Validate size
        MetadataSanitizer.validateMetadataSize(validatedVideoData, "VIDEO");

        return validatedVideoData;
      }

      // For other video formats, extract basic info from headers
      // Use existing MediaMetadataExtractor for width/height/duration
      return null;
    } catch (error: any) {
      if (error instanceof MetadataValidationError) {
        throw error;
      }
      if (error instanceof z.ZodError) {
        this.logger.warn("Video metadata validation failed", {
          error: error.errors,
          mimeType,
        });
        throw new MetadataValidationError(
          "Video metadata validation failed",
          undefined,
          error,
        );
      }
      this.logger.warn("Failed to extract video metadata", {
        error: error.message,
        mimeType,
      });
      throw new MetadataExtractionError(
        "Failed to extract video metadata",
        "VIDEO",
        error,
      );
    }
  }

  /**
   * Extract all metadata types for a media file (with parallel extraction and error handling)
   */
  async extractAll(
    fileBuffer: ArrayBuffer | Uint8Array,
    mimeType: string,
  ): Promise<{
    exif: EXIFData | null;
    iptc: IPTCData | null;
    video: VideoMetadata | null;
    errors: Array<{ type: "EXIF" | "IPTC" | "VIDEO"; error: string }>;
  }> {
    const result = {
      exif: null as EXIFData | null,
      iptc: null as IPTCData | null,
      video: null as VideoMetadata | null,
      errors: [] as Array<{ type: "EXIF" | "IPTC" | "VIDEO"; error: string }>,
    };

    if (mimeType.startsWith("image/")) {
      // Extract EXIF and IPTC in parallel with Promise.allSettled for independent error handling
      const [exifResult, iptcResult] = await Promise.allSettled([
        this.extractEXIF(fileBuffer, mimeType),
        this.extractIPTC(fileBuffer, mimeType),
      ]);

      if (exifResult.status === "fulfilled") {
        result.exif = exifResult.value;
      } else {
        result.errors.push({
          type: "EXIF",
          error:
            exifResult.reason instanceof Error
              ? exifResult.reason.message
              : "Unknown error",
        });
        this.logger.warn("EXIF extraction failed", {
          error: exifResult.reason,
          mimeType,
        });
      }

      if (iptcResult.status === "fulfilled") {
        result.iptc = iptcResult.value;
      } else {
        result.errors.push({
          type: "IPTC",
          error:
            iptcResult.reason instanceof Error
              ? iptcResult.reason.message
              : "Unknown error",
        });
        this.logger.warn("IPTC extraction failed", {
          error: iptcResult.reason,
          mimeType,
        });
      }
    } else if (mimeType.startsWith("video/")) {
      // Extract video metadata
      try {
        result.video = await this.extractVideoMetadata(fileBuffer, mimeType);
      } catch (error: any) {
        result.errors.push({
          type: "VIDEO",
          error: error instanceof Error ? error.message : "Unknown error",
        });
        this.logger.warn("Video metadata extraction failed", {
          error,
          mimeType,
        });
      }
    }

    return result;
  }
}
```

---

## Upload Flow Integration

### Modify Media Upload Handler

Update `apps/api/src/lib/routes/media.ts` - upload handler:

```typescript
import { MetadataExtractor } from "../metadata-extractor";
import { RateLimiter } from "../rate-limiter";
import { getDatabase } from "../database";

async function handleMediaUpload(request: Request, env: Env, context: any) {
  const sessionManager = new SessionManager();
  const securityHeaders = new SecurityHeaders(env);
  const logger = Logger.getInstance(env);
  const rateLimiter = new RateLimiter();

  // Check authentication
  const session = await sessionManager.getSession(
    request,
    Secrets.getSessionSecret(env),
  );

  if (!session) {
    return securityHeaders.createSecureResponse(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }

  // Apply rate limiting (CRITICAL SECURITY)
  const rateLimitResponse = await rateLimiter.applyRateLimitKV(
    env as any,
    request,
    "/api/media/upload",
    10, // 10 uploads
    60, // per 60 seconds
    session.userId,
  );
  if (rateLimitResponse) {
    return securityHeaders.addSecurityHeaders(rateLimitResponse);
  }

  // ... existing upload logic to get fileBuffer and mimeType ...

  // ⚠️ CRITICAL: Extract metadata from ORIGINAL file BEFORE any processing
  // Metadata can be lost during compression, resizing, or reencoding
  // Best practice: Extract from original file buffer before any transformations
  const extractor = new MetadataExtractor(env);
  const db = await getDatabase(env);

  // Extract metadata from ORIGINAL file (before compression/resizing)
  // This ensures metadata is never lost due to client-side or server-side processing
  let exifData = null;
  let iptcData = null;
  let videoMetadata = null;
  const extractionErrors: string[] = [];

  try {
    // Extract from original file buffer (received from client)
    // Even if client compressed the file, we extract from what we receive
    // For best results, client should extract metadata before compression and send separately
    const extractionResult = await extractor.extractAll(fileBuffer, mimeType);
    exifData = extractionResult.exif;
    iptcData = extractionResult.iptc;
    videoMetadata = extractionResult.video;

    // Log extraction errors
    if (extractionResult.errors.length > 0) {
      extractionResult.errors.forEach((err) => {
        extractionErrors.push(`${err.type}: ${err.error}`);
      });
      logger.warn("Metadata extraction had errors", {
        errors: extractionResult.errors,
        mimeType,
      });
    }
  } catch (error: any) {
    logger.warn("Metadata extraction failed completely", {
      error: error.message,
      mimeType,
    });
    // Continue without metadata - not critical for upload
  }

  // Use transaction for atomic operations (CRITICAL SECURITY)
  const media = await db.$transaction(async (tx) => {
    // Create media record first
    const mediaRecord = await tx.mediaFile.create({
      data: {
        // ... existing fields (userId, contentHash, mimeType, size, etc.) ...
        metadataVisible: true, // Default
        locationVisible: false, // Default for privacy
      },
    });

    // Metadata was already extracted above from original file buffer
    // (before transaction to ensure we extract from original, unprocessed file)

    // Determine date taken (from EXIF or video metadata)
    const dateTaken = exifData?.DateTimeOriginal
      ? new Date(exifData.DateTimeOriginal)
      : videoMetadata?.DateTimeOriginal
        ? new Date(videoMetadata.DateTimeOriginal)
        : null;

    // Update media record with metadata in same transaction
    const updatedMedia = await tx.mediaFile.update({
      where: { id: mediaRecord.id },
      data: {
        // EXIF data
        exifData: exifData ? JSON.stringify(exifData) : null,
        exifMake: exifData?.Make || null,
        exifModel: exifData?.Model || null,
        exifDateTimeOriginal:
          dateTaken && exifData?.DateTimeOriginal ? dateTaken : null,
        exifGpsLatitude: exifData?.GPSLatitude || null,
        exifGpsLongitude: exifData?.GPSLongitude || null,

        // IPTC data
        iptcData: iptcData ? JSON.stringify(iptcData) : null,
        iptcKeywords: iptcData?.Keywords || [],
        iptcCopyright: iptcData?.Copyright || null,

        // Video metadata
        videoMetadata: videoMetadata ? JSON.stringify(videoMetadata) : null,
        videoDateTimeOriginal:
          dateTaken && videoMetadata?.DateTimeOriginal ? dateTaken : null,
        videoGpsLatitude: videoMetadata?.GPSLatitude || null,
        videoGpsLongitude: videoMetadata?.GPSLongitude || null,
      },
    });

    return updatedMedia;
  });

  // Log successful upload with metadata extraction status
  logger.info("Media uploaded with metadata", {
    mediaId: media.id,
    hasExif: !!exifData,
    hasIptc: !!iptcData,
    hasVideoMetadata: !!videoMetadata,
    extractionErrors:
      extractionErrors.length > 0 ? extractionErrors : undefined,
  });

  return securityHeaders.createSecureResponse(
    JSON.stringify({
      id: media.id,
      // ... other fields ...
    }),
    { status: 201, headers: { "content-type": "application/json" } },
  );
}
```

---

## Media Details Handler Update

### Update getMediaDetails

Modify `apps/api/src/lib/media-handler.ts` - `getMediaDetails` method:

```typescript
async getMediaDetails(
  mediaId: string,
  userId: string,
  env: Env,
  request?: Request
): Promise<MediaDetails> {
  const logger = Logger.getInstance(env);
  const db = await getDatabase(env);

  // ... existing logic to fetch media ...
  const media = await db.mediaFile.findUnique({
    where: { id: mediaId },
  });

  if (!media || media.userId !== userId) {
    throw new Error('Media not found or access denied');
  }

  // Parse metadata
  let exifData = null;
  let iptcData = null;
  let videoMetadata = null;

  // Check if metadata should be included
  const url = request ? new URL(request.url) : null;
  const includeMetadata = url?.searchParams.get('includeMetadata') !== 'false'
    && url?.searchParams.get('includeExif') !== 'false'; // Legacy support

  if (includeMetadata && media.metadataVisible) {
    // Parse EXIF data
    if (media.exifData) {
      try {
        exifData = typeof media.exifData === 'string'
          ? JSON.parse(media.exifData)
          : media.exifData;

        // Apply privacy filters
        if (!media.locationVisible && exifData) {
          delete exifData.GPSLatitude;
          delete exifData.GPSLongitude;
          delete exifData.GPSAltitude;
          delete exifData.GPSLocation;
        }

        // Log location access if visible
        if (media.locationVisible && (exifData?.GPSLatitude || exifData?.GPSLongitude)) {
          logger.info('Location data accessed', {
            userId,
            mediaId,
            action: 'view_location',
            source: 'EXIF',
            timestamp: new Date().toISOString(),
          });
        }

        exifData = this.formatEXIFData(exifData);
      } catch (error) {
        logger.warn('Failed to parse EXIF data', { error, mediaId });
      }
    }

    // Parse IPTC data
    if (media.iptcData) {
      try {
        iptcData = typeof media.iptcData === 'string'
          ? JSON.parse(media.iptcData)
          : media.iptcData;

        iptcData = this.formatIPTCData(iptcData);
      } catch (error) {
        logger.warn('Failed to parse IPTC data', { error, mediaId });
      }
    }

    // Parse video metadata
    if (media.videoMetadata) {
      try {
        videoMetadata = typeof media.videoMetadata === 'string'
          ? JSON.parse(media.videoMetadata)
          : media.videoMetadata;

        // Apply privacy filters
        if (!media.locationVisible && videoMetadata) {
          delete videoMetadata.GPSLatitude;
          delete videoMetadata.GPSLongitude;
          delete videoMetadata.GPSAltitude;
          delete videoMetadata.GPSLocation;
        }

        // Log location access if visible
        if (media.locationVisible && (videoMetadata?.GPSLatitude || videoMetadata?.GPSLongitude)) {
          logger.info('Location data accessed', {
            userId,
            mediaId,
            action: 'view_location',
            source: 'VIDEO',
            timestamp: new Date().toISOString(),
          });
        }

        videoMetadata = this.formatVideoMetadata(videoMetadata);
      } catch (error) {
        logger.warn('Failed to parse video metadata', { error, mediaId });
      }
    }
  }

  // Determine date taken (from EXIF or video metadata)
  const dateTaken = exifData?.dateTimeOriginal
    || videoMetadata?.dateTimeOriginal
    || null;

  return {
    // ... existing fields ...
    exifData,
    iptcData,
    videoMetadata,
    dateTaken,
    metadataVisible: media.metadataVisible ?? true,
    locationVisible: media.locationVisible ?? false,
  };
}

// ... format methods remain the same ...
```

---

## Metadata Visibility Update Endpoint

### Add New Route with Validation

Add to `apps/api/src/lib/routes/media.ts`:

```typescript
import { validateRequest } from '../validation/validate-request';
import { MetadataVisibilitySchema } from '../metadata-schemas';

{
  path: '/api/media/:mediaId/metadata-visibility',
  method: 'PATCH',
  handler: async (request, env, context) => {
    const sessionManager = new SessionManager();
    const securityHeaders = new SecurityHeaders(env);
    const logger = Logger.getInstance(env);
    const rateLimiter = new RateLimiter();
    const mediaHandler = MediaHandler.create(env);

    // Check authentication
    const session = await sessionManager.getSession(
      request,
      Secrets.getSessionSecret(env)
    );

    if (!session) {
      return securityHeaders.createSecureResponse(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      );
    }

    // Apply rate limiting
    const rateLimitResponse = await rateLimiter.applyRateLimitKV(
      env as any,
      request,
      '/api/media/:mediaId/metadata-visibility',
      30,
      60,
      session.userId
    );
    if (rateLimitResponse) {
      return securityHeaders.addSecurityHeaders(rateLimitResponse);
    }

    try {
      const mediaId = context.params?.mediaId;
      if (!mediaId) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: 'Media ID is required' }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      }

      // Validate request body with Zod schema (CRITICAL SECURITY)
      const validation = await validateRequest(request, MetadataVisibilitySchema);
      if (!validation.success) {
        return securityHeaders.addSecurityHeaders(validation.error);
      }

      const { metadataVisible, locationVisible } = validation.data;

      // Validate user owns the media
      const media = await mediaHandler.getMediaDetails(
        mediaId,
        session.userId,
        env,
        request
      );

      if (!media) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: 'Media not found' }),
          { status: 404, headers: { 'content-type': 'application/json' } }
        );
      }

      // Update privacy settings in transaction
      const db = await getDatabase(env);
      await db.$transaction(async (tx) => {
        await tx.mediaFile.update({
          where: { id: mediaId },
          data: {
            metadataVisible: metadataVisible !== undefined ? metadataVisible : undefined,
            locationVisible: locationVisible !== undefined ? locationVisible : undefined,
          },
        });
      });

      // Log privacy setting change (SECURITY LOGGING)
      logger.info('Metadata visibility updated', {
        userId: session.userId,
        mediaId,
        changes: { metadataVisible, locationVisible },
        timestamp: new Date().toISOString(),
      });

      const response = securityHeaders.createSecureResponse(
        JSON.stringify({
          success: true,
          media: {
            id: mediaId,
            metadataVisible: metadataVisible ?? media.metadataVisible,
            locationVisible: locationVisible ?? media.locationVisible,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
      return CorsHandler.addCorsHeaders(response, request, env);
    } catch (error: any) {
      logger.error('Error updating metadata visibility:', error);
      const errorResponse = securityHeaders.createSecureResponse(
        JSON.stringify({
          error: 'Failed to update metadata visibility',
          message: error.message || 'An unexpected error occurred',
        }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
      return CorsHandler.addCorsHeaders(errorResponse, request, env);
    }
  },
  middleware: [corsMiddleware()],
  description: 'Update metadata visibility preferences for a media file',
},
```

---

## Error Handling

### Graceful Degradation

- If EXIF extraction fails: Continue upload without EXIF (but try IPTC)
- If IPTC extraction fails: Continue upload without IPTC (but keep EXIF)
- If video metadata extraction fails: Continue upload without video metadata
- If metadata parsing fails: Return null for that metadata type
- If privacy filter fails: Log error but continue
- If validation fails: Log warning and skip that metadata type

### Logging

- Log metadata extraction failures (warn level)
- Log privacy filter violations (info level)
- Log metadata visibility updates (info level)
- Log location data access (info level - security audit)
- Track which metadata types are successfully extracted

---

## Performance Optimization

### Extraction Timing

**⚠️ CRITICAL: Extract metadata from ORIGINAL file BEFORE any processing**

- **Extract metadata from original file buffer** (before compression, resizing, or reencoding)
- Metadata can be lost during client-side or server-side processing
- Extract during upload, but from the original file received from client
- Store in database to avoid re-extraction
- Use parallel extraction for EXIF and IPTC (Promise.allSettled)
- Cache parsed metadata in memory if needed (with size limits)

**Best Practice:**

1. Client should extract metadata before compression (optional enhancement)
2. Server extracts from original file buffer received from client
3. Metadata extraction happens BEFORE any image optimization/processing
4. If client sends metadata separately, prefer that over extraction (future enhancement)

### Database Queries

- Use denormalized fields for filtering
- Index common query fields (make, model, date, keywords)
- Avoid querying JSON field when possible
- Use transactions for atomic operations

### Response Caching

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

## Security Summary

All security recommendations from the review have been integrated:

✅ **Input Validation**: Zod schemas for all metadata types  
✅ **Sanitization**: All string fields sanitized  
✅ **GPS Validation**: Coordinates validated with range checks  
✅ **Size Limits**: 50KB limit per metadata type  
✅ **Keyword Validation**: Max 100 keywords, length limits, sanitization  
✅ **Date Validation**: ISO 8601 format, reasonable date ranges  
✅ **API Validation**: Zod schemas for all API endpoints  
✅ **Rate Limiting**: Applied to upload and visibility endpoints  
✅ **Transaction Handling**: Database operations wrapped in transactions  
✅ **Security Logging**: Location access and privacy changes logged  
✅ **Error Handling**: Custom error classes with proper error handling  
✅ **Parallel Extraction**: Promise.allSettled for independent error handling
