# Media Encryption Strategy

Deep analysis of how the ephemeral content scheme would work for photos and videos if encryption were adopted in the future. This is the hardest problem in the feature -- most content on the platform will be photos and videos.

> **Note:** Encryption is deferred for the initial launch. These documents are retained as research for future reference. The current implementation uses access control (signed URLs) only. See [07-implementation.md](../07-implementation.md).

## Documents

1. [Current Architecture](01-current-architecture.md) -- How media storage and serving works today
2. [Why Text Encryption Doesn't Scale](02-text-encryption-limits.md) -- Size, bandwidth, CDN, and pipeline challenges
3. [Approach A: Encrypt + Signed URLs](03-approach-a-encrypt-signed-urls.md) -- Dead end
4. [Approach B: Unencrypted + Signed URLs](04-approach-b-access-control.md) -- Recommended (adopted for launch)
5. [Approach C: SSE-KMS Per Post](05-approach-c-sse-kms.md) -- Cost-prohibitive
6. [Approach D: Decryption Origin](06-approach-d-decryption-origin.md) -- Most complete, most complex
7. [Recommendation and Implementation](07-recommendation.md) -- Why Approach B wins for launch
8. [Remaining Questions](08-remaining-questions.md) -- Video streaming, thumbnails, cost modelling
9. [Approach E: Client-Side Decryption](approach-e-client-side/) -- Encrypt at rest, decrypt on the device. Best future upgrade path. (7 sub-documents)
