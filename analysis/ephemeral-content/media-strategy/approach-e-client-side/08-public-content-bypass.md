# Public Content: Skip Encryption

Not all content benefits from encryption. Public posts -- especially viral ones -- should skip encryption entirely and serve plaintext media via the CDN, same as today.

## The Problem with Encrypting Public Content

Approach E works well for authenticated content: encrypted media is cached at the CDN edge, and the client fetches the DEK via an authenticated API call. But for public content, encryption creates a bottleneck without providing security value.

Consider an influencer's public post that gets 1M views:

| | No encryption (public) | Approach E (encrypted) |
|---|---|---|
| Media serving | CDN edge, cached, zero origin load | CDN edge, cached, zero origin load |
| Key delivery | N/A | **1M API calls to `/api/posts/{id}/media-key`** |
| Authentication | None required | Each viewer must authenticate to get key |
| Origin load | Near zero | Significant |

You could cache the DEK at the CDN too (since it's public, same key for everyone), but then you're serving encrypted content with a publicly-cached key. That's encryption theatre -- complexity and cost with no security benefit.

## Design: Per-Post Visibility Determines Encryption

The post's visibility setting controls whether media is encrypted:

| Visibility | Media storage | Media serving | Key delivery |
|---|---|---|---|
| **Public** | Plaintext in object store | CDN, long TTL, no auth required | N/A |
| **Authenticated** (logged-in users only) | Encrypted in object store | CDN (ciphertext), long TTL | API, authenticated |
| **Friends-only** | Encrypted in object store | CDN (ciphertext), long TTL | API, authenticated + friendship check |
| **Sunset** | Encrypted in object store (or deleted) | Not served publicly | API, owner only |

This is not a new concept -- it's how the API already works. Public content doesn't require a session; authenticated content does. Encryption simply follows the same boundary.

## Processing Pipeline

The media processing worker checks the post's visibility before deciding whether to encrypt:

1. Receive queue message with object-store key and post ID
2. Fetch post metadata (visibility setting)
3. Generate derivatives (Sharp, as today)
4. **If public**: write plaintext derivatives to the object store (current behaviour)
5. **If authenticated/friends-only**: encrypt derivatives with the post's DEK, write ciphertext to the object store
6. Update `MediaFile` record with `encrypted` flag

### Visibility Changes

If a user changes a post from public to friends-only (or vice versa), the media needs re-processing:

- **Public → authenticated**: Queue a re-encryption job. Encrypt the plaintext media with the post's DEK, replace in the object store, update `MediaFile.encrypted = true`. Invalidate CDN cache for those paths (old plaintext must not be served from edge).
- **Authenticated → public**: Queue a decryption job. Decrypt the media, write plaintext to the object store, update `MediaFile.encrypted = false`. DEK can be retained (for potential future re-encryption) or deleted.

This is an async operation -- the post's visibility updates immediately in the database, and the media transitions in the background. During the transition window, the API can temporarily serve media via signed URLs (Approach B fallback) until re-processing completes.

## Impact on Sunset

Public posts can still be sunset. The sunset mechanism depends on the media's encryption state:

- **Encrypted media** (was authenticated/friends-only): stop issuing DEKs. Instant. Ciphertext at CDN edge is inert.
- **Plaintext media** (was public): stop serving media URLs in API responses. Invalidate CDN cache for those paths. Deferred object-store deletion after grace period. Slightly slower than the encrypted path, but public content was publicly cached anyway -- the Approach B model applies here.

If a post was public for its lifetime, its media was publicly cached. Sunset removes it from the API and triggers CDN invalidation, but cached copies at edge locations may persist for minutes. This is the same trade-off accepted in Approach B and is acceptable for the casual-discovery threat model.

## Cost Impact

For a platform with a mix of public and authenticated content:

| Content mix | Key delivery API calls saved | Origin load reduction |
|---|---|---|
| 80% public, 20% authenticated | 80% | Significant |
| 50/50 | 50% | Moderate |
| 20% public, 80% authenticated | 20% | Modest |

The savings are most dramatic for viral public content, which is exactly the traffic pattern that's hardest to absorb at the origin.

## Open Questions

1. **Default visibility**: Should new posts default to public or authenticated? This is a product decision, but it affects what percentage of media goes through the encryption pipeline.
2. **Open Graph / link previews**: Public posts may eventually need OG meta tags with media URLs for link previews on other platforms. Plaintext public media makes this straightforward; encrypted media would require a server-side decryption step for preview generation.
3. **Search engine indexing**: Public posts may be indexed by search engines. Plaintext media can be crawled; encrypted media cannot. If SEO matters for public content, plaintext is required.
