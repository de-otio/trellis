# Key Granularity: Recommendation

> **Archived.** This document was written when encryption was the proposed approach. It is retained for context but no longer reflects the current design. See [07-implementation.md](../07-implementation.md).

**Per-post DEK is the recommended choice.** See [options analysis](11a-key-granularity-options.md) for the full comparison.

---

## Why Per-Post

1. **It's the only option that delivers all promised sunset modes** (individual post, date range, everything) without re-encryption or workarounds.

2. **The cost objections don't survive scrutiny.** KMS costs are fractions of a cent per user per day. Storage for wrapped keys is single-digit megabytes even for extreme power users. DEK caching eliminates most KMS calls during serving.

3. **It's simpler than the hybrid.** One key model, one sunset operation (delete server-wrapped DEK for target posts), no re-encryption, no period-boundary edge cases.

The bulk sunset concern ("delete server-wrapped DEKs for 5,000 posts") is a database operation, not a KMS operation. A single `UPDATE posts SET server_wrapped_dek = NULL WHERE user_id = ? AND created_at < ?` handles it. This is well within normal database workload.

## Impact on Other Open Questions

- **Q2 (Selective sunset)**: Fully resolved -- per-post DEKs make selective sunset trivial.
- **Q4 (Media handling)**: Per-post DEK means media and text for the same post share a key. Media decryption cost is about throughput, not key management.
- **Q7 (Dead ciphertext cleanup)**: Unchanged -- still only relevant for account deletion.
