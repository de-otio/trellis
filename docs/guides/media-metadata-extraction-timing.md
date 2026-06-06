---
title: Media Metadata Extraction Timing
description: When and how to extract EXIF/IPTC/video metadata to prevent data loss during media processing.
sidebar: Media Metadata Extraction
order: 60
---

# Media Metadata Extraction Timing

## Problem

Metadata (EXIF, IPTC, video metadata) can be **lost** if it is extracted after a media file has been:

- Compressed (JPEG quality reduction)
- Resized (dimension changes)
- Re-encoded (format conversion, codec changes)
- Optimized (server-side image optimization)

## Best practice: extract from the original

**Extract metadata from the original, unprocessed file before any transformations.**

Trellis uses a **hybrid strategy**: the client extracts metadata from the original file and sends it alongside the upload; the server falls back to extracting from the received buffer if no client metadata is present.

## Architecture

### Client (primary)

1. Extract metadata from the original, uncompressed file buffer.
2. Compress or optimize the image for upload.
3. Send the compressed file **and** the extracted metadata as a separate field in the upload request.

**Client example (Dart):**

```dart
// 1. Extract metadata from the original bytes BEFORE compression
final originalBytes = await image.readAsBytes();
final metadata = await extractMetadata(originalBytes);

// 2. Compress
final compressedBytes = await compressImage(originalBytes);

// 3. Upload both
await uploadImage(
  imageBytes: compressedBytes,
  metadata: metadata,
);
```

### Server (fallback)

The upload handler checks for client-provided metadata first; if absent, it extracts from the received buffer before any server-side processing.

```typescript
interface UploadRequest {
  file: File;
  metadata?: {
    exif?: EXIFData;
    iptc?: IPTCData;
    video?: VideoMetadata;
  };
}

async function handleMediaUpload(request: Request, env: Env) {
  const formData = await request.formData();
  const file = formData.get("file") as File;
  const clientMetadataJson = formData.get("metadata");

  // CRITICAL: extract BEFORE any server-side processing
  let metadata;
  if (clientMetadataJson) {
    metadata = JSON.parse(clientMetadataJson as string);
  } else {
    const fileBuffer = await file.arrayBuffer();
    const extractor = new MetadataExtractor(env);
    metadata = await extractor.extractAll(fileBuffer, file.type);
  }

  // Proceed to store the file and metadata ...
}
```

## Why the hybrid approach

| Property | Benefit |
|----------|---------|
| Best fidelity | Client extracts from the truly original, uncompressed file |
| Backward compatible | Clients that do not yet send metadata still receive server-side extraction |
| Robust | Server fallback ensures metadata is attempted even if client extraction fails |
| Independently deployable | Client and server updates can be rolled out separately |

## Testing requirements

| Scenario | Expected result |
|----------|----------------|
| Original file with metadata → extract before compression | Metadata preserved |
| Compressed file, no client metadata → server extracts | Metadata present (may be partial) |
| Client sends metadata separately | Server uses client metadata |
| Compression library strips metadata | Graceful handling, no crash |
| Format conversion (e.g. JPEG → WebP) | Metadata handling correct for target format |

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
