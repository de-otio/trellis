# Assessment: When to Adopt Approach E

## Not for Launch

Access control (Approach B) is sufficient for launch. The threat model targets casual discovery, and signed URLs defeat all identified threats. Shipping sooner matters more than shipping with encryption.

## When It Makes Sense

Adopt Approach E when any of these triggers occur:

1. **Regulatory pressure**: GDPR enforcement action or legal opinion requiring encryption at rest for user content
2. **Expanded threat model**: If insider threat or infrastructure compromise becomes a concern (e.g., after a security audit, customer demand, or an incident)
3. **Marketing differentiation**: "Your photos are encrypted and only you hold the key" is a compelling trust story -- worth investing in when competing for privacy-conscious users
4. **CDN cost pressure**: If the signed-URL approach (Approach B) results in significantly higher CDN costs due to short TTLs and cache misses, Approach E's long-TTL caching pays for the client-side investment

## What to Build First

If adopting Approach E, the recommended build order:

### Phase 1: Key Delivery + Encrypted Images (Photos Only)

1. Key delivery API (single + batch endpoints)
2. Media processing worker: encrypt photo derivatives (original, thumbnail, optimized)
3. Client `EncryptedImageProvider` + `MediaKeyCache`
4. `MediaFile` model: add `encrypted` flag
5. Plaintext fallback for existing unencrypted media

**Validates**: end-to-end pipeline, client performance, key caching, feed rendering speed

### Phase 2: Video Support

1. Short video: download-decrypt-play (< 50 MB)
2. Long video: streaming decryption with AES-256-CTR chunked mode
3. Video player integration

### Phase 3: Migration

1. Background job to encrypt existing plaintext media
2. Monitor for any unencrypted media and encrypt on access (lazy migration)
3. Remove plaintext fallback once migration is complete

## Migration Path from Approach B

If launching with Approach B (signed URLs) and later upgrading to Approach E:

1. **API**: Add key delivery endpoints alongside existing signed-URL generation
2. **Processing**: New uploads go through encrypted pipeline; old media stays plaintext
3. **Client**: Ship an updated client that supports both encrypted and plaintext media
4. **Migration**: Background job encrypts old media, updates DB flags
5. **Cutover**: Once all media is encrypted, remove signed-URL generation for media (keep for owner archive if desired)
6. **CDN**: Restore long-TTL cache behaviour for `/media/*`

The transition is incremental. At no point does the system need a big-bang switchover.
