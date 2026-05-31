# Sentiment System and Notification Safeguards

How to preserve the benefits of Trellis's sentiment model while preventing it from becoming a compulsive feedback loop, and how to design notifications safely if they are added.

## Sentiment System

### What's Good

Trellis's 11-emotion sentiment vocabulary (joy, gratitude, calm, love, hope, compassion, awe, sadness, anger, fear, insightful) is fundamentally better than a binary like button. It:

- Encourages emotional reflection rather than reflexive tapping
- Doesn't reduce social feedback to a single popularity number
- Includes a range of emotions, normalizing non-positive reactions

### Risks to Mitigate

Even with nuanced sentiments, **aggregate counts still create a popularity metric**. A post with 200 sentiments is perceived as "more liked" than one with 2, regardless of which emotions were chosen. This can drive the same compulsive checking behavior as traditional likes.

### Proposed Safeguards

**1. Hide aggregate counts by default**

Show _which_ sentiments a post received (the emoji/icon distribution) but not the total count. Users see "people felt joy, gratitude, and awe" rather than "47 reactions."

This directly addresses Prinstein's finding that quantified social feedback exploits adolescents' "hypersensitive social brain."

**2. Delay sentiment visibility to the post author**

Instead of real-time sentiment notifications, batch sentiment summaries:
- "This morning, people responded to your post about [dog name] with joy and love"
- Delivered at most once or twice per day, not per-reaction

This converts an addictive real-time dopamine drip into a reflective daily summary.

**3. No sentiment count on the author's own post in the feed**

When scrolling through the feed, the post author should not see a running tally on their own content. This removes the incentive to post-and-refresh.

## Notification Design Principles

If Trellis adds a notification system, the research provides clear guidance on what to avoid:

### Do

- **Batch notifications** into digests (morning and/or evening)
- **Make notifications opt-in**, not opt-out
- **Respect quiet hours** — never send notifications during sleep windows
- **Focus on actionable items** — DMs, safety alerts, moderation decisions
- **Use neutral framing** — "New activity on your post" rather than "3 people loved your post!"

### Don't

- Don't send real-time push notifications for sentiments/reactions
- Don't show notification badges with counts (the red badge with a number is a well-documented anxiety trigger)
- Don't send re-engagement notifications ("You haven't posted in 3 days!")
- Don't notify about other people's activity ("Your friend just posted!")

### For Minor Accounts

- Notifications should be off by default
- Only a parent/guardian should be able to enable them
- Even when enabled, only DMs and safety-related notifications should be allowed
