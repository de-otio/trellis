---
title: Media privacy considerations
description: How Trellis handles EXIF metadata privacy — defaults, per-media controls, storage, and deletion.
sidebar: Media privacy
order: 20
---

# Media privacy considerations

When a user uploads an image, Trellis extracts a small subset of the embedded
EXIF/IPTC metadata. This metadata can contain sensitive information, so the
data model applies privacy-by-default flags and gives each user per-media
visibility flags.

> **Flag — extracted metadata is not persisted on upload as shipped.** The
> upload path runs extraction but writes only width/height/duration to the
> media record; the EXIF/IPTC/video JSON and the unified GPS/date columns are
> not stored. The privacy posture below describes the data-model design and the
> visibility flags that do exist; the storage and per-field claims are accurate
> for the model, not for current end-to-end behaviour.

## What the extracted EXIF subset contains

The shipped extractor (`metadata-extractor.ts`) extracts only:

- **GPS coordinates** — latitude and longitude (no altitude, no reverse
  geocoding).
- **Device information** — camera make, model, lens model, software.
- **Capture date** — `dateTimeOriginal`.
- **Capture settings** — ISO, f-number, exposure time, focal length.

IPTC extraction adds keywords, copyright notice, creator, and caption. It does
not extract serial numbers or device fingerprints.

## Default visibility

The `MediaFile` model carries two flags:

| Flag | Default |
|---|---|
| `metadataVisible` | `true` |
| `locationVisible` | `false` |

Location is hidden by default (`locationVisible` defaults to `false`). A user
must explicitly enable location visibility for a given piece of media.

## Per-media controls

Each media item has two independent boolean flags, updated via
`PATCH /api/media/:mediaId/metadata-visibility`:

- **`metadataVisible`** — owner preference for showing metadata.
- **`locationVisible`** — owner preference for showing location.

There are no granular / field-level visibility settings.

> **Flag — the flags are stored but not yet enforced as response filters.** The
> media-details endpoint (`GET /api/media/:mediaId`) is owner-only and returns
> the full metadata to the owner together with both flags so the client can
> render toggle state; it does not strip GPS or other fields based on the flags.
> Filtering for non-owner / shared views is a design intent that is not wired
> into the current endpoint.

## Storage and deletion

- Metadata columns live on the media record (see the storage flag above).
- When a media item is deleted, its metadata is deleted with it.
- Account deletion includes the user's media and any stored metadata.
- There is no separate retention period for media metadata.

## Access control

- The media-details and visibility endpoints are owner-only and require an
  authenticated session.
- Only the media owner can update the visibility flags.
- Metadata is not exposed through public APIs.

## Data validation

Metadata is validated on ingestion (`metadata-schemas.ts` /
`metadata-sanitizer.ts`):

- GPS latitude must be in −90 to 90, longitude in −180 to 180; out-of-range,
  infinite, or non-numeric values are dropped.
- String fields (make, model, etc.) are sanitized and length-bounded.
- Capture dates are validated and bounded to a plausible window.

## GDPR considerations

Media metadata — particularly location coordinates — is personal data under
GDPR. Users have the right to access, delete, and restrict processing of this
data through the standard media and account-deletion flows.
