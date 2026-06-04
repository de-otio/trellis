# Approach E: Overview

## How It Works

1. At upload, the media processing worker encrypts all derivatives (original, optimized, thumbnail) with the post's DEK
2. Encrypted media is stored in the object store as opaque blobs
3. The CDN serves encrypted media with **long-lived cache TTLs** (content-addressed, immutable -- same as today)
4. When the client needs to display media, it:
   a. Fetches the post's DEK from the API (authenticated, short-lived)
   b. Downloads the encrypted media from the CDN (fast, cached at edge)
   c. Decrypts locally in memory
   d. Renders the decrypted image/video
5. At sunset, the API stops issuing the DEK for that post. The ciphertext remains cached at CDN edges, but it's useless without the key.

## Why This Is Interesting

Client-side decryption solves the core tension that made all server-side approaches problematic: **CDN caching and encryption become compatible.**

| Problem | Server-side decryption | Client-side decryption |
|---|---|---|
| CDN caching | Can't cache decrypted content (sunset breaks it). Can't cache encrypted content (clients can't use it). Short TTLs only. | **Cache encrypted content with long TTLs.** Ciphertext is useless without the key. |
| Origin load | Every request hits origin for decryption | Only key requests hit origin. Media served from CDN edge. |
| Bandwidth cost | Server decrypts and re-streams | The CDN serves directly from the object store via origin access control. No origin compute. |
| Sunset speed | Depends on CDN cache invalidation (seconds to minutes) | **Instant.** Stop issuing the DEK. Cached ciphertext is inert. |
| Processing pipeline | Worker must encrypt derivatives | Worker must encrypt derivatives (same) |

The big win: **the CDN's 1-year cache TTL can stay.** Encrypted media is immutable and content-addressed, just like today's plaintext media. The cacheability problem disappears entirely.
