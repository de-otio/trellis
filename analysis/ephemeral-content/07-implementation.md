# Implementation

## Data Model

### Posts

```
Post (existing model, new fields):
  sunset_at        DateTime?    -- null = live, set = sunset timestamp
  sunset_policy    Enum?        -- MANUAL, DAYS_30, DAYS_90, DAYS_365
```

### Comments

```
PostComment (existing model, new fields):
  sunset_at        DateTime?
  sunset_policy    Enum?
```

### User Preferences

```
User (existing model, new fields):
  default_post_sunset_policy      Enum?    -- default policy for new posts
  default_comment_sunset_policy   Enum?    -- default policy for new comments
```

## Sunset Operations

### Manual Sunset (Individual)

```sql
UPDATE posts SET sunset_at = NOW() WHERE id = ? AND user_id = ?;
```

### Bulk Sunset (Date Range)

```sql
UPDATE posts SET sunset_at = NOW()
WHERE user_id = ? AND created_at < ? AND sunset_at IS NULL;
```

### Un-Sunset (Within Grace Period)

```sql
UPDATE posts SET sunset_at = NULL
WHERE id = ? AND user_id = ? AND sunset_at > NOW() - INTERVAL '30 days';
```

### Auto-Sunset (Scheduled Job)

A scheduled job runs periodically:

```sql
UPDATE posts SET sunset_at = NOW()
WHERE sunset_policy IS NOT NULL
AND created_at + sunset_policy_interval < NOW()
AND sunset_at IS NULL;

UPDATE post_comments SET sunset_at = NOW()
WHERE sunset_policy IS NOT NULL
AND created_at + sunset_policy_interval < NOW()
AND sunset_at IS NULL;
```

## Query Filters

### Public Views (Feeds, Profiles, Search)

All public queries exclude sunset content:

```sql
SELECT * FROM posts WHERE sunset_at IS NULL ...
```

### Owner Archive

Authenticated owner sees all their content, including sunset:

```sql
SELECT * FROM posts WHERE user_id = ? ORDER BY created_at DESC;
```

## Media Handling

- **Live posts**: Served via long-lived CDN URLs (current architecture, unchanged)
- **Sunset posts**: API stops including media URLs in responses. Existing CDN cache entries expire naturally.
- **Owner archive**: API generates short-lived CDN signed URLs (15-minute expiry) for the authenticated owner only
- **Deferred cleanup**: A scheduled job deletes object-store objects for sunset posts older than the 30-day grace period. Respects owner-retained access -- only deletes media when the user explicitly permanently deletes, or on account deletion.

### Signed URL Cache TTL

| TTL | UX impact | Security window after sunset |
|---|---|---|
| 5 minutes | Frequent re-signing on long sessions | Tight |
| 15 minutes | Good balance for typical session | Acceptable |
| 60 minutes | Smooth UX | Wide residual window |

**Recommendation: 15 minutes** for owner archive. Live posts continue using long-lived URLs.

## Comment Sunset Behaviour

See [Ephemeral Comments](09-ephemeral-comments.md) for full analysis. Summary:

- Each commenter controls `sunset_at` on their own comments independently
- When a post is sunset, its comments are hidden at the serving layer (not deleted). If the post is un-sunset, comments reappear.
- When a comment is sunset, the post and other comments are unaffected. A gap appears in the conversation.

## Performance Considerations

- Add database index on `sunset_at` for efficient filtering and auto-sunset queries
- `WHERE sunset_at IS NULL` is highly selective (most content is live) -- partial index recommended
- No encryption/decryption overhead on any request path
- CDN caching unchanged for live content
- Signed URL generation for owner archive is lightweight (~microseconds per URL)
