---
title: Media Metadata Extraction Timing
description: When and how to extract EXIF/IPTC/video metadata to prevent data loss during media processing.
sidebar: Media Metadata Extraction
order: 60
---

# Media Metadata Extraction Timing

> **Important — extracted metadata is computed, then discarded.** In the current
> code only `width`, `height`, and `duration` are persisted to the `MediaFile`
> row. The full EXIF/IPTC/video metadata is extracted in memory (best effort)
> and then thrown away; the `exifData` / `iptcData` / `videoMetadata` columns
> are never written by any current code path. This page documents *when* to
> extract metadata if/when persistence is wired up — it does not describe a
> shipped metadata store. See the
> [Media metadata data model](../reference/media-data-model.md) for the full
> picture.

## Problem

Metadata (EXIF, IPTC, video metadata) can be **lost** if it is extracted after a media file has been:

- Compressed (JPEG quality reduction)
- Resized (dimension changes)
- Re-encoded (format conversion, codec changes)
- Optimized (server-side image optimization)

## Best practice: extract from the original

**Extract metadata from the original, unprocessed file before any transformations.**

Compressing, resizing, or re-encoding on the client can strip embedded
metadata. If preserving capture metadata matters, the client should extract it
from the original bytes *before* it compresses for upload.

## How extraction works today

Trellis extracts metadata **server-side** (the extracted values are not
persisted — see the callout above). For images the extraction runs on the
**re-encoded** bytes, so dimensions come from the clean canonical output (EXIF
orientation already baked in, EXIF/GPS already stripped). The upload handler
reads the `file` field, re-encodes images, then runs extraction:

```typescript
async function handleMediaUpload(request: Request, env: Env) {
  const formData = await request.formData();
  const file = formData.get("file") as File;

  const fileBuffer = await file.arrayBuffer();

  // Extract from the received buffer (best effort, non-fatal)
  let extracted: any = {};
  try {
    const { MetadataExtractor } = await import(
      "../metadata/metadata-extractor.js"
    );
    const extractor = new MetadataExtractor(env);
    extracted = await extractor.extractAll(fileBuffer, mimeType);
  } catch {
    // Continue without metadata
  }

  // Proceed to store the file ...
}
```

> **Flag — there is no client-supplied-metadata path.** The shipped upload
> handler (`apps/api/src/lib/routes/media.ts`) does **not** read a `metadata`
> form field; the "hybrid" client-primary / server-fallback design is not
> implemented. Server-side extraction is the only path. Consequently, if a
> client strips metadata before upload, that metadata is lost — the server has
> only the received buffer to work from.

> **Flag — extracted metadata is not currently persisted.** Even on the
> server path, only `width`, `height`, and `duration` from the extraction
> result are written to the `MediaFile` record. The EXIF/IPTC/video JSON is
> computed and then discarded. See the
> [Media metadata data model](../reference/media-data-model.md) for details.

## Implications

| Property | Note |
|----------|------|
| Fidelity | Bounded by whatever the client uploaded; the server cannot recover metadata the client already stripped |
| Robustness | Extraction is best-effort and non-fatal — a failed or empty extraction never fails the upload |
| Persistence | EXIF/IPTC/video payloads are not stored yet (see flag) |

## Testing requirements

| Scenario | Expected result |
|----------|----------------|
| Upload with embedded metadata → server extracts | Extraction runs (may be partial) |
| Client stripped metadata before upload | No metadata available server-side; upload still succeeds |
| Compression library strips metadata | Graceful handling, no crash |
| Corrupt or unsupported file | Extraction fails gracefully; upload still succeeds |

## Handling metadata loss gracefully

If metadata extraction fails (e.g. unsupported format, corrupt file), log a warning and continue the upload without metadata. Do not fail the upload.

```typescript
try {
  metadata = await extractor.extractAll(fileBuffer, mimeType);
} catch (error) {
  logger.warn("Metadata extraction failed", { error });
  // Continue without metadata
}
```
