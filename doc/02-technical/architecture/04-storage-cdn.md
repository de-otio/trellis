# Storage & CDN: S3 + CloudFront

## S3 Buckets

### Media Bucket

Stores user-uploaded photos/videos and processed derivatives.

```
Versioning:         Enabled (30-day noncurrent version expiration)
Encryption:         SSE-S3 (AES-256)
Public access:      Blocked (served via CloudFront OAC)
CORS:               Allowed origins for presigned URL uploads
Backup:             AWS Backup daily, 30-day retention (prod only)
```

**Key structure**:
```
originals/{sha256hash}              # Original upload
thumbnails/{sha256hash}.webp        # 300px thumbnail
optimized/{sha256hash}.webp         # 1200px optimized
```

**Lifecycle rules**:
- Incomplete multipart uploads: abort after 1 day
- Transition to S3 Intelligent-Tiering after 90 days (auto-moves infrequent media to cheaper storage)

### Export Bucket

Temporary storage for user data exports (GDPR).

```
Versioning:         Disabled
Encryption:         SSE-S3
Public access:      Blocked
Lifecycle:          Auto-delete after 7 days
```

### Web App Bucket

Hosts the Flutter web build output.

```
Versioning:         Enabled (for rollback)
Encryption:         SSE-S3
Public access:      Blocked (served via CloudFront OAC)
```

## Media Upload Flow

The current architecture uploads media through the Worker. The new design uses **presigned URLs** for direct-to-S3 uploads, which is more efficient and avoids payload limits.

```
1. Flutter app  →  POST /api/media/upload-url    →  Fargate API
2. Fargate      →  generates presigned S3 PUT URL (60 sec expiry, scoped to key)
3. Flutter app  →  PUT (binary)                   →  S3 (direct)
4. S3           →  Event notification             →  SQS (media-processing)
5. SQS          →  triggers mediaProcessingWorker Lambda
6. Lambda       →  downloads from S3, processes with Sharp
                    → uploads thumbnail + optimized to S3
                    → updates MediaFile record in RDS
```

### Presigned URL Security

```typescript
const command = new PutObjectCommand({
  Bucket: MEDIA_BUCKET,
  Key: `originals/${mediaId}`,
  ContentType: contentType,
  // Restrict to exact content type and key
});

const url = await getSignedUrl(s3Client, command, {
  expiresIn: 60,  // 1 minute — short expiry limits abuse window
});
```

- **Short expiry (60s)** — minimizes the window if a URL is leaked
- **Scoped to specific key** — URL can only write to the intended S3 key
- **Content-Type enforced** — prevents uploading unexpected file types
- **CloudTrail logging** — all S3 PutObject calls are logged for audit

**Benefits**:
- No 6 MB / 10 MB Lambda payload limit for uploads
- Upload goes directly to S3 (faster, cheaper)
- Processing is fully async
- Failed processing doesn't lose the original

## Image Processing (Sharp)

Sharp runs in Lambda with these operations:

| Operation | Output | Max Dimension | Format |
|-----------|--------|---------------|--------|
| Thumbnail | `thumbnails/{hash}.webp` | 300px | WebP, quality 80 |
| Optimized | `optimized/{hash}.webp` | 1200px | WebP, quality 85 |
| EXIF extract | Stored in MediaFile record | — | JSON metadata |

**Sharp on Lambda**: Include `sharp` with the `linux-arm64` platform binary. Bundle size ~7 MB.

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

Single distribution serving both the web app and media.

### Behaviors

| Path Pattern | Origin | Cache Policy | Notes |
|-------------|--------|-------------|-------|
| `/api/*` | ALB (Fargate) | No cache | API requests |
| `/.well-known/*` | ALB (Fargate) | No cache | ActivityPub WebFinger |
| `/users/*` | ALB (Fargate) | No cache | ActivityPub actors |
| `/media/*` | S3 (media bucket) | CachingOptimized (1 year) | Immutable content-addressed |
| `/*` (default) | S3 (web bucket) | CachingOptimized (1 day) | Flutter web app |

### Configuration

```
Price class:            PriceClass_100 (US + Europe only — cheapest)
HTTP/2:                 Enabled
HTTP/3 (QUIC):          Enabled
Compression:            Brotli + gzip
Origin Access Control:  OAC for both S3 origins
Custom domain:          example.com, api.example.com
TLS certificate:        ACM (free)
WAF:                    Not initially (adds $5+/month); use ALB as throttle point
```

### CloudFront OAC (Origin Access Control)

OAC ensures S3 buckets remain private — only CloudFront can read from them. Without this, a misconfigured bucket policy could expose all media publicly.

```typescript
// CDK
const mediaOac = new cloudfront.S3OriginAccessControl(this, 'MediaOac', {
  signing: cloudfront.Signing.SIGV4_ALWAYS,
});

const distribution = new cloudfront.Distribution(this, 'Cdn', {
  defaultBehavior: {
    origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    responseHeadersPolicy: securityHeadersPolicy,
  },
  additionalBehaviors: {
    '/media/*': {
      origin: origins.S3BucketOrigin.withOriginAccessControl(mediaBucket, {
        originAccessControl: mediaOac,
      }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    },
    '/api/*': {
      origin: new origins.HttpOrigin(alb.loadBalancerDnsName, {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    },
  },
  certificate: acmCertificate,
  domainNames: ['example.com', 'api.example.com'],
  priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
  httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
});

// S3 bucket policy — only allow CloudFront via OAC
mediaBucket.addToResourcePolicy(new iam.PolicyStatement({
  actions: ['s3:GetObject'],
  resources: [`${mediaBucket.bucketArn}/*`],
  principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
  conditions: {
    StringEquals: {
      'AWS:SourceArn': distribution.distributionArn,
    },
  },
}));
```

**Key points**:
- `S3BucketOrigin.withOriginAccessControl` — uses OAC (not the older OAI)
- S3 bucket policy restricts `s3:GetObject` to only the specific CloudFront distribution ARN
- Presigned PUT URLs for uploads bypass CloudFront entirely (direct to S3)

### Media Serving

Since media keys are content-addressed (SHA-256), they are immutable and can be cached aggressively:
- `Cache-Control: public, max-age=31536000, immutable`
- CloudFront caches indefinitely; invalidation never needed for media

## Cost Optimization

- **S3 Intelligent-Tiering**: Free for objects > 128 KB. Automatically moves infrequently accessed media to cheaper storage.
- **CloudFront free tier**: 1 TB/month transfer, 10M requests/month — likely sufficient pre-launch.
- **Presigned URLs**: No Lambda invocation or data transfer cost for uploads.
- **WebP format**: ~30% smaller than JPEG — less S3 storage, less CloudFront transfer.
