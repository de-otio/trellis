---
title: Media dependencies
description: npm packages, runtime requirements, and database changes for media metadata extraction.
sidebar: Media dependencies
order: 30
---

# Media dependencies

This page documents the packages and runtime requirements for media metadata
extraction in Trellis.

## npm packages

### `exifr`

```json
{
  "dependencies": {
    "exifr": "^7.1.3"
  }
}
```

| Property | Value |
|----------|-------|
| Version | `^7.1.3` (declared in `apps/api/package.json`) |
| Purpose | EXIF and IPTC extraction from images |
| License | MIT |

`exifr` is used by `apps/api/src/lib/metadata/metadata-extractor.ts` for the
image EXIF and IPTC paths only. Video "metadata" does **not** go through
`exifr` — see below.

### `sharp`

```json
{
  "dependencies": {
    "sharp": "^0.33.0"
  }
}
```

`sharp` (`^0.33.0`) is also a media dependency, used for image processing in the
upload pipeline. It is a native (non-pure-JS) module.

### Header-only parsers (no dependency)

Image dimensions and video width/height/duration are parsed directly from file
headers by `apps/api/src/lib/media-metadata-extractor.ts` — no library is
involved. WebM dimension extraction is currently a stub (returns empty).

**Extracted metadata types (as shipped):**

- EXIF subset (make, model, lens, software, ISO, f-number, exposure time,
  focal length, capture date, GPS lat/long) from images via `exifr`.
- IPTC subset (keywords, copyright notice, creator, caption) from images via
  `exifr`.
- Video: only width/height/duration from the container header (MP4/QuickTime),
  not via `exifr`.

---

## Database

### PostgreSQL

Metadata storage uses existing PostgreSQL support — no additional extensions
required.

- **JSON column support**: required (available in all supported PostgreSQL
  versions).
- **Migrations**: managed via Prisma.

#### Schema columns (on `MediaFile`)

- `exifData`, `iptcData`, `videoMetadata` — nullable JSON columns.
- Unified columns: `dateTaken`, `keywords`. (GPS coordinate columns were
  dropped for data minimization — see the data-model doc.)
- Privacy flags: `metadataVisible`, `locationVisible`.

See [Media metadata data model](./media-data-model.md) for the full column
list and the note that these JSON columns are not yet populated on upload.

---

## Frontend

The consuming application supplies the frontend. Metadata display is
client-agnostic — no new backend-side frontend dependencies are required.

---

## Extraction limits

Operational limits live in `apps/api/src/lib/metadata/metadata-config.ts`:

- **Per-blob size cap**: 32 KB (`MAX_METADATA_SIZE_BYTES`).
- **Keywords**: max 100, max 64 chars each.
- **String fields**: truncated to 1024 chars.
- **Extraction timeout**: short, best-effort budget per extraction.

---

## Image format support

Upload validation (`apps/api/src/lib/routes/media.ts`) accepts JPEG, PNG, GIF,
WebP, HEIC/HEIF images and MP4, WebM, QuickTime videos. EXIF/IPTC extraction
via `exifr` applies to the image formats; what is actually present depends on
the embedded metadata in the uploaded file.

---

## Security considerations

- Run `npm audit` regularly to catch upstream vulnerabilities in `exifr` and
  `sharp`.
- Metadata is validated against Zod schemas on ingestion.
- String fields are sanitized (control chars stripped, length-bounded).
- GPS coordinates are range-checked before storing.

---

## External services

No external APIs are required for metadata extraction. Optional future
integrations (such as reverse geocoding) would be supplied by the consuming
application, not Trellis core.

---

## Further reading

- [exifr documentation](https://mutiny.github.io/exifr/)
