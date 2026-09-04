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

> This page covers **metadata** privacy. The complementary control is the
> fail-closed **media-moderation** pipeline: uploaded bytes are served only
> after explicit approval, images are re-encoded on ingest (stripping
> EXIF/GPS), and video/audio pass a dual-track (visual + audio) moderation
> check before any byte is served. See
> [Media Moderation](../concepts/media-moderation.md).

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

## Moderation observability is an oracle

Counters about moderation are genuinely needed — a provider that has quietly
started reviewing everything, or a taxonomy that has been running unpinned for
a month, are both invisible without them. They are also, if published and
fresh, a **per-upload verdict readout**: upload a probe, poll a counter, watch
which bucket moves, and you can tune content against the classifier without
ever seeing a decision.

Three controls keep the first without the second:

- **Aggregates only.** Counters are keyed by `{provider, decision}` and carry
  no media id, tenant, user, or key.
- **Closed windows only.** Snapshots report completed time buckets and never
  the one in progress. A probe uploaded now cannot be read back now — that is
  what breaks the poll-and-correlate loop, rather than merely slowing it.
- **Authenticated surface only.** The unauthenticated health payload carries
  exactly one moderation fact: a boolean saying a provider is wired. That is
  what an uptime check needs and it says nothing about any upload.

The same reasoning governs the audit record kept behind a video verdict —
per-frame decisions, labels, confidences, frame offsets, sampling parameters,
skip counts. All of it is recorded server-side, because the frames it describes
are deleted moments later and it cannot be reconstructed afterwards; **none of
it may be served to a client**, because together it tells an adversary which
frames were looked at and how close a piece of content came to a bar.

Provider names are treated as untrusted before becoming a metric dimension:
validated against the operator-declared set, charset-restricted, and
length-capped, so a hostile or merely sloppy value cannot blow up a metrics
backend's cardinality.

## Approval applies to specific bytes

A moderation verdict is a statement about the bytes that were scanned, not
about a key. Between a scan and an approval — automatic or human — the object
at a staging key may have been replaced.

So every path that can make bytes servable copies a **version-pinned** source:
the exact version recorded when the classifier ran. This includes the human
review queue, where the temptation to "just copy what's there" is strongest and
the consequence is worst — an approval that copies current bytes launders
unreviewed content through a moderator's decision. When the pinned version can
no longer be resolved, the promotion is **refused** and the item stays in
review. Doubt holds; doubt never serves.

Pins are opaque: captured once and compared, never recomputed. An entity tag is
not a content digest on every store (a multipart upload's tag is a digest of
digests), so "verifying" a pin by re-hashing bytes would disagree with itself
for identical content.

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
  through public APIs. Frames sampled from a video for moderation are extracted
  with the container metadata dictionary stripped, so a still cannot carry
  location tags that the transcode removed from the video itself.
- **Classifier tuning by oracle** — probing the pipeline to learn where the
  bars sit. Mitigated by keeping thresholds out of the published package,
  keeping verdict counters authenticated and coarsened, and never serving the
  per-frame evidence behind a verdict.
- **Approval of unreviewed bytes** — swapping an object between the scan and
  the approval. Mitigated by version-pinned promotion on every path, and by
  refusing to promote when the pin cannot be resolved.

For the broader platform posture, see
[Security architecture](security-architecture.md). For the user-facing view of
EXIF privacy, see
[Media privacy considerations](../reference/media-privacy-considerations.md).
