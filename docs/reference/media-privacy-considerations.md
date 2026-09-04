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

## What is stripped from the file itself

Separate from *extraction* (what we read) is the **strip** (what we remove from
the bytes we serve). Both media types are re-encoded and served metadata-free, but
by different mechanisms:

- **Images** are re-encoded through sharp without `.withMetadata()`, which drops
  EXIF, IPTC, XMP and any C2PA manifest. `assertNoExif` enforces it.
  **One exception is kept deliberately, and it is not kept in the file:** the
  C2PA manifest store is copied out of the original *before* the strip and
  written as a separate sidecar object (`cas/{tenant}/{hash}.c2pa`), because
  destroying it is irreversible and it is the only thing a viewer could ever
  check a Content Credentials claim against. The served bytes are unaffected —
  the manifest never goes back into them. The sidecar is treated as the most
  privacy-sensitive object of the set (it carries camera serial numbers, capture
  times, often an identity claim) and is deleted by every media-deletion path
  alongside the image itself. It is summarised on the media record and in the
  media read response, always as **extracted, unverified** — no signature is
  checked. See
  [`provenance-api.md`](provenance-api.md#c2pa-manifests-on-media).
- **Video and audio** are re-encoded through ffmpeg with `-dn -sn`
  (drop data and subtitle **streams**) **and `-map_metadata -1`** (drop the
  container metadata **dictionary**). The poster frame gets the same flags.

> **Both flags are required, and this was a live defect.** `-dn` drops data
> *streams* and does nothing to the metadata dictionary — which is where MP4 keeps
> GPS coordinates as the `©xyz` atom (`location`), alongside `comment` and `title`
> — and ffmpeg copies that dictionary from input to output by default. Verified
> against ffmpeg 8.1: with `-dn -sn` but no `-map_metadata -1`, an uploaded video's
> `location` and `comment` survived the transcode intact. Fixed 2026-08-04. If you
> ever see `-map_metadata` removed or set to anything other than `-1`, videos are
> republishing the uploader's coordinates.

One deliberate exception to the strip, added for AI Act Art. 50: a single
enumerated *provenance* value is read from the original bytes **before** the strip
runs, and nothing else. The reader's return type cannot carry GPS, camera identity
or free-form metadata — see
[the provenance API reference](./provenance-api.md).

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
