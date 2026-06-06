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
originals/{sha256hash}              # Original upload
thumbnails/{sha256hash}.webp        # Small thumbnail
optimized/{sha256hash}.webp         # Full-resolution optimized
```

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

Uploads use **presigned URLs** for direct-to-S3 delivery, avoiding payload limits and reducing API overhead:

```
1. Client app  →  POST /api/media/upload-url    →  Fargate API
2. Fargate     →  generates presigned S3 PUT URL (short expiry, scoped to key)
3. Client app  →  PUT (binary)                   →  S3 (direct)
4. S3          →  Event notification             →  SQS (media-processing)
5. SQS         →  triggers mediaProcessingWorker Lambda
6. Lambda      →  downloads from S3, processes with Sharp
                   → uploads thumbnail + optimized to S3
                   → updates MediaFile record in RDS
```

### Presigned URL Security

```typescript
const command = new PutObjectCommand({
  Bucket: MEDIA_BUCKET,
  Key: `originals/${mediaId}`,
  ContentType: contentType,
});

const url = await getSignedUrl(s3Client, command, {
  expiresIn: 60,  // short expiry — minimizes abuse window
});
```

- **Short expiry** — minimizes the window if a URL is leaked
- **Scoped to specific key** — URL can only write to the intended S3 key
- **Content-Type enforced** — prevents uploading unexpected file types
- **CloudTrail logging** — all S3 PutObject calls are logged for audit

The direct-to-S3 approach also means:
- No API payload size limit for uploads
- Upload goes directly to S3 (faster, cheaper)
- Processing is fully async
- Failed processing doesn't lose the original

## Image Processing (Sharp)

Sharp runs in Lambda with these operations:

| Operation | Output | Max Dimension | Format |
|-----------|--------|---------------|--------|
| Thumbnail | `thumbnails/{hash}.webp` | 300px | WebP |
| Optimized | `optimized/{hash}.webp` | 1200px | WebP |
| EXIF extract | Stored in MediaFile record | — | JSON metadata |

```typescript
import sharp from 'sharp';

export async function processImage(buffer: Buffer) {
  const metadata = await sharp(buffer).metadata();

  const thumbnail = await sharp(buffer)
    .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();

  const optimized = await sharp(buffer)
    .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();

  return { metadata, thumbnail, optimized };
}
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

The S3 bucket policy restricts `s3:GetObject` to only the specific CloudFront distribution. Presigned PUT URLs for uploads bypass CloudFront entirely (direct to S3).

### Media Serving

Since media keys are content-addressed (SHA-256), they are immutable and can be cached aggressively:

- `Cache-Control: public, max-age=31536000, immutable`
- CloudFront caches indefinitely; invalidation is never needed for media
