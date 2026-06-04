# Approach C: Encrypt Media at Rest with Object-Store Server-Side Encryption (Per-Post KMS Key)

Use the object store's built-in server-side encryption with customer-managed KMS keys (SSE-KMS), one per post:

1. At upload, media is encrypted with a KMS key associated with the post
2. The object store handles encryption/decryption transparently on read/write
3. At sunset, disable or schedule deletion of the post's KMS key
4. The object store can no longer decrypt the media -- reads return errors
5. The CDN gets errors from the origin, stops serving the media

**Pros:**
- Media is genuinely encrypted at rest
- No application-layer decryption -- the object store handles it transparently
- Sunset via KMS key revocation is clean and instant
- Processing pipeline works: the media worker has KMS permissions during processing, writes encrypted derivatives

**Cons:**
- **KMS key per post is expensive**: KMS keys cost $1/month each. 100,000 users x 2 posts/day = 200,000 keys/month = $200,000/month. Unviable.
- Could share KMS keys per user (not per post), but then can't sunset individual posts' media independently
- KMS API throttling: default limit of 5,500-30,000 requests/second per account; feed rendering could hit this

**Verdict:** Costs are prohibitive with per-post KMS keys. Per-user KMS keys reduce cost but lose granularity.
