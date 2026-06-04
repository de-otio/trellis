# Approach D: Encrypt Media at Rest, Decrypt via CDN Signed URLs + Origin Decryption

Combine encryption at rest with a decryption-capable origin:

1. Media stored in the object store, encrypted with the post's DEK (application-layer AES-256, same as text)
2. An intermediary service (a function URL, or a container sidecar) sits between the CDN and the object store
3. The CDN is configured with this service as origin for `/media/*`
4. On request, the origin service: fetches ciphertext from the object store, unwraps the DEK, decrypts, streams plaintext to the CDN
5. The CDN caches the decrypted media for a short TTL (e.g., 5 minutes)
6. At sunset, invalidate the CDN cache for that post's media paths and stop serving new requests

**Pros:**
- Media is encrypted at rest with the same per-post DEK as text content
- Consistent security model across all content types
- Short-TTL CDN caching reduces origin load while limiting exposure window
- Sunset is key deletion + CDN invalidation

**Cons:**
- Requires a decryption origin service -- adds infrastructure complexity
- Origin service must handle concurrent media streams (memory, bandwidth)
- Short cache TTL means more origin hits than the current 1-year TTL
- CDN invalidation is not instant (typically seconds to minutes)
- Serverless function URLs have response-size limits (fine for photos, tight for video)
- A container-based origin adds cost and operational overhead

**Verdict:** The most complete solution, but significant infrastructure complexity. Worth it only if encryption at rest for media is a hard requirement.
