# Key Granularity: Options

> **Archived.** This document was written when encryption was the proposed approach. It is retained for context but no longer reflects the current design. The current implementation uses access control (visibility flags). See [09-ephemeral-comments.md](../09-ephemeral-comments.md) and [07-implementation.md](../07-implementation.md).

Deep analysis of open question 1: what level of granularity should DEKs operate at, and how does this interact with the dual-wrapped key architecture?

Finer-grained keys give users more control over what they sunset. Coarser keys are simpler to manage. The right answer depends on which sunset operations users actually need.

---

## Option 1: Per-User DEK

A single DEK encrypts all of a user's content. Both wrappings (server + owner) apply to this one key.

**Sunset granularity**: All-or-nothing. The user can sunset their entire history, or nothing.

**Pros:**
- Simplest possible key management: one DEK, two wrappings, done
- Minimal KMS calls: one key to cache per user
- Lowest storage overhead: two wrapped DEKs per user total

**Cons:**
- Cannot sunset individual posts or time ranges without sunsetting everything
- The proposed solution explicitly lists "individual posts, everything older than N months, or their entire history" as sunset targets -- per-user DEK only supports the last one
- Effectively useless for the most common use case: "hide my old stuff but keep recent posts live"

**Verdict:** Too coarse. Fails the primary use case.

---

## Option 2: Per-Post DEK

Every post gets its own DEK, dual-wrapped at creation time.

**Sunset granularity**: Maximum. Any individual post, any arbitrary set of posts, any time range.

**Pros:**
- Complete flexibility: sunset one post, a date range, or everything
- Selective sunset is a simple database operation: delete the server-wrapped DEKs for the targeted posts
- Clean semantics: each post is independently controllable

**Cons:**
- Key volume: a prolific user with 10,000 posts has 10,000 DEKs x 2 wrappings = 20,000 wrapped keys
- Storage: ~5MB of wrapped keys for that user (20,000 x 256 bytes) -- not a crisis, but not negligible at scale
- KMS calls at content creation: one GenerateDataKey + two Encrypt (wrap) calls per post
- KMS calls at serving time: one Decrypt (unwrap) call per post rendered on a page (mitigated by DEK caching)
- Bulk sunset of "everything before date X" requires updating potentially thousands of rows

**Cost analysis:**
- KMS pricing: $0.03 per 10,000 API calls
- A post creation costs ~3 KMS calls = $0.000009
- Serving a feed page with 20 posts (cache miss) = 20 KMS calls = $0.00006
- With DEK caching (TTL 5-15 minutes), KMS calls during serving drop dramatically
- At 100,000 active users averaging 2 posts/day: ~$0.54/day in KMS creation calls -- trivial

**Verdict:** Viable, and provides the most flexibility. Cost is manageable. The main concern is bulk operations touching many rows.

---

## Option 3: Per-Time-Period DEK

One DEK per user per time period (e.g., per month or per quarter). All content created within that period shares the same DEK.

**Sunset granularity**: By time period. "Sunset everything older than 12 months" = delete server-wrapped DEKs for the relevant monthly buckets.

**Pros:**
- Good match for the primary use case: "sunset old stuff" naturally maps to time-based buckets
- Bounded key count: 12 keys/year x 2 wrappings = 24 wrapped keys per user per year
- Bulk sunset by date range is efficient: delete a handful of server-wrapped DEKs
- Far fewer KMS calls than per-post: key is reused across all posts in the period

**Cons:**
- Cannot sunset individual posts within a period without sunsetting the entire period
- Period boundaries are arbitrary: a post from March 31 and April 1 are in different buckets even though they're a day apart
- Key rotation happens on a calendar schedule, not on a security-meaningful boundary
- "Sunset this one embarrassing post from 3 months ago" requires sunsetting the entire month

**Verdict:** Good for the "hide old stuff" use case, poor for selective post-level control.

---

## Option 4: Hybrid (Per-Time-Period with Per-Post Override)

Default to per-time-period DEKs, but allow individual posts to be assigned their own DEK when the user wants post-level sunset control.

**How it works:**
1. By default, a new post is encrypted with the current period's DEK
2. If a user wants to sunset a specific post, the system re-encrypts that post with a new per-post DEK (dual-wrapped) and deletes the server-wrapped copy
3. The rest of the period's content remains unaffected

**Pros:**
- Low key count in the common case (per-period)
- Post-level control available when needed (per-post override)
- Bulk time-based sunset remains efficient

**Cons:**
- Re-encryption on selective sunset adds latency and complexity to the sunset operation
- Two code paths for sunset: bulk (delete period key) and selective (re-encrypt + delete post key)
- Edge case: what if the user sunsets a period that contains posts with per-post overrides? Need clear precedence rules

**Verdict:** Pragmatic, but the re-encryption complexity may not be worth it.
