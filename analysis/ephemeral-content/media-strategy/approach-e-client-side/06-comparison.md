# Comparison: Approach E vs Alternatives

## Approach B (Signed URLs) vs Approach E (Client-Side Decryption)

| Dimension | Approach B (signed URLs) | Approach E (client-side decryption) |
|---|---|---|
| Media encrypted at rest | No | **Yes** |
| CDN cache TTL | Short (15 min signed URLs) | **Long (1 year, same as today)** |
| CDN cost | Higher (more origin hits from short TTLs) | **Lower (edge-cached as today)** |
| Origin load | Signed URL generation per request | Key delivery only (batched, cacheable) |
| Sunset mechanism | Stop issuing signed URLs | Stop issuing DEKs |
| Sunset speed | Minutes (URL + cache expiry) | **Instant** (no cached plaintext to expire) |
| Client complexity | Unchanged | **Higher** (decrypt pipeline, key fetch) |
| Processing pipeline | Unchanged | **Changed** (worker encrypts derivatives) |
| Security model | Access control only | **Encryption at rest** |
| Offline viewing | Works (media is plaintext once loaded) | Works (decrypted in memory, same) |
| Consistent with text encryption (future) | No | **Yes** (same DEK model) |

**Summary:** Approach E is superior on security, CDN performance, and sunset speed. Approach B is superior on implementation simplicity. Both fully address the threat model.

## Approach D (Server-Side Decryption) vs Approach E (Client-Side Decryption)

| Dimension | Approach D (server-side) | Approach E (client-side) |
|---|---|---|
| Media encrypted at rest | Yes | Yes |
| CDN cache TTL | Short (decrypted content, 5 min) | **Long (encrypted content, 1 year)** |
| Origin load | **High** (decrypt + stream every request) | **Low** (key delivery only) |
| Infrastructure | Decryption origin service (function/container) | Key delivery API endpoint |
| Video support | Function response-size limit; container for larger | **No server limit** (client decrypts) |
| Sunset speed | Minutes (CDN invalidation) | **Instant** |
| Client complexity | Unchanged | Higher (decrypt pipeline) |
| Server compute cost | High (decryption at origin) | **Negligible** (key lookup only) |

**Summary:** Approach E is strictly better than Approach D for the same security guarantee, at lower server cost. The trade-off is client-side complexity instead of server-side complexity.
