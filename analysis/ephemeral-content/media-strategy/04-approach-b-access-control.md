# Approach B: Store Media Unencrypted, Control Access via Signed URLs

Don't encrypt media files at all. Instead, rely on access control:

1. Media stored unencrypted in the object store (as today)
2. Object store remains private (origin access control only)
3. Server generates short-lived CDN signed URLs (5-15 minute expiry) for each media file
4. At sunset, the server stops generating signed URLs for that post's media
5. Existing signed URLs expire naturally within minutes
6. Optionally, delete the object-store objects after sunset for true data destruction

**Pros:**
- No encryption/decryption overhead for media
- CDN caching still works within the signed URL validity window
- Simple to implement -- signed URLs are a standard CDN feature
- Processing pipeline unchanged
- Client already loads media via URLs; just make them short-lived

**Cons:**
- Media is not encrypted at rest (weaker than the text encryption scheme)
- An attacker with object-store access (compromised credentials, insider) can read media directly
- Relies on access control, not cryptography -- different security model than text content
- Object-store deletion is required for true erasure (unlike text, where key deletion suffices)

**Verdict:** Pragmatic and operationally simple. Acceptable given the threat model targets casual discovery, not determined attackers with infrastructure access.

> **This is the approach adopted for launch.** See [07-implementation.md](../07-implementation.md).
