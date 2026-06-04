# Ephemeral Comments on Other Users' Content

Use case: "As a user, I want to make an ephemeral comment on another user's content. I want my comment to disappear after 30 days."

---

## Why This Is a Different Problem

Posts are straightforward: you wrote it, you control when it sunsets. Comments live on someone else's post, creating two legitimate but potentially conflicting interests:

- **The commenter** wants their comment to disappear after 30 days
- **The post author** may want the conversation on their post to remain intact

Neither user should need the other's cooperation to exercise their sunset preference.

## How It Works

Each commenter controls `sunset_at` on their own comments, independently of the post author. The data model is the same as posts:

```
PostComment:
  sunset_at        DateTime?    -- null = live, set = sunset
  sunset_policy    Enum?        -- MANUAL, DAYS_30, DAYS_90, DAYS_365
```

### Auto-Sunset

A scheduled job runs periodically:

```sql
UPDATE post_comments SET sunset_at = NOW()
WHERE sunset_policy IS NOT NULL
AND created_at + sunset_policy_interval < NOW()
AND sunset_at IS NULL;
```

### Manual Sunset

The commenter can sunset any of their comments at any time:

```sql
UPDATE post_comments SET sunset_at = NOW() WHERE id = ? AND user_id = ?;
```

## What Happens When a Post Is Sunset?

If the post author sunsets their post, the post becomes invisible to the public. Comments on that post are now contextually orphaned -- they reference a post that nobody (except the post author) can see.

Options:

**Option A: Comments remain publicly visible as orphans.**
A comment with no context. Confusing UX.

**Option B: Comments are hidden when their parent post is sunset (soft cascade).**
The server stops serving comments on sunset posts, even if the comments themselves are still live. The commenter can still see their own comments in their Archive. If the post author un-sunsets (within the grace period), comments reappear automatically.

**Option C: Post sunset hard-cascades to comments.**
Setting `sunset_at` on all comments when the post is sunset. Irreversible for the commenters' public visibility, even if the post author un-sunsets.

**Recommendation: Option B.** It respects both parties: the post author controls visibility of their post (and by extension, the conversation on it), while commenters retain their own sunset lifecycle. Un-sunset works cleanly. Implementation is a serving-layer rule, not a data mutation.

## What Happens When a Comment Is Sunset?

The comment becomes invisible. The post and other comments are unaffected. The post author sees a gap in the conversation (e.g., "[comment removed]" or simply absent).

This is the same pattern users already understand from deleted comments on Reddit, YouTube, etc.

## Default Sunset Policies for Comments

Comments are a strong candidate for default ephemerality. Unlike posts (which users may want to keep visible indefinitely), comments are often throwaway contributions. Suggested UX:

- **Per-user default**: "Sunset my comments after [never / 30 days / 90 days / 1 year]"
- **Per-comment override**: "Keep this comment" or "Sunset this comment in [X days]"
- **Prominent at signup**: Encourage users to set a comment sunset policy as part of onboarding

## Remaining Questions

1. **Reactions/likes**: Should these also be ephemeral? Simpler (no media), but the same user-control principle applies.
2. **Reply chains**: If a comment is a reply to another comment, and the parent comment sunsets, should the reply be hidden too (same Option B soft-cascade logic)?
3. **Notification cleanup**: When a comment sunsets, should the notification it generated ("User A commented on your post") also be removed?
