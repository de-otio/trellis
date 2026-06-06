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

```
media/{sha256hash}.{ext}            # Original upload (written by the API upload service)
thumbnails/{sha256hash}.webp        # Small thumbnail (written by the Lambda worker)
optimized/{sha256hash}.webp         # Full-resolution optimized (written by the Lambda worker)
```

> The API upload path (`MediaUploadService`) writes the original to
> `media/{hash}.{ext}` and serves it via `/api/media/{hash}`. The
> `media-processing-worker` Lambda, however, triggers on an `originals/` prefix
> — a prefix the current upload path does not write. So in the shipped code the
> Sharp derivative pipeline is **not actually triggered by API uploads**. This
> is a wiring gap to reconcile (align the upload key prefix and the S3-event
> trigger) before relying on async thumbnails.

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
`/api/media/upload` (or `/api/media/upload/batch`), authenticated by session.
The handler validates the file (signature/MIME, rate limits — 10 uploads / 60s
per user), then stores the object to the media bucket through the storage
adapter (`MediaUploadService` → `MEDIA_BUCKET_R2`, an S3-backed,
Cloudflare-R2-compatible interface from `@de-otio/saas-foundation/storage`).

```
1. Client app  →  POST /api/media/upload (multipart)  →  Fargate API
2. Fargate     →  validate (signature, MIME, rate limit)
3. Fargate     →  store object to media bucket (S3 via the storage adapter)
4. S3          →  Event notification (originals/ prefix)  →  SQS (media-processing)
5. SQS         →  triggers media-processing-worker Lambda
6. Lambda      →  downloads from S3, processes with Sharp
                   → uploads thumbnail + optimized to S3
```

> **Wiring gap.** Steps 4–6 are real code, but the upload service writes the
> original under `media/{hash}.{ext}` while the worker triggers on the
> `originals/` prefix — so today an API upload does not actually fire the Sharp
> pipeline. See the key-structure note above.

> **Note.** The codebase uploads **through the API**, not via presigned
> direct-to-S3 PUT URLs. There is no `/api/media/upload-url` endpoint and no
> `getSignedUrl`/presigned-POST path in the shipped code. The 10 MB request body
> cap in `server.ts` (`MAX_BODY_SIZE`) therefore applies to uploads. Async
> Sharp processing via the S3-event → `media-processing` SQS → Lambda pipeline
> (`apps/api/src/lambda/media-processing-worker.ts`) is real and runs after the
> object lands in the bucket.

Properties of this flow:
- File is validated at the API boundary before it is stored
- Processing is async — a slow Sharp run never blocks the upload response
- Failed processing doesn't lose the original

## Image Processing (Sharp)

Sharp runs in Lambda with these operations:

| Operation | Output | Resize | Format |
|-----------|--------|--------|--------|
| Thumbnail | `thumbnails/{hash}.webp` | 300×300, `fit: cover` | WebP q80 |
| Optimized | `optimized/{hash}.webp` | 1200×1200, `fit: inside`, no enlargement | WebP q85 |

As implemented in `media-processing-worker.ts`:

```typescript
const thumbnail = await sharp(buffer)
  .resize(300, 300, { fit: 'cover' })
  .webp({ quality: 80 })
  .toBuffer();

const optimized = await sharp(buffer)
  .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
  .webp({ quality: 85 })
  .toBuffer();
```

## CloudFront Distribution

A single CloudFront distribution serves both the web app and media.

### Behaviors

| Path Pattern | Origin | Cache Policy | Notes |
|-------------|--------|-------------|-------|
| `/api/*` | ALB (Fargate) | No cache | API requests |
| `/.well-known/*` | ALB (Fargate) | No cache | ActivityPub WebFinger |
| `/users/*` | ALB (Fargate) | No cache | ActivityPub actors |
| `/media/*` | S3 (media bucket) | Long-lived (1 year) | Immutable content-addressed |
| `/*` (default) | S3 (web bucket) | Short-lived (1 day) | Web app |

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

Since media keys are content-addressed (SHA-256), they are immutable and can be cached aggressively:

- `Cache-Control: public, max-age=31536000, immutable`
- CloudFront caches indefinitely; invalidation is never needed for media
