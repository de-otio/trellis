# Approach A: Encrypt at Rest, Serve via Short-Lived Signed URLs

Don't decrypt on the server at all. Instead, store media encrypted in the object store, and when serving:

1. Server unwraps the post's DEK
2. Server generates a short-lived CDN signed URL (e.g., 5-minute expiry) pointing to the **decrypted** media
3. But wait -- the media in the object store is encrypted. The CDN can't decrypt it.

This doesn't work without a decryption layer between the object store and the CDN.

**Verdict:** Dead end without an edge-compute or origin decryption layer, which would be complex and expensive at scale.
