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

The legal transitions are a pure state machine (`media-lifecycle.ts`):

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

### Frame-sampled video, resolved inline

When the video half of the seam is served by core's frame-sampling adapter, the
shape of the flow changes in one way worth understanding.

The adapter does the whole job during `startVideoModeration`: it samples,
classifies each frame, and aggregates. There is no remote job to poll and no
completion notification will ever arrive, so it returns the decision alongside
the job id and the processing worker records it immediately — the same
mechanism a silent video's audio track already used.

That leaves one case where nothing external can settle the object: a **silent**
video whose visual track also resolved inline. Both tracks are decided the
moment processing finishes, and waiting for a message that will never be sent
would leave the object un-servable and un-rejected indefinitely. So the
processing worker settles it there, reusing the same pure promotion decision
and the same version-pinned copy the completion worker uses — the two paths
cannot drift on what "approved" means, because they are the same code.

The aggregation law is deliberately one-directional: it can degrade a verdict
and can never improve one.

1. **Quarantine dominates** — one quarantined frame quarantines the video.
2. Otherwise the **worst frame wins**; `approved` requires every frame to have
   approved.
3. **Zero frames** ⇒ `review`. No evidence is not good evidence.
4. A frame that could not be classified counts as `review` at best.
5. **An extraction shortfall** ⇒ `review`, regardless of the per-frame
   verdicts. If fewer frames decoded than the policy expected, the video was
   only partly seen — this is the rule that stops a clip whose harmful frames
   fail to decode from being approved on its benign ones.
6. A sampling plan that **exceeds the operator's per-job ceiling** ⇒ `review`.
   Silently sampling fewer would scan the video at a rate nobody chose, and
   would afterwards be indistinguishable from a decode failure.

Sampling time is spent inside the processing worker's budget, bounded by the
frame ceiling. Extracted frames are deleted on every path, and they are
extracted with the container metadata dictionary stripped — a sampled still
must not resurrect the location tags the transcode removed.

### Audio-only uploads are refused

The pipeline resolves a VISUAL track and an AUDIO track derived from a video.
An audio-only object has no visual track to resolve, so it is refused at the
type-routing boundary with a specific error rather than accepted. The
alternative is worse than a refusal: stored bytes that no verdict can settle,
a row that is neither servable nor rejected, and a client that believes the
upload succeeded.

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

Core also ships pieces that sit *between* the pipeline and a provider, so that
binding a backend does not mean re-implementing them:

| Capability | What it does | Why it is in core |
|------------|--------------|-------------------|
| `FrameSamplingVideoModerationAdapter` | Turns an image-only classifier into a video one: samples frames, classifies each through `moderateImage`, aggregates. | Most classifiers have no video job model, and every implementor writing their own sampling loop would re-derive the same aggregation rules — differently. |
| `createLabelPolicy` | Derives the decision from the provider's labels under the **operator's** category map and confidence bars. | Moves authorship of the policy from the vendor to the operator, who can audit and change it. |
| `withModerationDeadline` | Bounds every seam call and commits the decision at the deadline. | A timeout that only stops waiting is not a timeout; the late-answer rule has to live somewhere both paths share. |
| `createMediaBytesAccess` | Hands an adapter a size-capped, version-pinned `Buffer`. | A classifier that takes bytes in its request body otherwise needs its own storage credentials — a second identity with read access to all user media. |
| `parseCompletionEnvelope` | Accepts the canonical `{ track, jobId }` completion body, and the historical wire shapes. | Signalling completion should not mean reproducing a particular vendor's notification JSON. |

Binding rules every provider must obey:

- A classifier verdict is **3-value** (`approved` / `review` / `quarantine`).
  `rejected` is a lifecycle status reached only by human or CSAM action, never
  a provider decision.
- Absence of signal, an internal fault, a spent budget, or **any** uncertainty
  must fail closed to `review`. A provider must never manufacture `approved`
  from doubt.
- References are opaque (a key plus a bucket handle), never raw bytes. A ref may
  carry a **pin** (a version id, an entity tag, or a content hash); when it
  does, the provider must scan that exact version, and the pin is compared,
  never recomputed — an entity tag is not a content digest on every store.
- A verdict should report `modelVersion`, the opaque identifier of the taxonomy
  that produced it. Under a pinned label policy, a verdict without one is
  unverifiable and therefore `review`: a category map is only meaningful
  against the taxonomy it was written for, and a silent model reship would
  otherwise keep the map "working" while changing what it means.
- Failures should be thrown as `ModerationProviderError` with an honest
  `retryable` flag. Core reads the type first and falls back to matching error
  names only for untyped errors — a guess must never overrule a statement. A
  failure the adapter cannot attribute (`unknownCause: true`) holds the media
  **and** raises an infrastructure fault, because a provider that is down and a
  provider that is being careful otherwise look identical from the review
  queue.
- Every method takes an `AbortSignal`. When the caller's deadline expires, the
  decision is committed: a provider resolving `approved` afterwards is
  discarded, not applied.

See [Implementing a media-moderation
provider](../guides/implementing-a-media-moderation-provider.md) for the full
implementor's contract, and [Media moderation
configuration](../reference/media-moderation-config.md) for the operator knobs.

The Null provider returns `review` for every call and warns loudly. A startup
guard refuses to run it outside development: an un-moderated, fail-closed
backend in production would silently send all media to review with no path to
approval, so the wiring fails loudly instead.

## Boundary invariants

The pipeline separates two layers with different rules, and the separation is
enforced, not aspirational:

- **The decision core is dependency-free.** The lifecycle state machine, track
  fan-in, promotion decision, serve-gate predicate, and the provider/port
  interfaces import nothing but Node built-ins and each other — no Prisma, no
  cloud SDKs, no env, no worker or route code. This is enforced by an
  architectural test
  (`test/unit/media/decision-core-boundary.test.ts`); an import from outside
  that set fails the suite.
- **Enforcement is platform code.** The serve gate's wiring, CAS promotion,
  quarantine prefixes, quotas, the spend guard, and the processing/completion
  workers are integrated with storage, queues, and tenancy — deliberately.
  Fail-closed serving is a property of the platform, not of any provider.
- **New moderation intelligence goes behind the seams.** Any new
  classification capability — a provider integration, a shared detection
  service, a future standard protocol — enters as an implementation of the
  existing provider interfaces (or a new seam beside them), never inline in
  workers or handlers, and obeys the binding rules above: 3-value verdicts,
  fail-closed on any doubt.

Rule of thumb: **enforcement in the core, intelligence behind a port.**

## Where to look in the code

| Concern | Module |
|---------|--------|
| Lifecycle states + state machine | `apps/api/src/lib/media/media-lifecycle.ts` |
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
