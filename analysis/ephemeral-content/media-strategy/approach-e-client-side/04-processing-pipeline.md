# Processing Pipeline Changes

The media processing worker needs to encrypt derivatives before writing to the object store. The upload flow and object-store structure remain the same; the change is in what gets written.

## Current Pipeline

```
Client --(presigned PUT)--> object store (originals/{hash}.{ext})
    |
    v
Storage Event --> queue --> worker (Sharp)
    |
    +--> object store (thumbnails/{hash}.webp)     [plaintext]
    +--> object store (optimized/{hash}.webp)      [plaintext]
    +--> DB: update MediaFile record
```

## Encrypted Pipeline

```
Client --(presigned PUT)--> object store (originals/{hash}.{ext})  [plaintext upload]
    |
    v
Storage Event --> queue --> worker (Sharp + AES-256-GCM)
    |
    +--> object store (originals/{hash}.enc)       [encrypted]
    +--> object store (thumbnails/{hash}.enc)      [encrypted]
    +--> object store (optimized/{hash}.enc)       [encrypted]
    +--> object store: delete plaintext original
    +--> DB: update MediaFile record (add IV/auth tag metadata)
```

### Step by Step

1. The worker receives a queue message containing the object-store key and **post ID**
2. The worker downloads the plaintext original from the object store
3. The worker generates thumbnail + optimized WebP (Sharp, as today)
4. The worker fetches the post's DEK from the database (passed via queue message or fetched by post ID)
5. For each derivative (original, thumbnail, optimized):
   a. Generate a random IV (96 bits for GCM)
   b. Encrypt with AES-256-GCM using the DEK
   c. Upload encrypted blob to the object store with the IV and GCM auth tag stored as object metadata (or prepended to the blob)
6. Delete the plaintext original from the object store
7. Update `MediaFile` record with encryption metadata

### DEK Sourcing

The worker needs the post's DEK. Options:

**Option A: Pass DEK in the queue message.**
The API includes the DEK in the queue message when queueing the processing job. Simple, but the DEK transits through the queue (encrypted at rest with queue SSE, but visible to anyone with queue read access).

**Option B: Worker fetches DEK from database.**
The queue message includes only the post ID. The worker queries the database for the DEK. Adds a DB call but keeps the DEK out of the message queue.

**Recommendation: Option B.** The DEK should have minimal transit exposure. The additional DB call is negligible compared to the image processing time.

### Object Format

Two options for storing IV and authentication tag:

**Option A: Object metadata.**
Store the IV and auth tag as custom metadata on the object. Client fetches metadata via a HEAD request before downloading.

**Option B: Prepend to blob.**
First 12 bytes = IV, next 16 bytes = GCM auth tag, remainder = ciphertext. Self-contained; no separate metadata fetch needed.

**Recommendation: Option B.** Self-contained blobs are simpler to cache, copy, and serve. The client reads the first 28 bytes as header, then decrypts the rest.

### Encryption Overhead in the Worker

AES-256-GCM encryption of a 5 MB file takes ~2-3 ms. The worker already spends 500-2000 ms on Sharp image processing. Encryption adds <1% to processing time.

Memory: the file is already in memory for Sharp processing. No additional memory allocation.

### Error Handling

- If encryption fails: don't write to the object store, don't delete the original, mark the MediaFile as failed
- If the DEK is not found (post deleted during processing): discard the job, clean up the plaintext original
- Idempotency: if the worker retries, encrypted blobs are overwritten (content-addressed, deterministic keys)

## Migration Path

When transitioning from plaintext to encrypted media:

1. New posts: all media encrypted from day one
2. Existing posts: media remains plaintext until a background migration job encrypts them
3. Client must handle both: check for `.enc` extension (or a flag on MediaFile) and skip decryption for plaintext media
4. Migration job: iterate through MediaFile records, encrypt, update object-store keys, update DB
