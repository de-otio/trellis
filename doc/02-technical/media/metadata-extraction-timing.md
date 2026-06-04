# Metadata Extraction Timing

**Purpose:** Define when and how metadata should be extracted to prevent data loss.

**Status:** 📋 **Best Practice Document**

---

## Problem Statement

Metadata (EXIF, IPTC, video metadata) can be **lost** if extracted after media files are:

- **Compressed** (JPEG compression, quality reduction)
- **Resized** (dimension changes)
- **Reencoded** (format conversion, codec changes)
- **Optimized** (server-side image optimization)

## Current Implementation

### Client-Side Processing

A typical consuming client (e.g. a Flutter app):

1. **Compresses images** before upload (if > 1MB)
2. Compresses with an EXIF-preserving option (e.g. `keepExif: true`)
3. **However**: Some compression libraries may still lose metadata

### Server-Side Processing

The API currently:

1. Receives file from client (may already be compressed)
2. Stores file in object storage (S3 or compatible)
3. Queues image optimization (asynchronous)
4. **Extracts metadata from received file** (may be compressed)

---

## Best Practice: Extract from Original

### Principle

**Extract metadata from the ORIGINAL, UNPROCESSED file before any transformations.**

### Why This Matters

1. **Metadata Preservation**: Original files contain complete metadata
2. **Data Loss Prevention**: Processing can strip or corrupt metadata
3. **Accuracy**: Original metadata is most accurate and complete
4. **User Trust**: Users expect metadata to be preserved

---

## Selected Approach: Hybrid Strategy

**Definition:** Extract on client if available, fallback to server extraction.

### Architecture

1.  **Client-Side Extraction (Primary)**:
    - Client extracts metadata from the original, uncompressed file.
    - Client sends metadata as a separate field in the upload request.
    - Client compresses/optimizes the image for upload.

2.  **Server-Side Extraction (Fallback)**:
    - Server checks for client-provided metadata.
    - If present, server uses client metadata.
    - If absent, server extracts metadata from the received file buffer (before any server-side processing).

### Implementation

**Client (Flutter):**

```dart
// 1. Extract metadata from original file
final originalBytes = await image.readAsBytes();
final metadata = await extractMetadata(originalBytes); // Extract before compression

// 2. Compress image (metadata already extracted)
final compressedBytes = await compressImage(originalBytes);

// 3. Upload both compressed file AND metadata
await uploadImage(
  imageBytes: compressedBytes,
  metadata: metadata, // Send separately
);
```

**Server:**

```typescript
// Accept metadata in upload request
interface UploadRequest {
  file: File;
  metadata?: {
    exif?: EXIFData;
    iptc?: IPTCData;
    video?: VideoMetadata;
  };
}

// In upload handler
async function handleMediaUpload(request: Request, env: Env) {
  const formData = await request.formData();
  const file = formData.get("file") as File;
  const clientMetadataJson = formData.get("metadata");

  // Use client-provided metadata if available, otherwise extract from received file
  let metadata;
  if (clientMetadataJson) {
    metadata = JSON.parse(clientMetadataJson as string);
  } else {
    const fileBuffer = await file.arrayBuffer();
    const extractor = new MetadataExtractor(env);
    metadata = await extractor.extractAll(fileBuffer, file.type);
  }

  // ... proceed to store file and metadata ...
}
```

### Benefits

- ✅ **Best practice**: Metadata from truly original file via client extraction.
- ✅ **Backward compatible**: Works for clients that haven't upgraded yet.
- ✅ **Robust**: Server fallback ensures metadata is attempted even if client fails.
- ✅ **Progressive enhancement**: Can roll out client update independently of server.

---

## Current Specification Status

### What's Currently Specified

The specification now mandates the **Hybrid Approach**:

1. **Primary**: Client extracts from original file buffer (before compression).
2. **Fallback**: Server extracts from received file buffer (before any server-side processing).
3. **Timing**: Metadata is secured before database storage or permanent object-storage upload.

### What Should Be Updated

The specification clarifies:

1. **Extract from original file buffer** (before any server-side processing)
2. **Document client-side compression** and its impact
3. **Recommend client-side extraction** as enhancement
4. **Handle metadata loss** gracefully

---

## Implementation Recommendations

### Phase 1: Server-Side Extraction (Current)

✅ Extract from original file buffer received from client
✅ Extract BEFORE any server-side processing
✅ Document that client compression may affect metadata

### Phase 2: Client-Side Extraction (Enhancement)

✅ Add client-side metadata extraction
✅ Send metadata in upload request
✅ Prefer client metadata over server extraction
✅ Fallback to server extraction if client metadata missing

### Phase 3: Metadata Preservation Verification

✅ Verify metadata preservation after compression
✅ Test with various compression settings
✅ Warn users if metadata is lost
✅ Provide option to preserve original file

---

## Code Changes Required

### Server-Side (Current Implementation)

```typescript
// apps/api/src/lib/routes/media.ts

async function handleMediaUpload(request: Request, env: Env) {
  // ... authentication, rate limiting ...

  // Get original file from request
  const formData = await request.formData();
  const file = formData.get("file") as File;
  const originalFileBuffer = await file.arrayBuffer();
  const mimeType = file.type;

  // ⚠️ CRITICAL: Extract metadata from ORIGINAL file BEFORE any processing
  const extractor = new MetadataExtractor(env);
  let metadata = null;

  try {
    // Check if client provided metadata (future enhancement)
    const clientMetadata = formData.get("metadata");
    if (clientMetadata) {
      metadata = JSON.parse(clientMetadata as string);
    } else {
      // Extract from original file buffer
      metadata = await extractor.extractAll(originalFileBuffer, mimeType);
    }
  } catch (error) {
    logger.warn("Metadata extraction failed", { error });
    // Continue without metadata
  }

  // Now process/store file (metadata already extracted)
  // ... rest of upload logic ...
}
```

### Client-Side (Future Enhancement)

```dart
// apps/flutter/lib/core/media/metadata_extractor.dart

class MetadataExtractor {
  Future<Map<String, dynamic>> extractMetadata(Uint8List imageBytes) async {
    // Extract EXIF/IPTC using exif package
    // Return metadata as JSON
  }
}

// apps/flutter/lib/core/media/image_upload_service.dart

Future<String> uploadImage({
  String? imagePath,
  Uint8List? imageBytes,
}) async {
  // 1. Extract metadata from original bytes BEFORE compression
  Map<String, dynamic>? metadata;
  if (imageBytes != null) {
    try {
      metadata = await MetadataExtractor().extractMetadata(imageBytes);
    } catch (e) {
      // Continue without metadata
    }
  }

  // 2. Compress image (metadata already extracted)
  final compressedBytes = await _compressImageBytes(imageBytes);

  // 3. Upload with metadata
  final formData = FormData.fromMap({
    'file': MultipartFile.fromBytes(
      compressedBytes,
      filename: fileName,
    ),
    if (metadata != null) 'metadata': jsonEncode(metadata),
  });

  // ... upload ...
}
```

---

## Testing Requirements

### Test Cases

1. **Original file with metadata** → Extract before compression → Verify metadata preserved
2. **Compressed file** → Extract metadata → Verify metadata still present
3. **Client-side extraction** → Send metadata separately → Verify server uses it
4. **Metadata loss scenario** → Compress with metadata-stripping library → Verify graceful handling
5. **Format conversion** → Convert JPEG to WebP → Verify metadata handling

---

## Migration Strategy

### For Existing Implementation

1. **No breaking changes**: Current server-side extraction continues to work
2. **Add client metadata field**: Accept optional metadata in upload request
3. **Prefer client metadata**: Use client metadata if provided, otherwise extract
4. **Document behavior**: Update docs to explain extraction timing

### For New Implementation

1. **Start with server-side**: Extract from original file buffer
2. **Add client-side later**: Enhance with client-side extraction
3. **Progressive enhancement**: Works with or without client metadata

---

## Conclusion

**Best Practice:** Extract metadata from the **ORIGINAL, UNPROCESSED file** before any compression, resizing, or reencoding.

**Selected Design:** The **Hybrid Approach** ensures maximum metadata fidelity by attempting extraction on the client first, with a server-side fallback.

**Priority:** Medium (metadata preservation is important but current approach works for most cases)

---

**Related Documents:**

- [Implementation Details](./implementation-details.md) - Current extraction implementation
- [Security Considerations](./security-considerations.md) - Input validation for metadata
- [Future Enhancements](./future-enhancements.md) - Client-side extraction feature
