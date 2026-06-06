---
title: Media metadata API
description: Endpoints and response formats for image and video metadata (EXIF, IPTC, video) and per-media visibility controls.
sidebar: Media API
order: 30
---

# Media metadata API

Media items carry optional metadata extracted from the uploaded file: EXIF and
IPTC data for images, and technical/device metadata for videos. The API exposes
this metadata on the media-details response and gives the owner controls over
what is visible.

Metadata is filtered before it leaves the API according to the owner's
visibility settings. See
[Media privacy considerations](./media-privacy-considerations.md) for the
privacy model and [Media metadata data model](./media-data-model.md) for the
stored fields.

## GET `/api/media/:mediaId`

Returns the media details. When metadata is available and visible, the response
includes `exifData`, `iptcData`, and/or `videoMetadata`.

```typescript
{
  // ... base media fields ...

  // EXIF data (images only); null when absent or hidden
  exifData?: {
    // Camera / device
    make?: string;
    model?: string;
    software?: string;
    orientation?: number;

    // Camera settings
    iso?: number;
    aperture?: number;
    shutterSpeed?: string;
    focalLength?: number;
    flash?: boolean;
    whiteBalance?: string;

    // Date / time
    dateTimeOriginal?: string;   // ISO 8601
    dateTimeDigitized?: string;  // ISO 8601

    // Location (only when location visibility is enabled)
    gps?: {
      latitude?: number;
      longitude?: number;
      altitude?: number;
      location?: string;  // human-readable
    } | null;

    // Image properties
    colorSpace?: string;
    resolution?: { width: number; height: number };
    xResolution?: number;
    yResolution?: number;

    // Optional
    exposureMode?: string;
    meteringMode?: string;
    lensModel?: string;
    artist?: string;
    copyright?: string;
  } | null;

  // IPTC data (images only); null when absent or hidden
  iptcData?: {
    keywords?: string[];

    copyright?: string;
    copyrightOwner?: string;
    rightsUsageTerms?: string;

    caption?: string;
    headline?: string;
    description?: string;

    creator?: string;
    creatorContact?: string;
    credit?: string;
  } | null;

  // Video metadata (videos only); null when absent or hidden
  videoMetadata?: {
    dateTimeOriginal?: string;   // ISO 8601
    dateTimeDigitized?: string;  // ISO 8601

    // Location (only when location visibility is enabled)
    gps?: {
      latitude?: number;
      longitude?: number;
      altitude?: number;
      location?: string;
    } | null;

    codec?: string;
    frameRate?: number;
    bitrate?: number;
    duration?: number;

    make?: string;
    model?: string;
  } | null;

  // Unified capture time, from EXIF or video metadata
  dateTaken?: string;  // ISO 8601

  // Visibility flags
  metadataVisible: boolean;  // owner preference for all metadata
  locationVisible: boolean;  // location visibility (EXIF and video)

  // Optional field-level visibility settings
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

### Query parameters

```
GET /api/media/:mediaId?includeMetadata=true
```

- `includeMetadata` — defaults to `true`. When `false`, all metadata is omitted
  from the response (useful when the caller does not need it).
- `includeExif` — accepted as an alias for `includeMetadata` for backward
  compatibility.

## PATCH `/api/media/:mediaId/metadata-visibility`

Updates the owner's metadata visibility preferences. All fields are optional;
send only what you want to change.

```typescript
{
  "metadataVisible": boolean,   // quick toggle for all metadata
  "locationVisible": boolean,   // quick toggle for location
  "metadataVisibilitySettings": {  // field-level control
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

Precedence rules:

- When `metadataVisible` is `false`, all metadata is hidden regardless of the
  granular settings.
- When `locationVisible` is `false`, location is hidden regardless of the
  granular settings.
- Granular settings apply only when `metadataVisible` is `true`.
- A granular `location` setting overrides `locationVisible` for that media type.

### Backward-compatible endpoint

```typescript
PATCH /api/media/:mediaId/exif-visibility
{
  "exifDataVisible": boolean,     // maps to metadataVisible
  "exifLocationVisible": boolean  // maps to locationVisible
}
```

### Response

```json
{
  "success": true,
  "media": {
    "id": "string",
    "exifDataVisible": true,
    "exifLocationVisible": false
  }
}
```

### Errors

- `400 Bad Request` — invalid request body.
- `403 Forbidden` — caller lacks permission.
- `404 Not Found` — media not found, or the caller does not own it.

## Response examples

### Image with EXIF and IPTC data

```json
{
  "id": "clx123abc",
  "contentHash": "a3f5b2c1...",
  "mimeType": "image/jpeg",
  "size": 2456789,
  "width": 1920,
  "height": 1080,
  "thumbnailUrl": "https://example.com/api/media/a3f5b2c1...?variant=thumbnail",
  "optimizedUrl": "https://example.com/api/media/a3f5b2c1...?variant=optimized",
  "originalUrl": "https://example.com/api/media/a3f5b2c1...?variant=original",
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
    "copyright": "© 2025 Jane Doe",
    "caption": "Afternoon at the park"
  },
  "canDelete": true,
  "canHide": true
}
```

### Video with metadata

```json
{
  "id": "clx456def",
  "contentHash": "b4g6c3d2...",
  "mimeType": "video/mp4",
  "size": 12345678,
  "width": 1920,
  "height": 1080,
  "duration": 120,
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
  "canDelete": true,
  "canHide": true
}
```

### Image with location visible

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

### Media without metadata (`includeMetadata=false`)

```json
{
  "id": "clx123abc",
  "contentHash": "a3f5b2c1...",
  "mimeType": "image/jpeg",
  "size": 2456789,
  "width": 1920,
  "height": 1080,
  "createdAt": "2025-01-15T15:30:00Z",
  "canDelete": true,
  "canHide": true
}
```

## Privacy filtering

Metadata is filtered server-side before it is returned, in this order:

1. The `includeMetadata` query parameter — when `false`, all metadata is
   omitted.
2. The `metadataVisible` flag — when `false`, all metadata is hidden.
3. The `locationVisible` flag — when `false`, GPS fields are removed from EXIF
   and video metadata.
4. The granular `metadataVisibilitySettings` — when present, each disabled
   field group is removed from the response, overriding the binary toggles for
   the affected fields.

## Behaviour notes

- **Missing metadata is not an error.** `exifData`, `iptcData`, and
  `videoMetadata` are `null` when the media has none. Each type is independent —
  an image may have EXIF but no IPTC.
- **Extraction failures do not fail uploads.** If metadata cannot be extracted,
  the upload still succeeds and the media is stored and accessible; the relevant
  metadata field is simply `null`. Each metadata type is extracted
  independently.
- **EXIF data is additive.** Clients that do not read metadata fields can ignore
  them; the base media response shape is unchanged.
