# Approach E: Client-Side Decryption

Store media encrypted in the object store, serve ciphertext via the CDN, decrypt on the client device. The only approach that provides encryption at rest **and** preserves full CDN cacheability.

Not recommended for initial launch (access control is simpler and sufficient for the threat model), but the strongest candidate for a future encryption upgrade.

## Documents

1. [Overview](01-overview.md) -- How it works, why it's interesting
2. [Device Performance](02-device-performance.md) -- Can phones and browsers handle AES-256 decryption?
3. [Key Delivery API](03-key-delivery-api.md) -- Endpoint design, batching, caching, security
4. [Processing Pipeline](04-processing-pipeline.md) -- Changes to the media processing worker
5. [Client Changes](05-flutter-client.md) -- Encrypted image/video loading in the consumer client (mobile + web)
6. [Comparison](06-comparison.md) -- Trade-offs vs Approach B (signed URLs) and Approach D (server-side decryption)
7. [Assessment](07-assessment.md) -- When to adopt, what to build first, migration path
8. [Public Content Bypass](08-public-content-bypass.md) -- Skip encryption for public posts; encrypt only authenticated/friends-only
9. [No Dedup](09-no-dedup.md) -- Why we intentionally omit media deduplication
