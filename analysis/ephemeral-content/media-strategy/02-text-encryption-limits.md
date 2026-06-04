# Why Text Encryption Doesn't Scale to Media

The text encryption design (AES-256, decrypt on-the-fly per request) works because text posts are small -- a few KB. The server decrypts in microseconds and serves the plaintext.

For media:

| Content type | Typical size | Decrypt time (AES-256, ~2 GB/s) | Per-request cost |
|---|---|---|---|
| Text post | 2 KB | <1 us | Negligible |
| Thumbnail | 15 KB | <1 us | Negligible |
| Optimized photo | 200 KB | ~100 us | Low |
| Original photo | 5 MB | ~2.5 ms | Moderate |
| Short video (30s) | 15 MB | ~7.5 ms | Moderate |
| Long video (5 min) | 150 MB | ~75 ms | High |

Raw decryption speed isn't the problem -- AES-256 is fast. The problems are:

1. **Bandwidth**: The server must stream decrypted media to the client. With CDN caching disabled, every media request hits origin.
2. **CDN incompatibility**: Encrypted blobs can't be cached at CDN edge locations (they're ciphertext). Decrypted content shouldn't be cached (it needs to become unservable on sunset). This eliminates the CDN's primary value for media.
3. **Processing pipeline**: The media processing worker currently writes plaintext derivatives (thumbnail, optimized) back to the object store. These would need to be encrypted too.
4. **Concurrent load**: A feed page with 20 posts, each with 1-4 photos, means 20-80 media decryptions per page load. Without CDN caching, this all hits the API.
