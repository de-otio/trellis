---
title: Media privacy considerations
description: How Trellis handles EXIF metadata privacy — defaults, per-media controls, storage, and deletion.
sidebar: Media privacy
order: 20
---

# Media privacy considerations

When a user uploads an image, Trellis extracts and stores the EXIF metadata
embedded in the file. EXIF data can contain sensitive information, so Trellis
applies privacy-by-default rules and gives each user per-media visibility
controls.

## What EXIF data contains

- **GPS coordinates** — the exact location where the photo was taken.
- **Device information** — camera make, model, and serial number.
- **Date and time** — when the photo was captured (may differ from the upload
  timestamp).
- **Personal information** — artist name and copyright strings embedded by the
  camera or editing software.

## Default visibility

| Field category | Default |
|---|---|
| Camera settings (ISO, aperture, shutter speed, etc.) | Visible |
| GPS / location data | Hidden |

Location data is hidden by default. A user must explicitly enable location
visibility for a given piece of media; Trellis shows a clear warning before
enabling it.

## Per-media controls

Each media item has two independent visibility toggles:

- **EXIF visibility** — show or hide all EXIF data for this item.
- **Location visibility** — show or hide GPS coordinates for this item.

Toggling location visibility off filters the GPS fields out of every API
response for that media item:

```typescript
if (!media.exifLocationVisible && exifData) {
  delete exifData.GPSLatitude;
  delete exifData.GPSLongitude;
  delete exifData.GPSAltitude;
  delete exifData.GPSLocation;
}
```

## Storage and deletion

- EXIF data is stored in the database alongside the media record.
- When a media item is deleted, its EXIF data is deleted with it.
- When a user requests account deletion, all EXIF data for their media is
  included in the deletion.
- There is no separate retention period for EXIF data.

## Access control

- Only the media owner can read EXIF data for their own items.
- Only the media owner can update privacy settings for their own items.
- EXIF data is not included in public API responses.

## Data validation

Trellis validates EXIF fields on ingestion:

- GPS latitude must be in the range −90 to 90.
- GPS longitude must be in the range −180 to 180.
- String fields (make, model, etc.) are sanitized before storage.
- Date strings are validated for format correctness.

## GDPR considerations

EXIF data — particularly location coordinates — is personal data under GDPR.
Users have the right to access, delete, and restrict processing of their EXIF
data through the standard media and account-deletion flows.
