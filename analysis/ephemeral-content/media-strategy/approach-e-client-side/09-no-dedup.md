# Why We Intentionally Omit Media Deduplication

The current architecture uses SHA-256 content addressing for media storage: two identical uploads produce the same object-store key, avoiding duplicate storage. With per-post encryption, this breaks -- the same photo encrypted with different DEKs produces different ciphertext and different hashes.

Rather than engineering around this, we drop dedup entirely. This is an intentional decision, not a compromise.

## Dedup Doesn't Help for Original-Photo Platforms

Research and industry data consistently show that dedup savings are negligible when content is primarily original photos and videos.

### What the data says

- **Facebook (2014, public engineering blog)**: Dedup saved ~15% of photo storage in their Haystack system, but almost entirely from same-user duplicates (upload retries, cross-posting the same photo to different albums), not cross-user dedup.
- **Yahoo/Flickr study (2013)**: ~20-30% of images shared on social media were near-duplicates -- but this was across resharing platforms (memes, news images). Original photo platforms showed much lower rates.
- **WhatsApp viral content (2019, India elections study)**: The same images forwarded millions of times. High dedup potential -- but only because the content model is forwarding/resharing, not original creation.
- **Instagram/Snapchat model**: Near-zero cross-user dedup. Each photo is unique at the byte level -- different device, different sensor noise, different EXIF metadata, different compression. Even two photos of the same scene by the same phone seconds apart produce different hashes.
- **Video**: Effectively zero dedup. Re-encoding, different lengths, different codecs, different bitrates. Even re-uploads of the same video produce different files.

### When the content is original media

A consuming application whose feed is dominated by original, user-captured photos and videos sees near-zero cross-user dedup. Every photo is unique at the byte level. Cross-user dedup savings will be near zero.

Same-user dedup (upload retries, posting the same photo in different contexts) might save low single-digit percentages -- but this is better handled by client-side retry logic (don't re-upload) than by server-side dedup.

## The Cost Math

Object-store standard storage: ~$0.023/GB/month.

| Scale | Total media | Monthly storage cost | Dedup savings (optimistic 5%) |
|---|---|---|---|
| 10K users, 50 MB each | 500 GB | $11.50 | $0.58 |
| 100K users, 50 MB each | 5 TB | $115 | $5.75 |
| 1M users, 50 MB each | 50 TB | $1,150 | $57.50 |

Even at 1M users, the optimistic dedup saving is ~$57/month. The engineering cost to build and maintain a dedup system (hash indexes, reference counting for safe deletion, cross-user privacy implications, encryption compatibility) vastly exceeds the storage savings.

Intelligent storage tiering (already configured on the media bucket) automatically moves infrequently-accessed media to cheaper storage classes, providing better cost savings than dedup would.

## Dedup Is Incompatible with Per-Post Encryption

Even if dedup were valuable, per-post encryption makes it impossible:

- Same plaintext + different DEK = different ciphertext = different hash
- To dedup, you'd need to compare plaintext before encryption, which means maintaining a separate plaintext hash index
- If two users share a DEK to enable dedup, sunsetting one user's content exposes the shared key to the other -- a security violation
- Reference counting for safe deletion becomes complex: can't delete the object until all posts referencing it are deleted, but each post's encrypted copy is independent

The only way to make dedup work with encryption is to separate storage dedup from encryption dedup, maintaining two layers. This is significant complexity for negligible savings.

## Dedup Creates Privacy Risks

Content-addressing means the server can detect when two users upload the same photo. This leaks information:

- The server learns that User A and User B have the same photo, even if neither user knows the other
- This could reveal shared locations, events, or relationships
- In adversarial scenarios (legal discovery, data breach), dedup metadata reveals cross-user connections that wouldn't otherwise exist

Without dedup, each post's media is an independent blob with no cross-user linkage.

## What We Do Instead

1. **No dedup**: Each post's media is stored independently. Same photo uploaded by two users = two separate objects.
2. **Client-side retry handling**: If the client retries an upload, it reuses the same presigned URL or detects the existing `MediaFile` record rather than creating a duplicate.
3. **Intelligent storage tiering**: Automatically moves old media to cheaper storage classes. Better cost savings than dedup for a platform where older content is accessed less frequently.
4. **Deferred media deletion**: When posts are permanently deleted (account deletion, post-grace-period cleanup), the objects are deleted with no reference-counting complexity.

## When to Revisit

Reconsider dedup only if:

- Storage costs become a significant line item (>10% of infrastructure budget)
- The platform shifts toward resharing/forwarding content (meme culture) rather than original content
- A proven, low-complexity dedup layer becomes available that works with per-post encryption

None of these are expected in the near term.
