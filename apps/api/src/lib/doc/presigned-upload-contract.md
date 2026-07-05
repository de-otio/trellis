# FROZEN CONTRACT — Presigned direct-to-S3 upload (T14)

Status: **frozen** for the Flutter follow-on. Video/audio uploads MUST use this
flow; they are no longer accepted through the proxied `POST /api/media/upload`
path (that path now returns `400 { "error": "Use presigned upload" }` for
video/audio). Small images MAY continue to use the proxied path.

All endpoints require an authenticated session cookie. Middleware: CORS + CSRF.
One presigned session == one object == one `MediaFile` row.

---

## 1. Create a session + get the grant

`POST /api/upload-sessions`

Body selects the flow:
- **Presigned** (this contract): JSON body `{ "mimeType": string, "sizeBytes": number }`.
- Legacy optimistic image flow: empty/no body (unchanged).

Rate limit: 10 sessions/hour/user.

### 201 response
```jsonc
{
  "ok": true,
  "session": {
    "sessionId": "c…",            // cuid; == MediaFile.uploadId; == object-key segment
    "mediaId":   "c…",            // the MediaFile row id
    "status":    "awaiting-upload",
    "expiresAt": "2026-07-06T12:00:00.000Z"  // ISO-8601; session TTL 24h
  },
  "upload": {
    "method": "POST",             // multipart/form-data POST to S3
    "url":    "https://<bucket>.s3.<region>.amazonaws.com/",
    "fields": { /* policy, x-amz-signature, x-amz-credential, key, Content-Type, … */ },
    "objectKey": "pending/<tenantId>/<sessionId>",
    "expiresInSeconds": 900       // grant lifetime, clamped to [60,3600]
  },
  "constraints": {
    "maxBytes": 314572800,        // the content-length-range MAX (byte rail);
                                  // for video/*: the COMBINED video+audio
                                  // track budgets (a muxed file carries both);
                                  // for audio/*: the audio-track budget
    "maxDurationSeconds": 60      // user-facing limit; client trims to this
  }
}
```

### Client upload step (not an API call)
Build a `multipart/form-data` body: **every** `upload.fields` entry first, then a
`file` field with the bytes, and POST to `upload.url`. S3 enforces, server-side:
- **`content-length-range` [1, maxBytes]** — an over-cap PUT/POST is rejected by
  **S3**, not the API (the bytes never reach Fargate). Ref: AWS "Creating a POST
  Policy", condition `["content-length-range", min, max]` (inclusive bytes).
- **exact `key`** = `objectKey` (prefix-confined to `pending/…`, never `cas/`).
- **exact `Content-Type`** = the declared MIME.
S3 returns `204` (or `201`) on success; `403 EntityTooLarge` when the byte rail
rejects.

### Refusals (no grant issued; typed)
| status | when |
|---|---|
| 400 | `mimeType`/`sizeBytes` missing or wrong type; or `sizeBytes` ≤ 0 / non-integer |
| 413 | declared `sizeBytes` exceeds the byte cap |
| 415 | MIME is not an allowlisted `video/*`\|`audio/*` (images keep the proxied path) |
| 429 | session rate limit |
| 500 | tenant resolution failed |
| 503 | quota read failed (fail-closed) / quota exceeded → 413 (bytes) or 429 (objects) |

---

## 2. Complete the session

`POST /api/upload-sessions/:id/complete`

Call **after** the S3 upload returns success. Idempotent.

**Authz:** the session is looked up by `(id, userId, kind="presigned")`. A caller
can neither complete another user's session nor complete a legacy session id here
(both → 404, identical to a nonexistent id). Completion can **never** promote or
approve: it only drives the `MediaFile` `AWAITING_UPLOAD → UPLOADED` transition
(idempotent against the S3-event pickup that already enqueued moderation).
Verdicts belong solely to the async moderation pipeline.

### 200 response
```jsonc
{
  "ok": true,
  "session": { "sessionId": "c…", "mediaId": "c…", "status": "uploaded" },
  "media":   { "id": "c…", "lifecycle": "UPLOADED" }  // never APPROVED from here
}
```

### Refusals
| status | when |
|---|---|
| 404 | no such session for this user (also: legacy id → falls through to legacy handler) |
| 409 | no object found at the granted key yet (upload not done); or session in a non-completable state; or half-created session |
| 410 | session expired (media driven to `UPLOAD_FAILED`, staged object deleted) |
| 413 | staged object exceeds the cap (defense-in-depth; object deleted, session failed) |

**Moderation is enqueued by the bytes arriving** (S3 `OBJECT_CREATED` on the
`pending/` prefix), NOT by this call — a client that never calls complete still
cannot keep uploaded bytes out of moderation, and complete never skips it.

---

## 3. Abandon the session

`POST /api/upload-sessions/:id/abandon`

Same `(id, userId, kind="presigned")` authz (404 on miss → legacy fallthrough).
Marks the session `abandoned`, drives the media row to `UPLOAD_FAILED` (when the
lifecycle machine still allows it), and best-effort deletes the staged
`pending/…` object. **Refuses with 409** once the pipeline has resolved a verdict
(so abandon can never destroy moderation/audit state). Idempotent.

### 200 response
```jsonc
{ "ok": true, "session": { "sessionId": "c…", "status": "abandoned" } }
```

---

## Session state vocabulary (presigned kind)
`awaiting-upload` → `uploaded` (complete) | `abandoned` (abandon) | `expired`
(complete-after-expiry).

## Media lifecycle the client can observe (MediaFile.lifecycle)
`AWAITING_UPLOAD` → `UPLOADED` → `APPROVED` | `REVIEW` | `QUARANTINED` |
`REJECTED`; or `UPLOAD_FAILED`. **Only `APPROVED` (and `!hidden && !deletedAt`)
is servable** — the client's own optimistic preview is a local copy, never a
server URL, until `APPROVED`. Poll media status (existing media endpoints) or
consume the `moderation.resolved` event (`ready`|`not-ready`) to learn the
outcome.

## Duration limit
`maxDurationSeconds` (default 60, SSM-tunable) is the **user-facing** limit; the
client trims to it. It is enforced **authoritatively server-side** post-upload
via ffprobe: an over-cap clip is driven to `REJECTED` and its S3 object is
**deleted before any moderation job runs**. The byte cap is an invisible rail
(`content-length-range`): the SSM values are **per-track** budgets, each sized
to ~`60s × generous max bitrate`, and the rail for a `video/*` upload budgets
the **combined video+audio tracks** (a muxed file carries both — AR-SEC F2)
while `audio/*` is railed at the single audio-track budget; it only ever stops
an absurd multi-GB PUT.
