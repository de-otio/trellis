---
title: Media metadata data model
description: Stored fields and types for image and video metadata — EXIF, IPTC, and video — and the per-media visibility settings.
sidebar: Media data model
order: 31
---

# Media metadata data model

The `MediaFile` model reserves columns for three kinds of metadata extracted
from the uploaded file:

- **EXIF** (images) — a small best-effort subset of camera fields, capture
  date, and GPS location.
- **IPTC** (images) — keywords, copyright notice, creator, and caption.
- **Video metadata** — basic technical fields parsed from the container header.

The full metadata objects are stored as JSON; a few unified fields
(`dateTaken`, `gpsLatitude`, `gpsLongitude`, `keywords`) have dedicated columns
so they can be indexed. See the [Media metadata API](./media-api.md) for how
these fields are exposed and
[Media privacy considerations](./media-privacy-considerations.md) for the
visibility model.

> **Note — extraction is intentionally minimal.** The shipped extractor
> (`apps/api/src/lib/metadata/metadata-extractor.ts`, backed by `exifr`)
> deliberately extracts only the fields listed below. It does **not** parse
> orientation, aperture/shutter/flash/white-balance, colour space, resolution,
> altitude, reverse-geocoded place names, copyright-owner/rights-terms,
> headline/description, creator-contact/credit, codec/frame-rate/bitrate, or
> device make/model from video. Those fields are not part of the data model.

## EXIF fields (shipped subset)

The EXIF object stored in `exifData` is the validated output of
`EXIFDataSchema`:

- **make** (string) — camera manufacturer.
- **model** (string) — camera model.
- **lensModel** (string) — lens model, if embedded.
- **software** (string) — software used to process the image.
- **iso** (integer) — ISO sensitivity.
- **fNumber** (number) — f-number (aperture).
- **exposureTime** (number) — exposure time in seconds.
- **focalLength** (number) — focal length in mm.
- **dateTimeOriginal** (ISO 8601 string) — when the photo was taken.
- **gps** (object, privacy sensitive) — `{ latitude, longitude }` in decimal
  degrees. Altitude is **not** extracted.

## IPTC fields (shipped subset)

The IPTC object stored in `iptcData` is the validated output of
`IPTCDataSchema`:

- **keywords** (string array) — IPTC keywords (max 100 entries, 64 chars each).
- **copyrightNotice** (string) — copyright notice.
- **creator** (string) — creator/byline.
- **caption** (string) — caption / abstract.

## Video metadata fields (shipped subset)

The video object stored in `videoMetadata` is the validated output of
`VideoMetadataSchema`. In practice only the basic header-derived fields are
populated by the current extractor:

- **width** / **height** (integer) — dimensions parsed from the container.
- **duration** (integer) — duration in seconds.

The schema also permits `dateTaken`, `gps`, `codec`, and `bitrate`, but the
shipped header parser does not currently produce them for video.

## Database schema

Metadata columns live on the `MediaFile` model. The raw payloads are stored as
JSON; a few unified fields have dedicated columns for indexing.

```prisma
model MediaFile {
  // ... base media fields (contentHash, mimeType, size, keys, width, height, duration) ...

  // Raw metadata payloads (JSON)
  exifData      Json? @map("exif_data")
  iptcData      Json? @map("iptc_data")
  videoMetadata Json? @map("video_metadata")

  // Denormalized / unified metadata fields
  dateTaken    DateTime? @map("date_taken")
  gpsLatitude  Float?    @map("gps_latitude")
  gpsLongitude Float?    @map("gps_longitude")
  keywords     String[]  @default([]) @map("keywords")

  // Privacy flags
  metadataVisible Boolean @default(true)  @map("metadata_visible")
  locationVisible Boolean @default(false) @map("location_visible")
}
```

Note the column defaults: `metadataVisible` defaults to `true`, while
`locationVisible` defaults to `false` — location is hidden until the owner
explicitly enables it.

> **Flag — metadata columns are not populated on upload.** As shipped, the
> upload path (`apps/api/src/lib/routes/media.ts`) runs extraction but writes
> only `width`, `height`, and `duration` to the `MediaFile` record. The
> `exifData`, `iptcData`, `videoMetadata`, `dateTaken`, `gpsLatitude`,
> `gpsLongitude`, and `keywords` columns exist in the schema but are not
> persisted by any current writer. The metadata-details response therefore
> returns `null` for these fields. This is a data-model/wiring gap to resolve,
> not behaviour to document as working.

### Indexes

The shipped schema indexes the unified columns:

```prisma
@@index([dateTaken])
@@index([metadataVisible])
@@index([locationVisible])
@@index([gpsLatitude, gpsLongitude])
```

There are no `exif_make` / `exif_model`, `exif_datetime_original`,
`video_datetime_original`, or `iptc_keywords` GIN indexes — those columns do
not exist.

## Type definitions

These mirror the Zod schemas in
`apps/api/src/lib/metadata/metadata-schemas.ts`.

```typescript
export interface EXIFData {
  make?: string;
  model?: string;
  lensModel?: string;
  software?: string;

  iso?: number;          // integer
  fNumber?: number;      // aperture
  exposureTime?: number; // seconds
  focalLength?: number;  // mm

  dateTimeOriginal?: string; // ISO 8601

  gps?: { latitude: number; longitude: number };
}

export interface IPTCData {
  keywords?: string[];
  copyrightNotice?: string;
  creator?: string;
  caption?: string;
}

export interface VideoMetadata {
  width?: number;
  height?: number;
  duration?: number;

  // Permitted by the schema but not produced by the current header parser:
  dateTaken?: string;
  gps?: { latitude: number; longitude: number };
  codec?: string;
  bitrate?: number;
}
```

## Storage notes

- **JSON columns** hold the validated metadata objects and can absorb new
  fields without a schema change. A 32 KB per-blob size cap is enforced at
  extraction time (`METADATA_LIMITS.MAX_METADATA_SIZE_BYTES`).
- **Unified columns** (`dateTaken`, `gpsLatitude`, `gpsLongitude`, `keywords`)
  are intended to mirror the most-queried fields for indexing. See the flag
  above: the wiring to populate them on upload is not yet in place.
