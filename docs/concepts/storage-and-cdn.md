---
title: Storage and CDN
description: How Trellis stores and delivers media using S3 and CloudFront.
sidebar: Storage & CDN
order: 13
---

# Storage & CDN: S3 + CloudFront

## S3 Buckets

### Media Bucket

Stores user-uploaded photos/videos and processed derivatives.

```
Versioning:         Enabled (with noncurrent version expiration)
Encryption:         SSE-S3 (AES-256)
Public access:      Blocked (served via CloudFront OAC)
CORS:               Allowed origins for presigned URL uploads
```

**Key structure:**

All media keys are content-addressed and tenant-scoped, built only through the
canonical key builder (`apps/api/src/lib/media/cas-keys.ts`):

```
cas/{tenantId}/{sha256}              # Approved, served bytes (the CDN-served prefix)
cas/{tenantId}/{sha256}/{preset}     # Derivative preset (thumbnail | optimized)
pending/{tenantId}/{uploadId}        # Raw video/audio awaiting processing (never served)
```

Only `cas/` is served, and only when the object is `APPROVED` (see
[Media Moderation](media-moderation.md)). Images are re-encoded synchronously
on upload and written straight to `cas/{tenantId}/{hash}`; video/audio are
written to `pending/{tenantId}/{uploadId}` and promoted to `cas/` by the
processing pipeline only after both moderation tracks approve. The completion
worker writes the *cleaned, moderated* bytes to `cas/` — so the bytes served
are always the bytes that were moderated.

**Lifecycle rules:**
- Incomplete multipart uploads: abort after 1 day
- Automatic transition to S3 Intelligent-Tiering for infrequently accessed media

### Export Bucket

Temporary storage for user data exports (GDPR/data portability).

```
Versioning:         Disabled
Encryption:         SSE-S3
Public access:      Blocked
Lifecycle:          Auto-delete after a short retention window
```

### Web App Bucket

Hosts the web client build output.

```
Versioning:         Enabled (for rollback)
Encryption:         SSE-S3
Public access:      Blocked (served via CloudFront OAC)
```

## Media Upload Flow

Clients upload through the API: a `multipart/form-data` POST to
`/api/media/upload`, authenticated by session. (`/api/media/upload/batch`
returns `501 Not Implemented` — the legacy batch path wrote to `cas/` without
moderation and was removed; batch semantics will be rebuilt on a presigned
direct-to-S3 flow.) The handler validates the file (signature/MIME, per-user
rate limits from `Env.media`), then routes the upload by content type.

**Image uploads** are handled synchronously: the API re-encodes the image to a
canonical raster format (stripping EXIF/GPS and any embedded payload), hashes
the cleaned output, stages it, moderates the staged object, and only on an
`APPROVED` verdict promotes it to `cas/{tenantId}/{hash}` through the storage
adapter (an S3-backed, Cloudflare-R2-compatible interface from
`@de-otio/saas-foundation/storage`).

**Video and audio uploads** are stored to the `pending/{tenantId}/{uploadId}`
prefix and processed asynchronously:

```
1. Client app  →  POST /api/media/upload (multipart)  →  Fargate API
2. Fargate     →  validate (signature, MIME, rate limit) + route by type
3. Fargate     →  store raw bytes to pending/{tenant}/{upload}; row = PENDING
4. S3          →  Event notification (pending/ prefix)  →  SQS (media-processing)
5. SQS         →  triggers media-processing-worker Lambda
6. Lambda      →  transcode-and-discard, hash cleaned bytes,
                   start VISUAL + AUDIO moderation tracks
7. Completion  →  on both-tracks-approved, promote cleaned bytes to cas/
```

The S3 event notification fires on the `pending/` prefix (the prefix the upload
path actually writes for video/audio), so the processing pipeline is triggered
for every async upload.

> **Note.** The codebase uploads **through the API**, not via presigned
> direct-to-S3 PUT URLs. There is no `/api/media/upload-url` endpoint and no
> `getSignedUrl`/presigned-POST path in the shipped code. The request body cap
> in `server.ts` (`MAX_BODY_SIZE`) therefore applies to uploads.

Properties of this flow:
- File is validated and re-encoded at the API boundary before it is stored
- Video/audio processing is async — a slow transcode never blocks the response
- Nothing is served until it is `APPROVED` (the fail-closed serve gate)

## Media processing

Image processing happens synchronously in the API handler (the canonical
re-encode pass). Video/audio processing happens in the Lambda pipeline: the
processing worker transcodes the upload to a clean form on a transient staging
key, then starts the moderation tracks; the completion worker promotes the
cleaned bytes to `cas/` only after approval. The moderation lifecycle, the
dual-track model, and the fan-in semantics are described in
[Media Moderation](media-moderation.md).

## CloudFront Distribution

A single CloudFront distribution serves both the web app and media.

### Behaviors

| Path Pattern | Origin | Cache Policy | Notes |
|-------------|--------|-------------|-------|
| `/api/*` | ALB (Fargate) | No cache (the media serve route caches its own approved responses) | API requests, including `GET /api/media/{hash}` |
| `/.well-known/*` | ALB (Fargate) | No cache | ActivityPub WebFinger |
| `/users/*` | ALB (Fargate) | No cache | ActivityPub actors |
| `/*` (default) | S3 (web bucket) | Short-lived (1 day) | Web app |

Media is served through the API route `GET /api/media/{hash}`, **not** a direct
`/media/*` S3 behavior. Routing the served bytes through the API is what lets
the fail-closed serve gate run on every request: the S3 `cas/` bucket stays
private (no public read behavior), and only an `APPROVED` object yields bytes.

### Configuration

```
HTTP/2:                 Enabled
HTTP/3 (QUIC):          Enabled
Compression:            Brotli + gzip
Origin Access Control:  OAC for both S3 origins
TLS certificate:        ACM
```

### Origin Access Control (OAC)

OAC ensures S3 buckets remain private — only CloudFront can read from them:

```typescript
const mediaOac = new cloudfront.S3OriginAccessControl(this, 'MediaOac', {
  signing: cloudfront.Signing.SIGV4_ALWAYS,
});
```

The S3 bucket policy restricts `s3:GetObject` to only the specific CloudFront distribution. Uploads do not bypass CloudFront via presigned URLs — they go through the API, which writes to the bucket server-side (see Media Upload Flow).

### Media Serving

Approved media is served by the API serve route, which reads the `MediaFile`
row, applies the [fail-closed serve gate](media-moderation.md) (`APPROVED` and
not hidden / soft-deleted), and streams the `cas/` object. Because the keys are
content-addressed (SHA-256), an approved response is immutable and can be cached
aggressively:

- `Cache-Control: public, max-age=31536000, immutable`
- Caches indefinitely; invalidation is never needed for an approved object

A non-`APPROVED` object returns a uniform "not found" response (see the serve
gate), so it is never cached as servable bytes.
