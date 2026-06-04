# Current Media Architecture

Understanding what exists today is essential, because any encryption scheme must integrate with it -- not replace it. The reference architecture below is AWS-based (S3 + CloudFront + a queue-driven processing worker); a consuming application on a different stack maps these to equivalent services.

- **Storage**: Object store (e.g. S3), content-addressed (`originals/{sha256}.{ext}`, `thumbnails/{sha256}.webp`, `optimized/{sha256}.webp`)
- **Serving**: CDN distribution (e.g. CloudFront), `/media/*` path, **1-year cache TTL** (immutable content-addressed files)
- **Upload flow**: Client -> presigned PUT URL -> object store -> queue -> media processing worker (Sharp processing) -> thumbnail + optimized WebP
- **Database**: `MediaFile` model with object-store keys, dimensions, metadata; `PostMedia` join table
- **Access control**: Object store is private, CDN origin access control is the only access path

Key tension: the current architecture assumes media files are **immutable and publicly cacheable**. The ephemeral content scheme requires that media can become **unservable** on demand.
