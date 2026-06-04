# Media Metadata API Design

> API handlers live in the trellis core (`apps/api/src/lib/media-handler.ts`). Endpoint shapes are design references; auth is whatever the deployment configures (the reference deployment uses JWT bearer tokens).

**Purpose:** Define API endpoint changes and response formats for EXIF, IPTC, and video metadata support.

---

## API Changes

### GET /api/media/:mediaId Response Extension

Extend the existing `MediaDetails` response to include metadata (EXIF, IPTC, video):

```typescript
{
  // ... existing fields ...

  // EXIF Data (images only)
  exifData?: {
    // Camera/Device
    make?: string;
    model?: string;
    software?: string;
    orientation?: number;

    // Camera Settings
    iso?: number;
    aperture?: number;
    shutterSpeed?: string;
    focalLength?: number;
    flash?: boolean;
    whiteBalance?: string;

    // Date/Time (Highest Priority)
    dateTimeOriginal?: string; // ISO 8601
    dateTimeDigitized?: string; // ISO 8601

    // Location (only if user has location visible enabled)
    gps?: {
      latitude?: number;
      longitude?: number;
      altitude?: number;
      location?: string; // Human-readable
    } | null;

    // Image Properties
    colorSpace?: string;
    resolution?: {
      width: number;
      height: number;
    };
    xResolution?: number;
    yResolution?: number;

    // Optional fields
    exposureMode?: string;
    meteringMode?: string;
    lensModel?: string;
    artist?: string;
    copyright?: string;
  } | null;

  // IPTC Data (images only)
  iptcData?: {
    // Keywords (High Priority for discovery)
    keywords?: string[];

    // Copyright (Medium Priority)
    copyright?: string;
    copyrightOwner?: string;
    rightsUsageTerms?: string;

    // Descriptive (Lower Priority)
    caption?: string;
    headline?: string;
    description?: string;

    // Creator (Lower Priority)
    creator?: string;
    creatorContact?: string;
    credit?: string;
  } | null;

  // Video Metadata (videos only)
  videoMetadata?: {
    // Date/Time (Highest Priority)
    dateTimeOriginal?: string; // ISO 8601
    dateTimeDigitized?: string; // ISO 8601

    // Location (only if user has location visible enabled)
    gps?: {
      latitude?: number;
      longitude?: number;
      altitude?: number;
      location?: string; // Human-readable
    } | null;

    // Technical (Lower Priority)
    codec?: string;
    frameRate?: number;
    bitrate?: number;
    duration?: number;

    // Device (Lower Priority)
    make?: string;
    model?: string;
  } | null;

  // Unified date/time taken (from EXIF or video metadata)
  dateTaken?: string; // ISO 8601 - from exifData.dateTimeOriginal or videoMetadata.dateTimeOriginal

  // Privacy flags (binary toggles)
  metadataVisible: boolean; // User preference for all metadata
  locationVisible: boolean; // Location privacy setting (applies to both EXIF and video)

  // Granular field-level visibility settings (optional)
  metadataVisibilitySettings?: {
    exif?: {
      cameraInfo?: boolean;
      cameraSettings?: boolean;
      dateTime?: boolean;
      location?: boolean;
      imageProperties?: boolean;
      advanced?: boolean;
    };
    iptc?: {
      keywords?: boolean;
      copyright?: boolean;
      descriptive?: boolean;
      creator?: boolean;
    };
    video?: {
      dateTime?: boolean;
      location?: boolean;
      technical?: boolean;
      device?: boolean;
    };
  } | null;
}
```

### Query Parameters

Add optional query parameter to control metadata inclusion:

```typescript
GET /api/media/:mediaId?includeMetadata=true
```

- **Default**: `includeMetadata=true` (include all metadata if available)
- **If `includeMetadata=false`**: Exclude all metadata from response (for performance)
- **Legacy**: `includeExif` parameter still supported for backward compatibility

### Privacy Controls

Add endpoints for user preferences:

```typescript
// Update metadata visibility preference (binary toggles)
PATCH /api/media/:mediaId/metadata-visibility
{
  "metadataVisible": boolean,  // Optional: Quick toggle for all metadata
  "locationVisible": boolean,   // Optional: Quick toggle for location
  "metadataVisibilitySettings": {  // Optional: Granular field-level control
    "exif": {
      "cameraInfo": boolean,
      "cameraSettings": boolean,
      "dateTime": boolean,
      "location": boolean,
      "imageProperties": boolean,
      "advanced": boolean
    },
    "iptc": {
      "keywords": boolean,
      "copyright": boolean,
      "descriptive": boolean,
      "creator": boolean
    },
    "video": {
      "dateTime": boolean,
      "location": boolean,
      "technical": boolean,
      "device": boolean
    }
  }
}
```

**Note:**

- If `metadataVisible=false`, all metadata is hidden regardless of granular settings
- If `locationVisible=false`, location is hidden regardless of granular settings
- Granular settings only apply when `metadataVisible=true`
- Granular location settings override `locationVisible` if specified

**Legacy endpoint** (for backward compatibility):

```typescript
// Update EXIF visibility preference (maps to metadata-visibility)
PATCH /api/media/:mediaId/exif-visibility
{
  "exifDataVisible": boolean,  // Maps to metadataVisible
  "exifLocationVisible": boolean  // Maps to locationVisible
}
```

**Response:**

```typescript
{
  "success": true,
  "media": {
    "id": string,
    "exifDataVisible": boolean,
    "exifLocationVisible": boolean
  }
}
```

**Error Responses:**

- `404 Not Found`: Media not found or user doesn't own it
- `403 Forbidden`: User doesn't have permission
- `400 Bad Request`: Invalid request body

---

## Response Format Examples

### Media Details with EXIF and IPTC Data (Image)

```json
{
  "id": "clx123abc",
  "contentHash": "a3f5b2c1...",
  "mimeType": "image/jpeg",
  "size": 2456789,
  "width": 1920,
  "height": 1080,
  "thumbnailUrl": "https://api.example.com/api/media/a3f5b2c1...?variant=thumbnail",
  "optimizedUrl": "https://api.example.com/api/media/a3f5b2c1...?variant=optimized",
  "originalUrl": "https://api.example.com/api/media/a3f5b2c1...?variant=original",
  "createdAt": "2025-01-15T15:30:00Z",
  "updatedAt": "2025-01-15T15:30:00Z",
  "hidden": false,
  "metadataVisible": true,
  "locationVisible": false,
  "dateTaken": "2025-01-15T14:30:00Z",
  "exifData": {
    "make": "Canon",
    "model": "Canon EOS 5D Mark IV",
    "iso": 400,
    "aperture": 2.8,
    "shutterSpeed": "1/125",
    "focalLength": 50,
    "flash": false,
    "whiteBalance": "Auto",
    "dateTimeOriginal": "2025-01-15T14:30:00Z",
    "colorSpace": "sRGB",
    "lensModel": "EF 50mm f/1.2L USM"
  },
  "iptcData": {
    "keywords": ["landscape", "outdoor", "park"],
    "copyright": "© 2025 John Doe",
    "caption": "Afternoon at the park"
  },
  "posts": [...],
  "canDelete": true,
  "canHide": true
}
```

### Media Details with Video Metadata

```json
{
  "id": "clx456def",
  "contentHash": "b4g6c3d2...",
  "mimeType": "video/mp4",
  "size": 12345678,
  "width": 1920,
  "height": 1080,
  "duration": 120,
  "thumbnailUrl": "https://api.example.com/api/media/b4g6c3d2...?variant=thumbnail",
  "optimizedUrl": "https://api.example.com/api/media/b4g6c3d2...?variant=optimized",
  "originalUrl": "https://api.example.com/api/media/b4g6c3d2...?variant=original",
  "createdAt": "2025-01-15T15:30:00Z",
  "updatedAt": "2025-01-15T15:30:00Z",
  "hidden": false,
  "metadataVisible": true,
  "locationVisible": false,
  "dateTaken": "2025-01-15T14:30:00Z",
  "videoMetadata": {
    "dateTimeOriginal": "2025-01-15T14:30:00Z",
    "codec": "H.264",
    "frameRate": 30,
    "bitrate": 5000000,
    "make": "Apple",
    "model": "iPhone 14 Pro"
  },
  "posts": [...],
  "canDelete": true,
  "canHide": true
}
```

### Media Details with Location (when visible)

```json
{
  "id": "clx123abc",
  "metadataVisible": true,
  "locationVisible": true,
  "dateTaken": "2025-01-15T14:30:00Z",
  "exifData": {
    "make": "Apple",
    "model": "iPhone 14 Pro",
    "dateTimeOriginal": "2025-01-15T14:30:00Z",
    "gps": {
      "latitude": 37.7749,
      "longitude": -122.4194,
      "altitude": 52.5,
      "location": "San Francisco, CA, USA"
    }
  }
}
```

### Media Details without Metadata (includeMetadata=false)

```json
{
  "id": "clx123abc",
  "contentHash": "a3f5b2c1...",
  "mimeType": "image/jpeg",
  "size": 2456789,
  "width": 1920,
  "height": 1080,
  "createdAt": "2025-01-15T15:30:00Z",
  "posts": [...],
  "canDelete": true,
  "canHide": true
}
```

---

## Privacy Filtering

### Metadata Filtering Logic

Metadata should be filtered based on:

1. `metadataVisible` flag (binary toggle - if false, hide all)
2. `locationVisible` flag (binary toggle - if false, hide all location)
3. Granular `metadataVisibilitySettings` (field-level control - if specified, overrides binary toggles for specific fields)
4. `includeMetadata` query parameter (performance optimization)

**Implementation:**

```typescript
// In getMediaDetails handler
const exifData = media.exifData ? JSON.parse(media.exifData) : null;
const videoMetadata = media.videoMetadata
  ? JSON.parse(media.videoMetadata)
  : null;
const iptcData = media.iptcData ? JSON.parse(media.iptcData) : null;
const visibilitySettings = media.metadataVisibilitySettings
  ? typeof media.metadataVisibilitySettings === "string"
    ? JSON.parse(media.metadataVisibilitySettings)
    : media.metadataVisibilitySettings
  : null;

// Check if metadata should be included
const url = request ? new URL(request.url) : null;
const includeMetadata =
  url?.searchParams.get("includeMetadata") !== "false" &&
  url?.searchParams.get("includeExif") !== "false"; // Legacy support

if (!includeMetadata || !media.metadataVisible) {
  exifData = null;
  videoMetadata = null;
  iptcData = null;
} else {
  // Apply granular filtering if settings exist
  if (visibilitySettings) {
    // Filter EXIF data based on granular settings
    if (exifData) {
      if (!visibilitySettings.exif?.cameraInfo) {
        delete exifData.Make;
        delete exifData.Model;
        delete exifData.Software;
      }
      if (!visibilitySettings.exif?.cameraSettings) {
        delete exifData.ISO;
        delete exifData.FNumber;
        delete exifData.ExposureTime;
        delete exifData.FocalLength;
        delete exifData.Flash;
        delete exifData.WhiteBalance;
      }
      if (!visibilitySettings.exif?.dateTime) {
        delete exifData.DateTimeOriginal;
        delete exifData.DateTimeDigitized;
      }
      if (!visibilitySettings.exif?.location) {
        delete exifData.GPSLatitude;
        delete exifData.GPSLongitude;
        delete exifData.GPSAltitude;
        delete exifData.GPSLocation;
      }
      if (!visibilitySettings.exif?.imageProperties) {
        delete exifData.ColorSpace;
        delete exifData.XResolution;
        delete exifData.YResolution;
      }
      if (!visibilitySettings.exif?.advanced) {
        delete exifData.ExposureMode;
        delete exifData.MeteringMode;
        delete exifData.LensModel;
        delete exifData.Artist;
        delete exifData.Copyright;
      }
    } else {
      // No granular settings - use binary toggles
      if (!media.locationVisible && exifData) {
        delete exifData.GPSLatitude;
        delete exifData.GPSLongitude;
        delete exifData.GPSAltitude;
        delete exifData.GPSLocation;
      }
    }

    // Filter IPTC data based on granular settings
    if (iptcData) {
      if (!visibilitySettings.iptc?.keywords) {
        delete iptcData.Keywords;
      }
      if (!visibilitySettings.iptc?.copyright) {
        delete iptcData.Copyright;
        delete iptcData.CopyrightOwner;
        delete iptcData.RightsUsageTerms;
      }
      if (!visibilitySettings.iptc?.descriptive) {
        delete iptcData.Caption;
        delete iptcData.Headline;
        delete iptcData.Description;
      }
      if (!visibilitySettings.iptc?.creator) {
        delete iptcData.Creator;
        delete iptcData.CreatorContact;
        delete iptcData.Credit;
      }
    }

    // Filter video metadata based on granular settings
    if (videoMetadata) {
      if (!visibilitySettings.video?.dateTime) {
        delete videoMetadata.DateTimeOriginal;
        delete videoMetadata.DateTimeDigitized;
      }
      if (!visibilitySettings.video?.location) {
        delete videoMetadata.GPSLatitude;
        delete videoMetadata.GPSLongitude;
        delete videoMetadata.GPSAltitude;
        delete videoMetadata.GPSLocation;
      }
      if (!visibilitySettings.video?.technical) {
        delete videoMetadata.Codec;
        delete videoMetadata.FrameRate;
        delete videoMetadata.Bitrate;
        delete videoMetadata.Duration;
      }
      if (!visibilitySettings.video?.device) {
        delete videoMetadata.Make;
        delete videoMetadata.Model;
      }
    } else {
      // No granular settings - use binary toggles
      if (!media.locationVisible && videoMetadata) {
        delete videoMetadata.GPSLatitude;
        delete videoMetadata.GPSLongitude;
        delete videoMetadata.GPSAltitude;
        delete videoMetadata.GPSLocation;
      }
    }
  } else {
    // No granular settings - use binary toggles only
    if (!media.locationVisible) {
      if (exifData) {
        delete exifData.GPSLatitude;
        delete exifData.GPSLongitude;
        delete exifData.GPSAltitude;
        delete exifData.GPSLocation;
      }
      if (videoMetadata) {
        delete videoMetadata.GPSLatitude;
        delete videoMetadata.GPSLongitude;
        delete videoMetadata.GPSAltitude;
        delete videoMetadata.GPSLocation;
      }
    }
  }
}
```

---

## Backward Compatibility

### Existing Clients

- EXIF data is **optional** in the response
- Clients that don't expect EXIF data will ignore it
- No breaking changes to existing response structure

### Versioning

- Current API version: No version change required
- EXIF data is additive enhancement
- Future: Consider API versioning if major changes needed

---

## Error Handling

### Missing Metadata

- If media has no metadata: `exifData`, `iptcData`, or `videoMetadata` is `null`
- Not an error condition - normal for media without metadata
- Different metadata types may be present independently (e.g., EXIF but no IPTC)

### Extraction Failures

- If metadata extraction fails during upload: Continue without metadata
- Log warning but don't fail upload
- Media is still stored and accessible
- Each metadata type extracted independently (EXIF failure doesn't prevent IPTC extraction)

### Privacy Violations

- If location data requested but user hasn't enabled: Return without GPS
- No error - just filtered response
- Log access attempts for audit (optional)
