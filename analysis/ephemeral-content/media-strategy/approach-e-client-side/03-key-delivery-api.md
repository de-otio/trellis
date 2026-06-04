# Key Delivery API

The critical new component. The API must deliver DEKs to authorised clients securely and efficiently.

## Endpoint Design

### Single Post Key

```
GET /api/posts/{id}/media-key
Authorization: Bearer <session-token>

Response (live post):
{ "dek": "<base64-encoded-dek>", "algorithm": "AES-256-GCM", "expires_in": 900 }

Response (sunset post, owner):
{ "dek": "<base64-encoded-dek>", "algorithm": "AES-256-GCM", "expires_in": 900 }

Response (sunset post, non-owner):
403 { "error": "CONTENT_SUNSET" }

Response (post not found):
404 { "error": "NOT_FOUND" }
```

### Batch Key Fetch (Feed Rendering)

```
POST /api/posts/media-keys
Authorization: Bearer <session-token>
Content-Type: application/json

{ "post_ids": ["abc123", "def456", "ghi789", ...] }

Response:
{
  "keys": {
    "abc123": { "dek": "<base64>", "algorithm": "AES-256-GCM" },
    "def456": { "dek": "<base64>", "algorithm": "AES-256-GCM" },
    "ghi789": null  // sunset, non-owner
  },
  "expires_in": 900
}
```

One round trip for an entire feed page. Maximum batch size: 50 (prevents abuse).

## Client-Side Key Caching

- Cache DEKs in memory for the session or a configurable TTL (e.g., 15 minutes)
- Multiple media files on the same post share one DEK -- one key request per post, not per media file
- On app backgrounding: optionally clear the key cache (aggressive security) or retain (better UX)
- **Never persist DEKs to disk** -- keys live in memory only

## Security Considerations

### Transport

DEKs are delivered over TLS. The session token authenticates the request. Same transport security as any other authenticated API call.

### Access Control

The key delivery endpoint enforces the same access rules as content serving:

- Live post: any authenticated user can fetch the key (same as viewing the post)
- Sunset post: only the owner can fetch the key (archive access)
- Unauthenticated: no key (same as no content access)

If the platform has privacy settings (friends-only posts), the key endpoint must respect them too.

### Rate Limiting

The key delivery endpoint should be rate-limited to prevent bulk key harvesting:

- Per-user: 100 key requests/minute (generous for normal browsing)
- Per-IP: 500 key requests/minute
- Batch endpoint: 10 batch requests/minute, max 50 IDs per batch

### Key Expiry

The `expires_in` field is a hint, not enforcement. The real access control is server-side -- the API decides whether to issue the key on each request. If the post is sunset between key issuance and key expiry, the client has a key that works but won't get a new one.

This is acceptable: the client already had the decrypted media in memory. The key expiry window is no worse than the CDN cache TTL in Approach B.

## Performance

- Database lookup: one indexed query per post (or batch query)
- No KMS calls in access-control-only mode (DEK stored plaintext in DB)
- With future encryption mode: one KMS Decrypt call per unique DEK to unwrap before delivery
- Response size: ~100 bytes per key. A 20-post batch response is ~2 KB.

## Open Questions

1. **Anonymous/public access**: If posts are public, should the key be available without authentication? This is a policy question -- encryption becomes decorative if keys are freely available.
2. **Key rotation**: If a DEK is compromised, can it be rotated? This would require re-encrypting all media for that post.
3. **Revocation**: If a user's session is compromised, can all issued keys be invalidated? Not directly -- but the session revocation already prevents new key fetches.
