---
title: Media Moderation
description: The fail-closed media-moderation pipeline — lifecycle states, the APPROVED-only serve gate, and the dual-track (visual + audio) model with fail-closed fan-in.
sidebar: Media Moderation
order: 17
---

# Media Moderation

Trellis treats every uploaded media object as untrusted until it has been
explicitly approved. Bytes are served **only** after a positive moderation
verdict; nothing serves "by default". This page describes the lifecycle, the
serve gate, the dual-track model for video/audio, and the capability seams the
consuming application wires up.

The moderation core is a set of pure functions under
`apps/api/src/lib/media/`, exercised by property-based tests. It carries no
operational thresholds, secrets, or real-category vocabulary — it ships in the
public npm package. The numeric thresholds, duration caps, and rate limits are
runtime configuration (`Env.media`, from environment variables); the
consuming application supplies them.

## Lifecycle states

A media object's `moderationStatus` is one of five states, persisted on the
`MediaFile` row:

| State | Meaning |
|-------|---------|
| `PENDING` | Born here. Nothing serves until a verdict moves it forward. |
| `APPROVED` | The **only** state that serves bytes. |
| `REVIEW` | The classifier was uncertain — awaiting a human moderator. |
| `QUARANTINED` | The classifier flagged it — awaiting a human moderator. |
| `REJECTED` | Terminal. Never serves. |

The legal transitions are a pure state machine (`moderation-status.ts`):

```
PENDING            --decision approved-->   APPROVED
PENDING            --decision review-->     REVIEW
PENDING            --decision quarantine--> QUARANTINED
REVIEW|QUARANTINED --human approve-->       APPROVED
REVIEW|QUARANTINED --human reject-->        REJECTED
(any state)        --csam-->                REJECTED   (terminal)
```

Properties enforced by the machine (and property-tested):

- **Fail-closed.** An unknown or unexpected classifier decision degrades to
  `REVIEW`, never to `APPROVED`.
- `APPROVED` and `REJECTED` are absorbing under ordinary events; only a human
  action moves a `REVIEW` / `QUARANTINED` object, and only a CSAM event can
  move a terminal object (to `REJECTED`).
- An illegal transition is *reported*, never silently coerced into `APPROVED`.

CSAM detection is deliberately **not** part of the classifier decision path:
it is a separate, statutory provider with preserve-and-report duties, and it
drives `REJECTED` from any state.

## The fail-closed serve gate

The serve path (`serveMediaByHash`, gated by `serve-gate.ts`) returns bytes
only when an object is `APPROVED` **and** not hidden **and** not soft-deleted.
This holds for every viewer — there is **no owner exception**. An owner's
"I can see my own upload" view is a client-local copy, never a server URL.

Every non-servable outcome — `PENDING` / `REVIEW` / `QUARANTINED` /
`REJECTED`, a missing record, or a database error — returns a single
byte-identical "not found" response. A caller therefore cannot distinguish
"not approved yet" from "does not exist" from "backend is down", so the serve
endpoint cannot be used as a moderation-threshold oracle. The content type of
an approved response is derived solely from the canonical format the bytes were
re-encoded into, never from attacker-influenced request or stored metadata.

> **Images are re-encoded on ingest, but born `PENDING`.** An uploaded image is
> re-encoded to a canonical raster format synchronously (stripping EXIF/GPS and
> any embedded payload) and stored at its CAS key, but the row is created
> `PENDING`. There is no automatic image-approval path in the current code —
> the only automatic promotion to `APPROVED` is the asynchronous video/audio
> completion path described below; otherwise an object reaches `APPROVED`
> through a human moderator action. The image-moderation provider seam exists
> for a consuming application to wire that path in.

## The dual-track model (video / audio)

A video can carry two independently-moderated tracks, and a positive verdict
on one does not vouch for the other:

- **VISUAL track** — moderated via the video-moderation provider
  (`MediaModerationProvider`, an async start → poll job).
- **AUDIO track** — the cleaned output is transcribed (`TranscribePort`) and
  the transcript is classified by the text-moderation seam
  (`TextModerationProvider`).

An audio-only object has only the AUDIO track; an image has only the VISUAL
track.

### Processing flow

1. **Ingest.** Video/audio uploads are written to a `pending/{tenant}/{upload}`
   quarantine prefix and the `MediaFile` row is created `PENDING`, with hashing
   deferred. A per-tenant upload quota is enforced before the object is
   enqueued.
2. **Processing worker** (triggered when an object lands under `pending/`):
   re-derives the tenant from the row, enforces the duration cap, then
   transcodes-and-discards to a transient staging key (outside `pending/`, so
   the cleaned bytes can never re-trigger the worker). It hashes the **cleaned**
   bytes to establish the content identity, persists that hash and the future
   serve key, and **starts** the per-track moderation jobs on the cleaned
   staging bytes — exactly the bytes that will eventually be served. The worker
   only starts jobs; it never fetches verdicts.
3. **Completion worker** (on each track's resolution): treats the incoming
   message as an untrusted pointer, re-fetches authoritative state, dedupes,
   combines both tracks, and — only on approval — promotes the cleaned staging
   bytes to the served `cas/{tenant}/{hash}` prefix, then persists the new
   status. The `cas/` prefix holds approved bytes only: **served bytes equal
   moderated bytes equal cleaned bytes.**

Moderation always runs on the cleaned, transcoded output — never on the raw
upload — so the bytes that are inspected are the bytes that are served.

### Fan-in semantics

The two per-track outcomes are combined into one object-level decision by
`combineTrackVerdicts`, in this precedence order:

1. **Quarantine dominates.** If either decided track is `quarantine`, the
   object is `quarantine` — a confirmed flag on any track wins, and is not
   allowed to decay just because the sibling track was absent or errored.
2. **Approval requires positive evidence on both tracks.** The object is
   `approved` if and only if **both** tracks are decided **and** both decisions
   are `approved`.
3. **Everything else degrades to review.** Any `review`, any errored track, any
   absent track, or any mix fails closed to `REVIEW`.

Consequences (property-tested): a single missing or failed track never yields
`approved`; approval requires positive evidence on both tracks; quarantine is
sticky across an absent/errored sibling; and the combinator never returns
`approved` from doubt. Promotion to served bytes additionally requires that the
content-addressed object is actually present in storage — approval alone never
serves bytes that are not there.

### No-audio videos

A video with no audio stream (a silent clip, a screen recording, a GIF-style
mp4) has nothing to transcribe. The transcode seam reports whether the cleaned
output carries an audio stream (`TranscodeVideoResult.hasAudio`, from a probe
of the produced bytes — not a guess). When there is no audio, the processing
worker starts **no** transcription and records the AUDIO track as **vacuously
approved** (no audio content ⇒ nothing to be unsafe), under a synthetic job id
that no completion message can reference. The VISUAL completion then fans in
against this settled AUDIO decision.

This is the one place a track is approved without an external verdict, and it
is safe: it is a positive verdict on a track that has *no content*, not
approval-from-doubt. Fail-closed is preserved everywhere else — an errored or
absent track still degrades the object to `REVIEW`. Before this handling, a
no-audio video would start a transcription that failed, fault the AUDIO track,
and pin the object in `REVIEW` permanently.

## Injected capability seams

The moderation core binds no cloud SDK. It ships the *interfaces* plus a
fail-closed Null provider and in-memory Mocks; the consuming application injects
the concrete cloud adapters at startup (mirroring the `RealtimeTransport`
seam).

| Seam | Responsibility | Shipped in core |
|------|----------------|-----------------|
| `MediaModerationProvider` | Image / video moderation (start → poll for video). | Interface + fail-closed `NullModerationProvider` + `MockModerationProvider`. |
| `TextModerationProvider` | Classify free text (the AUDIO track's transcript) into a 3-value verdict. | Interface + `MockTextModerationProvider`. |
| `TranscodePort` | Re-encode/normalize video & audio to a known-clean form, probe duration, and report `hasAudio`. | Interface + `MockTranscodePort`. |
| `TranscribePort` | Async speech-to-text for the AUDIO track. | Interface + `MockTranscribePort`. |
| `StoragePort` | Object storage (get/put/copy/delete/head). | Interface + `MockStoragePort`. |

Binding rules every provider must obey:

- A classifier verdict is **3-value** (`approved` / `review` / `quarantine`).
  `rejected` is a lifecycle status reached only by human or CSAM action, never
  a provider decision.
- Absence of signal, an internal fault, a spent budget, or **any** uncertainty
  must fail closed to `review`. A provider must never manufacture `approved`
  from doubt.
- References are opaque (a key plus a bucket handle), never raw bytes.

The Null provider returns `review` for every call and warns loudly. A startup
guard refuses to run it outside development: an un-moderated, fail-closed
backend in production would silently send all media to review with no path to
approval, so the wiring fails loudly instead.

## Where to look in the code

| Concern | Module |
|---------|--------|
| Lifecycle states + state machine | `apps/api/src/lib/media/moderation-status.ts` |
| Serve gate predicate | `apps/api/src/lib/media/serve-gate.ts` |
| Track fan-in | `apps/api/src/lib/media/track-verdict.ts` |
| Promotion decision | `apps/api/src/lib/media/promote-decision.ts` |
| Provider / text-moderation seams | `apps/api/src/lib/media/moderation-provider.ts`, `text-moderation.ts` |
| Transcode / transcribe / storage seams | `apps/api/src/lib/media/media-ports.ts` |
| Processing & completion workers | `apps/api/src/lambda/media-processing-worker.ts`, `media-completion-worker.ts` |
| Canonical CAS keys | `apps/api/src/lib/media/cas-keys.ts` |

See also [Storage & CDN](storage-and-cdn.md) for the key prefixes and delivery
path, and the [Media metadata API](../reference/media-api.md) for the media
endpoints (note that non-`APPROVED` media does not serve).
