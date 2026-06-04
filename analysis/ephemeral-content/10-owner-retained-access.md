# Owner-Retained Access

Investigation of the question: should sunset mean total destruction, or should the author keep access?

---

## The Core Insight

The problem statement identifies anxiety about **public exposure**, not about the existence of content itself. Users don't want to burn their diaries -- they want to put them in a drawer.

- A user who posted travel photos 5 years ago probably still wants to look at them, but doesn't want a stranger browsing their entire history.
- A user who posted opinionated takes at 22 may cringe at them at 32, but might still want to revisit them privately.
- Instagram's "Archive" feature (hide from others, keep for yourself) is one of the platform's most-used features, suggesting this is what users actually want.

## Why This Matters

Without owner-retained access, sunset is a binary choice: keep content publicly accessible, or lose it. This creates a second anxiety on top of the first -- "what if I sunset something I'll later wish I'd kept?"

Owner-retained access eliminates this tension. Sunset becomes a low-risk action: "hide it from others, keep it for me." Users are more likely to use a feature that doesn't feel like permanent destruction.

## Decision

**Owner-retained access adopted.** Sunset hides content from public views; the author can still browse it in a private Archive.

Implementation is straightforward with the access-control approach:

- **Public queries**: `WHERE sunset_at IS NULL` -- excludes sunset content
- **Owner archive**: `WHERE user_id = ?` -- includes everything, sunset or not
- **Media**: Owner archive serves media via short-lived signed URLs

No encryption, no key management, no special decryption path. The Archive is just an authenticated view with a different query filter.

## The Threat Model Is Unaffected

Recruiters, exes, journalists, and search engines lose access exactly as before. The only entity that retains access is the content author -- which is not a threat the feature was ever designed to address.

## Remaining Questions

1. **Archive UX**: Separate "Archive" tab? Search support? Feels like a first-class feature, not a recovery tool.
2. **Export**: Should sunset content be exportable (data portability)?
3. **Account deletion**: Permanently deletes all content including sunset archive.
4. **Shared content**: If User A retains access to a sunset post with comments from User B, can A still see B's comments?
