# Recommendation: Approach B + Deferred Deletion

**Signed URLs for access control, with deferred object-store object deletion for cleanup.** This is the right trade-off for launch because:

1. **The threat model doesn't require media encryption at rest.** The threats are recruiters, exes, and search engines -- not attackers with object-store access. Signed URLs with short expiry defeat all the identified threats.

2. **It preserves CDN performance.** The CDN can cache media within the signed URL validity window. This matters enormously for a photo/video-heavy platform.

3. **It's operationally simple.** No decryption origin, no encrypted processing pipeline, no KMS key cost explosion.

4. **Sunset is clean.** Stop issuing signed URLs -> media becomes inaccessible within minutes. Delete object-store objects on a deferred schedule for true erasure.

5. **It's upgradeable.** If the threat model later expands to require encryption at rest for media, Approach D can be layered on without changing the client-facing API.

## Implementation

**Serving (pre-sunset):**
1. Client requests a post's media
2. Server checks the post is not sunset (`sunset_at IS NULL`)
3. Server generates a CDN signed URL with 15-minute expiry for each media file
4. Client loads media via signed URLs
5. The CDN caches at edge for up to 15 minutes

**Sunset:**
1. `sunset_at` is set on the post
2. Server stops generating signed URLs for that post's media
3. Existing signed URLs expire within 15 minutes
4. A scheduled cleanup job deletes object-store objects for sunset posts older than the grace period

**Owner viewing (post-sunset):**
1. Authenticated owner requests their sunset post
2. Server verifies owner identity, generates short-lived signed URLs
3. Owner can view their media in the Archive

**Processing pipeline changes:**
- Upload presigned URLs remain unchanged
- The media processing worker remains unchanged
- `MediaFile` records remain unchanged
- Only the serving path changes: static CDN URLs -> short-lived signed URLs

## Cache TTL Trade-Off

| Signed URL / cache TTL | UX impact | Security window |
|---|---|---|
| 5 minutes | Frequent re-signing on long browsing sessions | Tight |
| 15 minutes | Good balance for typical session length | Acceptable |
| 60 minutes | Smooth UX, rare re-signing | Wide window after sunset |

**Recommendation: 15 minutes.** Covers a typical browsing session without excessive re-signing. After sunset, worst case is 15 minutes of residual access from cached edge copies -- acceptable for the casual-discovery threat model.
