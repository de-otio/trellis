---
title: Media security
description: How Trellis handles image and video metadata securely — validation, location privacy by default, access control, and data minimization.
sidebar: Media security
order: 40
---

# Media security

Uploaded images and videos carry embedded metadata — EXIF, IPTC, and video tags —
that can include sensitive information such as GPS coordinates, device
identifiers, and timestamps. Trellis treats this metadata as untrusted input and
as personal data, and handles it accordingly.

## Validate everything

All metadata is validated against a schema before it is stored. Metadata that is
malformed, corrupted, or oversized is rejected or handled gracefully rather than
trusted.

- **Structured validation.** Each metadata type is validated against a schema;
  malformed input is rejected.
- **String fields are sanitized.** Text fields are sanitized, length-bounded, and
  validated as UTF-8, with HTML and script tags stripped, so metadata cannot
  carry an injection payload or be used to exhaust resources.
- **GPS coordinates are range-checked.** Latitude must be within -90 to 90 and
  longitude within -180 to 180; values that are out of range, infinite, or not a
  number are dropped. (Altitude is not extracted.)
- **Dates are bounded.** Timestamps are validated, rejected if they fall outside
  a plausible window, and normalized to an ISO 8601 UTC string for storage.
- **Keyword lists are bounded**, with a maximum count, per-keyword length
  limits, and non-string values dropped.

Metadata sizes are capped so that a single upload cannot store an unbounded
amount of metadata.

## Location privacy by default

Location is the most sensitive metadata, and the data model hides it by default.

- **Hidden unless the user opts in.** The `locationVisible` flag defaults to
  `false`. A user must take an explicit action to set it `true`.
- **Clear indication.** The consuming application's UI is expected to indicate
  clearly when location is visible.
- **Visibility changes are audited.** Updates to the visibility flags are
  written to the audit log (`media_metadata_visibility_updated`), so changes to
  location exposure leave an audit trail.

> **Flag — the visibility flags are not yet enforced as response filters.** The
> media-details endpoint is owner-only and returns the full metadata to the
> owner along with both flags. It does not currently strip location or other
> fields based on the flags; flag-driven filtering for shared/non-owner views is
> a design intent that is not wired into the current endpoint.

## Access control

- The metadata-details and visibility endpoints are owner-only.
- Only the media owner can change the visibility flags.
- Metadata is not exposed through public APIs.
- Ownership is verified on these endpoints, which require an authenticated
  session.

## Data minimization

- Only the metadata fields that are actually needed are extracted.
- Sensitive fields are not extracted unless there is a reason to.
- User privacy preferences are respected throughout.

## Metadata is not a security input

EXIF and similar metadata can be modified by anyone who handles the file, so
Trellis never uses it for authentication or authorization decisions. It is
treated as descriptive content, validated for consistency, and never trusted for
security checks.

## Data subject rights

Metadata such as location is personal data, and Trellis handles it under the same
rights as other personal data:

- It is included in a user's data export.
- When media is deleted, its metadata is deleted with it. Media deletions are
  written to the audit log.

See [Compliance](compliance.md) for how these rights map to regulatory
obligations.

## Threats this guards against

Embedded media metadata can leak more than users expect. The controls above
specifically address:

- **Location tracking** — GPS data revealing where a user has been. Mitigated by
  hiding location by default and giving users explicit control.
- **Device fingerprinting** — device identifiers linking media to a user.
  Mitigated by access control and data minimization.
- **Timeline reconstruction** — timestamps revealing activity patterns. Mitigated
  by the same owner-only access controls.
- **Metadata leakage in shared media** — mitigated by not exposing metadata
  through public APIs.

For the broader platform posture, see
[Security architecture](security-architecture.md). For the user-facing view of
EXIF privacy, see
[Media privacy considerations](../reference/media-privacy-considerations.md).
