# Standard JSON Format

This document describes the standard JSON format for user data exports. This format is human-readable and suitable for general-purpose use.

---

## Root Structure

```json
{
  "exportedAt": "2025-01-15T10:30:00.000Z",
  "format": "json",
  "version": "1.0",
  "user": {...},
  "posts": [...],
  "commentsOnOthersPosts": [...],
  "reactionsOnOthersPosts": [...],
  "reactionsOnOthersComments": [...],
  "geoIndexedPosts": [...]
}
```

---

## User Object

```json
{
  "id": "ckv8x2p9b0000qz8h3f2k1m4n",
  "email": "user@example.com",
  "did": "actor-id",
  "handle": "user@instance.example",
  "createdAt": "2024-01-01T00:00:00.000Z"
}
```

**Fields:**

- `id` (string, required): user ID (CUID in the trellis Prisma schema)
- `email` (string, required): user's email address
- `did` (string, optional): ActivityPub actor ID (present when the account is federated)
- `handle` (string, optional): ActivityPub username/handle (present when the account is federated)
- `createdAt` (string, ISO 8601): account creation timestamp

---

## Post Object

```json
{
  "id": "post-id-123",
  "text": "Post content here...",
  "visibility": "PUBLIC",
  "entityRef": "extension-defined-reference",
  "geoData": {
    "lat": 52.5200,
    "lng": 13.4050,
    "place": "Berlin, Germany"
  },
  "uri": "https://instance.example/posts/abc123",
  "contentWarnings": ["spoiler"],
  "createdAt": "2024-01-15T10:00:00.000Z",
  "updatedAt": "2024-01-15T10:00:00.000Z",
  "media": [
    {
      "id": "media-id-1",
      "mediaId": "media-file-id",
      "alt": "Image description",
      "order": 0
    }
  ],
  "sentiments": [
    {
      "id": "sentiment-id-1",
      "sentiment": "like",
      "createdAt": "2024-01-15T10:05:00.000Z"
    }
  ],
  "comments": [
    {
      "id": "comment-id-1",
      "text": "Comment text",
      "postUri": "https://instance.example/posts/abc123",
      "rootUri": "https://instance.example/posts/root",
      "replyToUri": "https://instance.example/comments/parent",
      "createdAt": "2024-01-15T10:10:00.000Z",
      "media": [...],
      "sentiments": [...]
    }
  ]
}
```

**Fields:**

- `id` (string): post ID
- `text` (string): post content
- `visibility` (string): `PUBLIC` | `PRIVATE` | `FRIENDS`
- `entityRef` (string, optional): reference to a domain-extension entity (extension-defined)
- `geoData` (object, optional): geo-location data
- `uri` (string, optional): ActivityPub activity ID (for public/federated posts)
- `contentWarnings` (array): content warning labels
- `createdAt` (string, ISO 8601): post creation timestamp
- `updatedAt` (string, ISO 8601): last update timestamp
- `media` (array): media attachments
- `sentiments` (array): reactions on this post
- `comments` (array): comments on this post

---

## Comment Object

```json
{
  "id": "comment-id-1",
  "postId": "post-id-123",
  "postUri": "https://instance.example/posts/abc123",
  "text": "Comment text here",
  "rootUri": "https://instance.example/posts/root",
  "replyToUri": "https://instance.example/comments/parent",
  "createdAt": "2024-01-15T10:10:00.000Z",
  "media": [
    {
      "id": "comment-media-id",
      "mediaId": "media-file-id",
      "alt": "Image description",
      "order": 0
    }
  ],
  "sentiments": [
    {
      "id": "comment-sentiment-id",
      "sentiment": "like",
      "createdAt": "2024-01-15T10:15:00.000Z"
    }
  ]
}
```

**Fields:**

- `id` (string): comment ID
- `postId` (string): ID of post being commented on
- `postUri` (string, optional): ActivityPub activity ID of post
- `text` (string): comment content
- `rootUri` (string, optional): root post URI (for threaded comments)
- `replyToUri` (string, optional): parent comment URI (for replies)
- `createdAt` (string, ISO 8601): comment creation timestamp
- `media` (array): media attachments
- `sentiments` (array): reactions on this comment

---

## Sentiment/Reaction Object

```json
{
  "id": "sentiment-id-1",
  "sentiment": "like",
  "createdAt": "2024-01-15T10:05:00.000Z"
}
```

**Fields:**

- `id` (string): sentiment ID
- `sentiment` (string): reaction type (e.g., "like", "love", "laugh")
- `createdAt` (string, ISO 8601): reaction timestamp

---

## Geo-Indexed Post Object

```json
{
  "postUri": "https://instance.example/posts/abc123",
  "entityRef": "extension-defined-reference",
  "geohash": "u33d",
  "lat": 52.52,
  "lng": 13.405,
  "place": "Berlin, Germany",
  "labels": ["park", "outdoor"],
  "createdAt": "2024-01-15T10:00:00.000Z"
}
```

**Fields:**

- `postUri` (string): ActivityPub activity ID of post
- `entityRef` (string, optional): reference to a domain-extension entity (extension-defined)
- `geohash` (string): geohash for location
- `lat` (number): latitude
- `lng` (number): longitude
- `place` (string, optional): place name
- `labels` (array, optional): location labels
- `createdAt` (string, ISO 8601): timestamp

---

## Related Documentation

- [Data Completeness](./data-completeness.md)
- [Validation](./validation.md)
- [Back to Format Specification](./README.md)
