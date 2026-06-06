---
title: Media dependencies
description: npm packages, runtime requirements, and database changes needed for EXIF metadata extraction.
sidebar: Media dependencies
order: 30
---

# Media dependencies

This page documents the packages and runtime requirements for EXIF metadata extraction in Trellis.

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
| Version | `^7.1.3` |
| Purpose | EXIF, IPTC, and video metadata extraction |
| License | MIT |
| Size | ~50 KB (minified) |
| Runtime | Pure-JS — runs in any standard Node.js or edge runtime |

**Extracted metadata types:**

- EXIF data from JPEG/TIFF images
- IPTC data from JPEG/TIFF images
- Video metadata from QuickTime/MOV files

**Installation:**

```bash
cd apps/api
npm install exifr
```

---

## Database

### PostgreSQL

EXIF storage uses existing PostgreSQL support — no additional extensions required.

- **JSON field support**: required (available in all supported PostgreSQL versions)
- **JSONB support**: optional — use for improved query performance if needed
- **Migrations**: managed via Prisma

#### Schema additions

- `exifData` JSON field (nullable) on the media record
- Optional denormalized fields for query performance
- Privacy flag fields
- Indexes for common query patterns

---

## Frontend

The consuming application supplies the frontend. Metadata display is client-agnostic — no new backend-side frontend dependencies are required. Reuse the consuming application's existing media widgets and date-formatting utilities.

---

## System requirements

### Runtime

- **Runtime**: Node.js 18 or later (Node.js 22+ recommended)
- **Memory**: sufficient for EXIF extraction (~50 MB per extraction)
- **CPU time**: target < 100 ms per extraction

### Storage

- **Object storage**: S3 or compatible — for original images
- **Database**: PostgreSQL — for EXIF metadata
- **KV / cache**: optional, for caching extracted results

---

## Image format support

| Format | EXIF support |
|--------|-------------|
| JPEG | Full |
| TIFF | Full |
| PNG | None |
| WebP | Limited |
| GIF | None |
| HEIC/HEIF | Supported if converted to JPEG first |

---

## Client device support

| Platform | EXIF preservation |
|----------|-------------------|
| iOS | Preserved in JPEG uploads |
| Android | Preserved in JPEG uploads |
| Web | Preserved when not stripped by the browser |

---

## Version compatibility

| Dependency | Minimum | Recommended |
|------------|---------|-------------|
| Node.js | 18 | 22+ |
| TypeScript | 5.0 | Latest stable |
| Prisma | 5.x | Current |

---

## Security considerations

- Run `npm audit` regularly to catch upstream vulnerabilities in `exifr`.
- Validate EXIF data structure on ingestion.
- Sanitize all string fields extracted from EXIF.
- Validate GPS coordinates before storing or displaying.

---

## Performance

- **Package size**: ~50 KB minified; tree-shaking supported.
- **Extraction time**: target < 100 ms per image.
- **Memory per extraction**: ~50 MB.
- **CPU impact**: minimal for typical social-app upload volumes.

---

## External services

No external APIs are required for EXIF extraction. Optional future integrations (such as reverse geocoding) are supplied by the consuming application, not Trellis core.

---

## Further reading

- [exifr documentation](https://mutiny.github.io/exifr/)
