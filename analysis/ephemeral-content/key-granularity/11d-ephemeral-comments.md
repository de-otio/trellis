# Ephemeral Comments on Other Users' Content

> **Archived.** This document was written when encryption was the proposed approach. The current access-control version is [09-ephemeral-comments.md](../09-ephemeral-comments.md).

Use case: "As a user, I want to make an ephemeral comment on another user's content. I want my comment to disappear after 30 days."

---

## Why This Is a Different Problem

The core ephemeral content design assumes the content author controls the DEK. For posts, this is straightforward: you wrote it, you own the key, you decide when it sunsets.

Comments break this model. A comment lives on someone else's post. Two different users now have legitimate but conflicting interests:

- **The commenter** wants their comment to disappear after 30 days
- **The post author** may want the conversation on their post to remain intact

Neither user should need the other's cooperation to exercise their sunset preference.

## The Key Ownership Question

With per-post DEKs, the post author's DEK encrypts the post. If comments are encrypted under the same DEK, the commenter has no independent control -- only the post author can sunset the content.

For ephemeral comments, the commenter needs their own DEK for their comment. This means:

- Each comment gets its own per-comment DEK, dual-wrapped under the **commenter's** CMKs (not the post author's)
- The comment ciphertext is stored alongside the post, but encrypted independently
- The commenter can sunset their comment without affecting the post or other comments
- The post author sunsetting their post does not automatically sunset other users' comments (though the comments become contextually orphaned)

## Architecture

### Comment Creation

1. Commenter creates a comment on Post X
2. Generate a random AES-256 DEK for the comment
3. Encrypt the comment content with the DEK
4. Wrap the DEK under the **server CMK** (for public serving)
5. Wrap the DEK under the **commenter's owner CMK** (for commenter-retained access)
6. Store: comment ciphertext, server-wrapped DEK, owner-wrapped DEK, plus a `sunset_at` timestamp if the commenter sets a policy
7. Optionally, the commenter sets a default policy: "sunset my comments after 30 days"

### Auto-Sunset

A scheduled job (cron or queue-driven worker) periodically:

1. Queries for comments where `sunset_at <= NOW()` and `server_wrapped_dek IS NOT NULL`
2. Sets `server_wrapped_dek = NULL` for those comments
3. The comments become unreadable to the public, but the commenter can still see them in their Archive

### Manual Sunset

The commenter can sunset any of their comments at any time, same as posts -- delete the server-wrapped DEK.

## What Happens When a Post Is Sunset?

If the post author sunsets their post, the post becomes invisible to the public. Comments on that post are now contextually orphaned -- they reference a post that nobody (except the post author) can see.

Options:

**Option A: Comments remain publicly visible as orphans.**
The comment text is still decryptable via its own server-wrapped DEK, but the parent post is gone. This is confusing UX -- a comment with no context.

**Option B: Comments are hidden when their parent post is sunset (soft cascade).**
The server stops serving comments on sunset posts, even if the comments' own DEKs are still active. No key deletion needed -- just a serving rule: "don't serve comments on sunset posts." The commenter can still see their own comments in their Archive. If the post author un-sunsets (within the grace period), comments reappear automatically.

**Option C: Post sunset cascades to comment key deletion.**
The post author sunsetting their post also deletes the server-wrapped DEKs for all comments on it. This is irreversible for the commenters' public visibility, even if the post author un-sunsets.

**Recommendation: Option B.** It respects both parties: the post author controls visibility of their post (and by extension, the conversation on it), while commenters retain their own key lifecycle. No keys are destroyed that shouldn't be. Un-sunset works cleanly.

## What Happens When a Comment Is Sunset?

The comment becomes invisible. The post and other comments are unaffected. The post author sees a gap in the conversation (e.g., "[comment removed]" or simply absent).

This is the same pattern users already understand from deleted comments on Reddit, YouTube, etc.

## Default Sunset Policies for Comments

Comments are a strong candidate for default ephemerality. Unlike posts (which users may want to keep visible indefinitely), comments are often throwaway contributions. Suggested UX:

- **Per-user default**: "Sunset my comments after [never / 30 days / 90 days / 1 year]"
- **Per-comment override**: "Keep this comment" or "Sunset this comment in [X days]"
- **Prominent at signup**: Encourage users to set a comment sunset policy as part of onboarding

## Impact on Open Questions

- **Q3 (Social graph implications)**: Partially addressed. This analysis covers the commenter's perspective. The post author's perspective (what they see when someone else's comment sunsets) is answered: they see a gap.
- **Q12 (Shared sunset content)**: Partially addressed. Option B defines the interaction: post sunset hides comments at the serving layer without destroying comment keys. Commenter retains archive access.

## Remaining Questions

1. **Reactions/likes**: Should these also be ephemeral? They're simpler (no content to encrypt), but the same user-control principle applies.
2. **Reply chains**: If a comment is a reply to another comment, and the parent comment sunsets, should the reply be hidden too (same Option B logic)?
3. **Notification cleanup**: When a comment sunsets, should the notification it generated ("User A commented on your post") also be removed?
