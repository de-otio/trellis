# Do We Need Encryption at All?

The [media analysis](media-strategy/) concluded that the best strategy for photos and videos is **signed URLs and access control** -- no encryption. If that's good enough for the majority of content on the platform, why encrypt text at all?

---

## What Encryption Actually Buys Us

The original proposal's case for encryption rested on two claims:

1. **Instant, atomic sunset** -- delete the key and all associated content becomes unreadable in one operation, no deletion cascade required.
2. **Cryptographic guarantee** -- even if someone has a database dump, the ciphertext is useless without the key.

Let's test both claims against the threat model and the architecture as it has evolved.

### Claim 1: Instant sunset without deletion cascades

With encryption, sunset means deleting a wrapped DEK. The ciphertext stays in the database, inert. No foreign key cascades, no batch deletes, no race conditions.

But the same outcome is achievable with a **visibility flag**:

```sql
UPDATE posts SET sunset_at = NOW() WHERE user_id = ? AND created_at < ?;
```

One indexed update. The API checks `sunset_at` on every query and excludes sunset posts. This is exactly how "soft delete" works in every social platform. It is not slower, harder, or less atomic than deleting a wrapped DEK.

The "no deletion cascade" benefit was more compelling when we assumed content would eventually be purged. But with [owner-retained access](10-owner-retained-access.md), the content stays in the database regardless -- the user wants to keep it. Whether the content is stored as ciphertext or plaintext, it's not being deleted either way.

**Verdict:** Encryption doesn't meaningfully simplify the sunset operation compared to a visibility flag.

### Claim 2: Cryptographic guarantee against database access

If an attacker gets a database dump (SQL injection, compromised backup, insider threat), encrypted text posts are unreadable. This is a real benefit -- but how much does it matter in context?

- The threat model explicitly targets **casual discovery**: recruiters, exes, journalists, search engines. None of these actors have database access.
- The threat model explicitly marks **determined adversaries** and **server-side trust** as out of scope.
- Media (the majority of content) is stored unencrypted in the object store under the recommended approach. An attacker with database access probably also has object-store access (same account, same IAM policies). Encrypting text but not media is a padlock on the front door with the back door open.
- The platform already trusts the server with the decryption key while content is live. Encryption only protects content after sunset -- meaning the window of protection is specifically "attacker gets database access after the user has sunset their content."

**Verdict:** Real but narrow benefit. Protects a specific scenario (post-sunset database compromise) that is explicitly outside the threat model, and is undermined by unencrypted media.

## What Access Control Alone Looks Like

Strip out encryption entirely. The ephemeral content feature becomes:

### Data model

```
Post:
  sunset_at       DateTime?    -- null = live, set = sunset
  sunset_policy   Enum?        -- MANUAL, DAYS_30, DAYS_90, DAYS_365
```

### Sunset operation

```sql
-- Bulk sunset
UPDATE posts SET sunset_at = NOW()
WHERE user_id = ? AND created_at < ? AND sunset_at IS NULL;

-- Individual sunset
UPDATE posts SET sunset_at = NOW() WHERE id = ? AND user_id = ?;
```

### Serving

```sql
-- Public feed: exclude sunset content
SELECT * FROM posts WHERE sunset_at IS NULL ...

-- Owner archive: include sunset content
SELECT * FROM posts WHERE user_id = ? ...
```

### Media

- Live posts: serve media via long-lived CDN URLs (current architecture, unchanged)
- Sunset posts: stop including media URLs in API responses. Optionally invalidate CDN cache and delete object-store objects on a deferred schedule
- Owner archive: generate short-lived signed URLs for the owner only

### Auto-sunset

A scheduled job runs periodically:

```sql
UPDATE posts SET sunset_at = NOW()
WHERE sunset_policy IS NOT NULL
AND created_at + sunset_policy_interval < NOW()
AND sunset_at IS NULL;
```

### Un-sunset (grace period)

```sql
UPDATE posts SET sunset_at = NULL WHERE id = ? AND user_id = ?
AND sunset_at > NOW() - INTERVAL '30 days';
```

### Comments

Same pattern. Commenter controls `sunset_at` on their own comments. Default comment sunset policy per user.

## Comparison

| Dimension | Encryption approach | Access control approach |
|---|---|---|
| **Sunset mechanism** | Delete server-wrapped DEK | Set `sunset_at` timestamp |
| **Un-sunset** | Restore DEK within grace period | Clear `sunset_at` within grace period |
| **Media handling** | Signed URLs (no encryption anyway) | Signed URLs or stop serving URLs |
| **Owner archive** | Decrypt via owner-wrapped DEK | Query with owner filter |
| **Text protection at rest** | AES-256 ciphertext | Plaintext (protected by DB access controls) |
| **Database schema** | Ciphertext blobs + wrapped DEK columns | Standard columns + `sunset_at` |
| **Search/indexing** | Cannot index encrypted content | Full-text search works on sunset content (internal only) |
| **KMS dependency** | Yes -- per-post DEK wrapping/unwrapping on every request | None |
| **KMS cost** | ~$0.54/day at 100K users (creation only) + serving costs | $0 |
| **Implementation complexity** | High: key lifecycle, dual wrapping, cache-busting, encrypted processing | Low: visibility flag, query filters |
| **Performance** | Decryption overhead per request, no CDN caching for text | Standard queries, standard caching |
| **Protection against DB compromise** | Yes (post-sunset content is ciphertext) | No |
| **Protection against casual discovery** | Yes | Yes (equally) |

## The Case for Dropping Encryption

1. **The threat model doesn't need it.** Every threat in the model (recruiters, exes, journalists, search engines, web archives) is defeated by access control. Encryption defends against database compromise, which is explicitly out of scope.

2. **Media can't use it anyway.** The platform is photo/video-heavy. The recommended media strategy is access control via signed URLs. Encrypting text while leaving media unencrypted creates an inconsistent security model with no practical benefit.

3. **The complexity cost is real.** Encryption adds: KMS integration, per-post DEK lifecycle, dual-key wrapping, cache-busting for text content, inability to index or search encrypted content, decryption overhead on every read. All of this for a threat that's out of scope.

4. **Owner-retained access is simpler without encryption.** With encryption, the owner needs an authenticated KMS call to decrypt their own sunset content. Without encryption, the owner just queries the database with their user ID. The Archive feature is a standard authenticated view, not a cryptographic operation.

5. **The feature already works without encryption.** Instagram Archive, Snapchat Memories, Twitter/X soft-delete -- none of these use client-side or server-side encryption for ephemerality. They use access control. Users understand and accept this model.

## The Case for Keeping Encryption

1. **Defence in depth.** Access control is a single layer. Encryption means a bug in a query filter (forgetting to check `sunset_at`) doesn't expose sunset content. With encryption, a missing filter returns ciphertext -- useless to the viewer.

2. **Marketing and trust.** "Your content is encrypted and the key is destroyed" is a stronger message than "we stop showing it." Even if the practical security is similar, the perception matters for a feature built around user anxiety.

3. **Regulatory cover.** Cryptographic erasure (key deletion) is generally accepted as meeting GDPR "right to erasure" requirements. Soft-delete is not -- regulators may require actual data deletion, which is operationally harder.

4. **Future-proofing.** If the threat model later expands (e.g., end-to-end encryption, zero-trust), having the encryption infrastructure already in place is valuable.

## Recommendation

**Drop encryption for the initial launch. Ship access control only.**

The core user need is "make my old posts disappear from public view." Access control delivers this fully, with a fraction of the implementation cost. The feature is valuable without encryption -- and shipping it sooner matters more than shipping it with stronger cryptographic guarantees against threats that are out of scope.

If demand, regulatory pressure, or an expanded threat model later justifies encryption, the access-control version is a clean foundation to layer it onto: the `sunset_at` field, the archive view, the auto-sunset job, and the media signed-URL infrastructure all remain the same. Encryption becomes an additive enhancement, not a prerequisite.

### What to build

1. `sunset_at` and `sunset_policy` fields on posts and comments
2. Query filters that exclude sunset content from public views
3. Owner archive view (authenticated, shows sunset content)
4. Auto-sunset scheduled job
5. Grace period with un-sunset capability
6. Short-lived signed URLs for media on sunset posts (owner archive only)
7. Deferred object-store deletion for sunset media past the grace period
8. Cache control headers (`no-store`, `noindex`, `noarchive`) on all user content
9. UX: sunset policies, bulk operations, visibility indicators, grace period countdown

### What to defer

1. Encryption at rest for text content
2. KMS key lifecycle management
3. Dual-wrapped DEK infrastructure
4. Encrypted media serving (see [media strategy](media-strategy/))
