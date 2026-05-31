# Feed and Scroll Design Improvements

Improvements to the feed system based on the research findings on infinite scroll, personalized feeds, and compulsive usage patterns.

## Problem

Infinite scroll is identified as a key addictive design pattern in the Kids Online Safety Act proposals and by researchers Nagata and Prinstein. Cursor-based pagination with `hasMore: true` encourages endless consumption with no natural stopping point.

Trellis's feed (`feed-handler.ts`) currently uses this pattern.

## Proposed Changes

### 1. Paginated Feed with Natural Stopping Points

Replace infinite scroll with a "load more" button after each page of results. This introduces intentional friction — users must make a conscious decision to continue rather than passively consuming.

**For all users:**
- Default page size remains configurable but present a clear "end of page" boundary
- Show a brief summary at each boundary: "You've seen 20 posts. Load more?"

**For minor accounts (if/when age verification exists):**
- Enforce a maximum number of pages per session (e.g., 5 pages)
- After the limit: "You've caught up! Come back later for new posts."

### 2. Keep Chronological as the Default

The current chronological default is already aligned with researcher recommendations. Codify this as a principle:

- **Never** sort the default feed by engagement metrics (sentiment counts, comment counts)
- Taxonomy-based filtering (showing dogs of breeds you follow) is acceptable — it's interest-based, not engagement-optimized
- If personalization is expanded, it should be opt-in and clearly labeled

### 3. Session Awareness

Add lightweight session duration tracking:

- Track when a user started their current browsing session (client-side or via API)
- After a configurable threshold (e.g., 30 minutes), show a gentle nudge: "You've been browsing for 30 minutes"
- This is "friction" in the terminology used by the researchers — it makes the user more mindful

### 4. Quiet Hours

Allow users to configure hours during which the app deprioritizes engagement:

- No feed refresh during quiet hours (show cached content only)
- Configurable per-user (default: 10 PM - 7 AM)
- For minor accounts: quiet hours could be set by a parent/guardian

This addresses Nagata's specific recommendation to limit platform interaction at bedtime, where research shows it interferes with sleep and exacerbates mental health symptoms.

## Implementation Considerations

- Feed pagination changes are primarily API-side (modifying the response shape in `feed-handler.ts`) and client-side (Flutter feed widget)
- Session awareness can be client-only initially (no API changes needed)
- Quiet hours would need a new user preference field and API enforcement
