---
title: Implementing a media-moderation provider
description: How to bind a classification backend to the Trellis media-moderation seam — verdicts, taxonomy pins, video without a video API, errors, deadlines, and reading bytes without credentials.
sidebar: Media moderation provider
order: 11
---

# Implementing a media-moderation provider

Trellis ships no classifier. It ships a seam, a fail-closed default that
approves nothing, and the machinery around a verdict: version-pinned bytes, a
lifecycle state machine, dual-track fan-in, and a serve gate that only opens on
approval. Your job as an implementor is narrow — look at some media, return one
of three words — and this guide is about doing that narrow job correctly.

Read [Media Moderation](../concepts/media-moderation.md) first for the
lifecycle and the fan-in rules. This page is the implementor's contract.

## The interface

```ts
import type {
  MediaModerationProvider,
  ImageRef,
  S3Ref,
  ModerationCallOptions,
  ModerationVerdict,
  VideoModerationStart,
} from "@de-otio/trellis";

class MyProvider implements MediaModerationProvider {
  async moderateImage(
    input: ImageRef,
    options?: ModerationCallOptions,
  ): Promise<ModerationVerdict> { /* … */ }

  async startVideoModeration(
    input: S3Ref,
    options?: ModerationCallOptions,
  ): Promise<VideoModerationStart> { /* … */ }

  async getVideoModeration(
    jobId: string,
    options?: ModerationCallOptions,
  ): Promise<ModerationVerdict> { /* … */ }
}
```

Register it once, before the server serves:

```ts
import { setMediaModerationProvider } from "@de-otio/trellis";

setMediaModerationProvider(new MyProvider());
```

## Verdict semantics

A verdict is three-valued and nothing else:

| `decision` | Meaning |
|---|---|
| `approved` | You looked, and you are positively saying this is fine. |
| `review` | You are not sure. Everything uncertain lands here. |
| `quarantine` | You are flagging it. |

`rejected` is **not** a verdict. It is a lifecycle state reached only by a human
moderator or by the statutory CSAM path, and a provider can never produce it.

The one rule that matters more than the rest: **never manufacture `approved`
from doubt.** A timeout, an empty response, a quota exhaustion, a partial
result, an unparseable payload — all of them are `review`. Core is built so
that returning `review` is always safe and never loses data: the object waits
for a human. Returning `approved` when you did not actually look is the only
irreversible mistake available to you.

`labels` carry **opaque category tokens** and confidences. Core never
interprets a token; the operator maps tokens to actions (see
[Label policy](#label-policy-let-the-operator-decide) below). Do not put
human-readable category names in a token if you would not want them in a public
API response — treat the token as an identifier, not a description.

## Report your model version

```ts
return {
  decision: "approved",
  labels: [],
  provider: "my-provider",
  modelVersion: "taxonomy-2026-08-a",   // ← this
};
```

`modelVersion` is an opaque string you choose. Core never parses it; it only
compares it to what the operator pinned.

This matters because a category map is only meaningful against the taxonomy it
was written for. If you reship your model under the same category names, an
operator's map keeps *working* while quietly meaning something else. Reporting
a version lets that be detected instead of assumed.

The field is optional so existing adapters keep compiling, and the consequence
is not hidden: under a pinned policy, a verdict with no `modelVersion` is
**unverifiable and therefore `review`**. A provider that reports nothing gets
no approvals.

## Video without a video API

Most classifiers score still images and have no video job model at all. You do
not have to build one.

Implement `moderateImage` and let core's frame-sampling adapter provide the
video half:

```ts
import {
  FrameSamplingVideoModerationAdapter,
  setMediaModerationProvider,
} from "@de-otio/trellis";
import { randomUUID } from "node:crypto";

setMediaModerationProvider(
  new FrameSamplingVideoModerationAdapter({
    images: new MyImageOnlyProvider(),
    transcode: myTranscodePort,        // must implement sampleFrames + deleteFrame
    config: {
      framesPerSecond: Number(process.env.MEDIA_SAMPLE_FPS),
      maxFramesPerJob: Number(process.env.MEDIA_MAX_FRAMES_PER_JOB),
      maxDurationSeconds: Number(process.env.MEDIA_MAX_DURATION_SECONDS),
      policyVersion: process.env.MEDIA_SAMPLING_POLICY_VERSION,
    },
    frameDirFor: (jobId) => `processing/frames/${jobId}`,
    newJobId: () => randomUUID(),
  }),
);
```

What the adapter does, and what you should know about it:

- It samples frames at the operator's rate, classifies each through
  `moderateImage`, and aggregates. **Quarantine dominates; otherwise the worst
  frame wins; `approved` requires every expected frame to have approved.**
- If fewer frames decode than the policy expected, the result is `review` even
  when every decoded frame approved. A clip whose harmful frames fail to decode
  must not be approved on its benign ones.
- It resolves **inline**: `startVideoModeration` does the whole job and returns
  the decision in `initialDecision`. There is no remote job, so no completion
  notification will arrive, and core settles the object itself. Sampling time
  is spent inside the processing worker's budget, bounded by `maxFramesPerJob`.
- It deletes every extracted frame on every path — success, error, deadline,
  ceiling breach.
- Frames are extracted with the container metadata dictionary stripped, so a
  sampled still cannot resurrect location tags the transcode removed.

Your `TranscodePort` needs two optional methods for this: `sampleFrames` and
`deleteFrame`. Both are optional on the interface (adding required methods to a
published seam would break every existing adapter) — and if `sampleFrames` is
missing, frame-sampled moderation **refuses to run and fails the visual track
to `review`**. It never degrades to "moderate nothing and approve".

## Signalling completion for a real video job

If your backend *does* have an async video job, publish this when it finishes:

```json
{ "track": "VISUAL", "jobId": "<the id you returned from startVideoModeration>" }
```

for the visual track, or `{ "track": "AUDIO", "jobId": "…" }` for a
transcription. `completionEnvelopeBody()` is exported if you would rather build
it than hand-write it.

Two things to know:

- The body is treated as an **untrusted pointer**. Core ignores any verdict you
  put in it and re-fetches authoritative state through `getVideoModeration`.
  Do not bother sending a decision; it will not be read.
- `track` is a **hint**, checked against the job row. A message whose claimed
  track disagrees with the row is dropped without side effects.

Bodies over 256 KiB are refused before parsing, and job ids are
control-character stripped and length-capped before they reach a log line.

## The error contract

Throw `ModerationProviderError` and say what kind of failure it was:

```ts
import { ModerationProviderError } from "@de-otio/trellis";

// The same call could succeed later: throttle, 5xx, socket.
throw new ModerationProviderError("upstream throttled", { retryable: true });

// Permanent for these bytes: rejected input, unsupported media.
throw new ModerationProviderError("unsupported media", { retryable: false });

// You genuinely cannot tell.
throw new ModerationProviderError("unexpected failure", {
  retryable: false,
  unknownCause: true,
});
```

Core reads your type first and only falls back to matching on error names when
an error carries no type — a guess must never overrule a statement.

The third form matters more than it looks. `unknownCause: true` holds the media
**and** raises an infrastructure fault, because fail-closed has a blind spot: a
provider that is down and a provider that is being careful both produce review
items, so an outage otherwise looks like a busy moderation week. If you cannot
attribute a failure, say so, and an operator finds out.

## Deadlines and abort

Every seam method takes `options.signal`. Honour it: when it aborts, stop
waiting, close the connection, stop spending quota.

An operator wraps your provider with a deadline:

```ts
import { withModerationDeadline } from "@de-otio/trellis";

setMediaModerationProvider(
  withModerationDeadline(new MyProvider(), {
    timeoutMs: Number(process.env.MEDIA_MODERATION_TIMEOUT_MS),
  }),
);
```

The deadline binds the **decision**, not merely the wait. When it expires, core
commits a fail-closed outcome, and if your call resolves `approved` a second
later that resolution is discarded. Do not design around a late answer being
used; it will not be. There is no default timeout — an unconfigured wrapper
refuses to construct.

Check `signal.aborted` at the start of your call as well as listening for the
event: a signal that was already aborted fires no event.

## Reading bytes without credentials

If your classifier takes an image in the request body rather than a storage
reference, you do not need storage credentials of your own:

```ts
import { createMediaBytesAccess } from "@de-otio/trellis";

const bytes = createMediaBytesAccess(myStoragePort, { maxBytes: 8 * 1024 * 1024 });

class MyProvider implements MediaModerationProvider {
  async moderateImage(input: ImageRef) {
    const buffer = await bytes.read({ key: input.key, pin: input.pin });
    // …POST it to your classifier…
  }
}
```

The read is capped (a ranged read, so an oversized object is detected from what
came back rather than from a self-reported length) and pinned to the recorded
version when the ref carries a pin. Over the cap throws
`MediaBytesTooLargeError`; `access.maxBytes` lets you refuse earlier.

## Pins: moderate the bytes you were pointed at

Refs may carry a `pin` — a `versionId`, an `etag`, or a `contentHash`. When one
is present, scan **that exact version**. A later overwrite of the same key must
not be able to change what a started job actually looked at.

Treat a pin as opaque: compare it, never recompute it. An ETag is not a content
digest on every store — a multipart upload's ETag is a digest of digests — so
"verifying" a pin by hashing bytes will disagree with itself.

`S3Ref.versionId` still works as a deprecated alias for
`pin: { kind: "versionId", value }`.

## Label policy: let the operator decide

By default your `decision` stands. An operator may instead install a policy
that derives the decision from your labels:

```ts
import { createLabelPolicy, setMediaLabelPolicy } from "@de-otio/trellis";

setMediaLabelPolicy(
  createLabelPolicy({
    categories: JSON.parse(process.env.MEDIA_THRESHOLDS_JSON!),
    pinMode: "config",
    expectedModelVersion: process.env.MEDIA_TAXONOMY_VERSION,
  }),
);
```

This shifts authorship of the policy from you to them, which is the point: the
operator can audit and change it without asking you. It can only ever *degrade*
a verdict — an unmapped category quarantines, an unverifiable taxonomy floors
at `review` — so enabling it cannot make anything more permissive than you
already were.

What that means for you: **report every category you detected**, including ones
you scored low. A category the operator has not mapped is treated as
quarantine-worthy, so silence is not the safe choice you might expect it to be.

## What core does with your verdict

Briefly, so the shape of the contract makes sense:

- Verdicts from both tracks are combined; approval needs positive evidence on
  both.
- Only on approval are the moderated bytes copied to the served prefix — pinned
  to the version that was scanned, never "the current bytes".
- Non-approved objects wait for a human on the review queue. A human approval
  performs the same pinned promotion and refuses if that version can no longer
  be resolved.
- Your labels, confidences, per-frame timings, and sampling parameters are
  recorded server-side for audit and **never** served to a client: together
  they are a tuning oracle.

## Checklist

- [ ] Every uncertainty returns `review`; nothing returns `approved` from doubt.
- [ ] `modelVersion` reported on every verdict.
- [ ] Every detected category reported as a label, low scores included.
- [ ] `options.signal` honoured, including when already aborted on entry.
- [ ] Failures thrown as `ModerationProviderError` with an honest `retryable`,
      and `unknownCause: true` when you cannot attribute the cause.
- [ ] Pins scanned exactly, compared and never recomputed.
- [ ] Image-only? Wrap in `FrameSamplingVideoModerationAdapter` rather than
      approximating a video job.
- [ ] No operational thresholds compiled into your adapter — the operator
      supplies them.
