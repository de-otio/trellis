---
title: Media metadata API
description: Endpoints and response formats for image and video metadata (EXIF, IPTC, video) and per-media visibility flags.
sidebar: Media API
order: 30
---

# Media metadata API

Media items carry optional metadata extracted from the uploaded file: a small
EXIF/IPTC subset for images, and basic technical metadata for videos. The media
details endpoint exposes this metadata to the **owner**, along with two
visibility flags the owner controls.

See [Media privacy considerations](./media-privacy-considerations.md) for the
privacy model and [Media metadata data model](./media-data-model.md) for the
stored fields.

> **Flag — metadata is not populated on upload as shipped.** The upload path
> persists only `width`, `height`, and `duration`. The `exifData`, `iptcData`,
> `videoMetadata`, and `dateTaken` fields described below are returned by the
> endpoint contract but are `null` in practice until the metadata-persistence
> wiring lands. See the data-model doc for details.

## GET `/api/media/:mediaId`

Owner-only. Returns the media details. When metadata has been populated, the
response includes `exifData`, `iptcData`, and/or `videoMetadata`.

This endpoint is owner-only: ownership is verified (media must appear in one of
the caller's posts or be used as one of their entity avatars), and the **full**
metadata is returned to the owner. The `metadataVisible` / `locationVisible`
flags are returned so the client can render toggle state; the endpoint does not
itself strip fields based on them.

> **Note on path overloading.** This route also serves the raw binary when the
> path segment is a 64-character hex content hash (e.g.
> `GET /api/media/<hash>?variant=thumbnail|optimized|original`). The JSON
> details response described here applies when the segment is a media id (a
> CUID), not a content hash.

```typescript
{
  id: string;
  contentHash: string;
  cid: string | null;
  mimeType: string;
  size: number;
  thumbnailUrl: string;
  optimizedUrl: string;
  originalUrl: string;
  width?: number;
  height?: number;
  duration?: number;

  // Metadata (null until populated — see flag above)
  exifData?: {
    make?: string;
    model?: string;
    lensModel?: string;
    software?: string;
    iso?: number;
    fNumber?: number;       // aperture
    exposureTime?: number;  // seconds
    focalLength?: number;   // mm
    dateTimeOriginal?: string; // ISO 8601
    gps?: { latitude: number; longitude: number };
  } | null;

  iptcData?: {
    keywords?: string[];
    copyrightNotice?: string;
    creator?: string;
    caption?: string;
  } | null;

  videoMetadata?: {
    width?: number;
    height?: number;
    duration?: number;
  } | null;

  dateTaken?: string;  // ISO 8601, from the date_taken column

  // Visibility flags (owner preference; do not filter this response)
  metadataVisible: boolean;
  locationVisible: boolean;

  createdAt: string;
  updatedAt: string;
  hidden: boolean;
  hiddenAt: string | null;
  deletedAt: string | null;

  posts: Array<{
    id: string;
    text: string;
    createdAt: string;
    visibility: "PUBLIC" | "PRIVATE" | "FRIENDS";
    url: string;
  }>;

  canDelete: boolean;
  canHide: boolean;
}
```

The endpoint takes no metadata-related query parameters. (There is no
`includeMetadata` or `includeExif` parameter; the only query parameter the
route reads is `variant`, used for the content-hash binary-serving path.)

## PATCH `/api/media/:mediaId/metadata-visibility`

Owner-only. Updates the two per-media visibility flags. At least one of the two
fields must be present; both are optional individually.

```typescript
{
  "metadataVisible"?: boolean,
  "locationVisible"?: boolean
}
```

There are no granular / field-level visibility settings. The request body is
validated to exactly these two boolean keys; sending neither returns
`400`.

### Response

```json
{
  "success": true,
  "media": {
    "id": "clx123abc",
    "metadataVisible": true,
    "locationVisible": false
  }
}
```

### Errors

- `400 Bad Request` — invalid JSON, failed validation, or neither flag
  provided.
- `401 Unauthorized` — no valid session.
- `404 Not Found` — media not found, or the caller does not own it.

## Other media endpoints

For completeness, the media routes also include:

- `POST /api/media/upload` — single upload (multipart `file` field).
- `POST /api/media/upload/batch` — `501 Not Implemented` (the legacy batch
  path bypassed moderation and was removed; upload files individually).
- `GET /api/media` — list the caller's media (paginated, filterable).
- `GET /api/media/grouped` — list grouped by month or year.
- `GET /api/media/stats` — collection statistics.
- `POST /api/media/:mediaId/hide` / `POST /api/media/:mediaId/unhide`.
- `DELETE /api/media/:mediaId` — soft delete (hides instead if shared).
- `GET /api/media/:hash` — serve the binary by content hash.

> **The serve route is fail-closed: only `APPROVED` media returns bytes.**
> `GET /api/media/:hash` streams the object only when its `moderationStatus`
> is `APPROVED` (and it is not hidden or soft-deleted), for every viewer —
> there is no owner exception. Every other case — `PENDING` / `REVIEW` /
> `QUARANTINED` / `REJECTED`, not-found, or a backend error — returns a single
> byte-identical "not found" response, so the endpoint cannot be probed as a
> moderation-state oracle. Newly uploaded video/audio is `PENDING` and does
> not serve until the asynchronous moderation pipeline approves it. See
> [Media Moderation](../concepts/media-moderation.md).

## Response example (image details)

```json
{
  "id": "clx123abc",
  "contentHash": "a3f5b2c1...",
  "cid": null,
  "mimeType": "image/jpeg",
  "size": 2456789,
  "thumbnailUrl": "https://api.example.com/api/media/a3f5b2c1...?variant=thumbnail",
  "optimizedUrl": "https://api.example.com/api/media/a3f5b2c1...?variant=optimized",
  "originalUrl": "https://api.example.com/api/media/a3f5b2c1...?variant=original",
  "width": 1920,
  "height": 1080,
  "metadataVisible": true,
  "locationVisible": false,
  "createdAt": "2025-01-15T15:30:00Z",
  "updatedAt": "2025-01-15T15:30:00Z",
  "hidden": false,
  "hiddenAt": null,
  "deletedAt": null,
  "exifData": null,
  "iptcData": null,
  "videoMetadata": null,
  "posts": [],
  "canDelete": true,
  "canHide": true
}
```

## Behaviour notes

- **Owner-only.** The details and visibility endpoints require an authenticated
  session and verify ownership. Metadata is not exposed through public APIs.
- **Missing metadata is not an error.** `exifData`, `iptcData`, and
  `videoMetadata` are `null` when absent. Each type is independent.
- **Extraction failures do not fail uploads.** If metadata cannot be extracted,
  the upload still succeeds; the relevant field is simply absent.
