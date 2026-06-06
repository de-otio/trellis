---
title: Media metadata data model
description: Stored fields and types for image and video metadata — EXIF, IPTC, and video — and the per-media visibility settings.
sidebar: Media data model
order: 31
---

# Media metadata data model

Media items store three kinds of metadata extracted from the uploaded file:

- **EXIF** (images) — camera settings, capture date/time, and GPS location.
- **IPTC** (images) — keywords, copyright, captions, and creator information.
- **Video metadata** — capture date/time, technical details, and device
  information.

Full metadata is stored as JSON for flexibility; a few commonly queried fields
are denormalized into columns so they can be indexed. See the
[Media metadata API](./media-api.md) for how these fields are exposed and
[Media privacy considerations](./media-privacy-considerations.md) for the
visibility model.

## EXIF fields

### Camera / device

- **Make** (string) — camera manufacturer (e.g. `Canon`, `Apple`, `Samsung`).
- **Model** (string) — camera model.
- **Software** (string) — software used to process the image.
- **Orientation** (number) — EXIF orientation value (1–8).

### Camera settings

- **ISO** (number) — ISO sensitivity.
- **Aperture** (number) — f-number.
- **Shutter Speed** (string) — exposure time (e.g. `1/125`).
- **Focal Length** (number) — focal length in mm.
- **Flash** (boolean) — whether flash fired.
- **White Balance** (string) — white-balance mode.

### Date and time

- **DateTimeOriginal** (ISO 8601 string) — when the photo was taken.
- **DateTimeDigitized** (ISO 8601 string) — when the photo was digitized.

### Location (GPS) — privacy sensitive

- **GPSLatitude** (number) — latitude in decimal degrees.
- **GPSLongitude** (number) — longitude in decimal degrees.
- **GPSAltitude** (number, optional) — altitude in metres.
- **GPSLocation** (string, optional) — human-readable, reverse-geocoded
  location.

### Image properties

- **ColorSpace** (string) — e.g. `sRGB`, `Adobe RGB`.
- **Resolution** (object) — `{ width, height }`, the original resolution.
- **XResolution** / **YResolution** (number) — resolution in DPI.

### Optional / advanced

- **ExposureMode**, **MeteringMode**, **LensModel** (strings).
- **Artist** (string) — photographer name, if embedded.
- **Copyright** (string) — copyright string, if embedded.

## IPTC fields

### Keywords

- **Keywords** (string array) — tags used for search, recommendations, and
  content discovery.

### Copyright

- **Copyright** (string) — copyright notice.
- **CopyrightOwner** (string) — copyright owner.
- **RightsUsageTerms** (string) — usage terms or license.

### Descriptive

- **Caption** (string), **Headline** (string), **Description** (string).

### Creator

- **Creator** (string), **CreatorContact** (string), **Credit** (string).

## Video metadata fields

### Date and time

- **DateTimeOriginal** (ISO 8601 string) — when the video was recorded.
- **DateTimeDigitized** (ISO 8601 string) — when the video was digitized.

### Location (GPS) — privacy sensitive

- **GPSLatitude** (number), **GPSLongitude** (number), **GPSAltitude** (number,
  optional).

### Technical

- **Codec** (string) — e.g. `H.264`, `H.265`, `VP9`.
- **FrameRate** (number) — frames per second.
- **Bitrate** (number) — bits per second.
- **Duration** (number) — duration in seconds.

### Device

- **Make** (string) — device manufacturer.
- **Model** (string) — device model.

## Database schema

Metadata is stored on the `MediaFile` model. The full metadata objects are
stored as JSON; selected fields are denormalized into columns for indexed
queries.

```prisma
model MediaFile {
  // ... base media fields ...

  // Full metadata, stored as JSON
  exifData      Json? @map("exif_data")
  iptcData      Json? @map("iptc_data")
  videoMetadata Json? @map("video_metadata")

  // Denormalized EXIF fields for common queries
  exifMake             String?   @map("exif_make")
  exifModel            String?   @map("exif_model")
  exifDateTimeOriginal DateTime? @map("exif_datetime_original")
  exifGpsLatitude      Float?    @map("exif_gps_latitude")
  exifGpsLongitude     Float?    @map("exif_gps_longitude")

  // Denormalized IPTC fields (for search / discovery)
  iptcKeywords  String[] @default([]) @map("iptc_keywords")
  iptcCopyright String?  @map("iptc_copyright")

  // Denormalized video metadata fields
  videoDateTimeOriginal DateTime? @map("video_datetime_original")
  videoGpsLatitude      Float?    @map("video_gps_latitude")
  videoGpsLongitude     Float?    @map("video_gps_longitude")

  // Visibility flags
  metadataVisible Boolean @default(true)  @map("metadata_visible")
  locationVisible Boolean @default(false) @map("location_visible")

  // Field-level visibility settings, stored as JSON
  metadataVisibilitySettings Json? @map("metadata_visibility_settings")
}
```

Note the defaults: `metadataVisible` defaults to `true`, while
`locationVisible` defaults to `false` — location is hidden until the owner
explicitly enables it.

### Indexes

```sql
-- Filter by camera make / model
CREATE INDEX idx_media_files_exif_make_model
ON media_files(exif_make, exif_model)
WHERE exif_make IS NOT NULL;

-- Date-taken queries (EXIF)
CREATE INDEX idx_media_files_exif_datetime_original
ON media_files(exif_datetime_original)
WHERE exif_datetime_original IS NOT NULL;

-- Date-taken queries (video)
CREATE INDEX idx_media_files_video_datetime_original
ON media_files(video_datetime_original)
WHERE video_datetime_original IS NOT NULL;

-- IPTC keyword search
CREATE INDEX idx_media_files_iptc_keywords
ON media_files USING GIN(iptc_keywords)
WHERE array_length(iptc_keywords, 1) > 0;
```

## Type definitions

```typescript
export interface EXIFData {
  Make?: string;
  Model?: string;
  Software?: string;
  Orientation?: number;

  ISO?: number;
  FNumber?: number;       // aperture
  ExposureTime?: string;  // shutter speed
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

// Field-level visibility control
export interface MetadataVisibilitySettings {
  exif?: {
    cameraInfo?: boolean;       // Make, Model, Software
    cameraSettings?: boolean;   // ISO, Aperture, Shutter Speed, Focal Length, Flash, White Balance
    dateTime?: boolean;         // DateTimeOriginal, DateTimeDigitized
    location?: boolean;         // GPS (overrides locationVisible when set)
    imageProperties?: boolean;  // ColorSpace, Resolution
    advanced?: boolean;         // ExposureMode, MeteringMode, LensModel, Artist, Copyright
  };
  iptc?: {
    keywords?: boolean;
    copyright?: boolean;     // Copyright, CopyrightOwner, RightsUsageTerms
    descriptive?: boolean;   // Caption, Headline, Description
    creator?: boolean;       // Creator, CreatorContact, Credit
  };
  video?: {
    dateTime?: boolean;      // DateTimeOriginal, DateTimeDigitized
    location?: boolean;      // GPS (overrides locationVisible when set)
    technical?: boolean;     // Codec, FrameRate, Bitrate, Duration
    device?: boolean;        // Make, Model
  };
}
```

## Storage notes

- **JSON fields** hold the full metadata objects (typically 1–5 KB per media
  file) and can absorb new fields without a schema change.
- **Denormalized columns** mirror the most-queried fields so they can be indexed
  and filtered efficiently; they are kept in sync with the JSON on write.
