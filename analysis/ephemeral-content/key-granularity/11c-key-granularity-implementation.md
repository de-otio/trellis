# Key Granularity: Implementation with Dual-Wrapped Keys

> **Archived.** This document was written when encryption was the proposed approach. It is retained for context but no longer reflects the current design. See [07-implementation.md](../07-implementation.md).

Per-post DEK lifecycle using the dual-wrapped key architecture.

---

## Post Creation

1. Generate a random AES-256 DEK
2. Encrypt the post content with the DEK
3. Wrap the DEK under the server CMK (KMS Encrypt call)
4. Wrap the DEK under the owner CMK (KMS Encrypt call)
5. Store: ciphertext, server-wrapped DEK, owner-wrapped DEK

## Public Serving

1. Unwrap DEK using server CMK (KMS Decrypt call, or cache hit)
2. Decrypt content, serve it

## Sunset

1. Set `server_wrapped_dek = NULL` for target posts
2. Done. Content is now invisible to the public, still accessible to the owner.

## Owner Viewing (Post-Sunset)

1. Unwrap DEK using owner CMK (authenticated KMS Decrypt call)
2. Decrypt content, serve to owner only
