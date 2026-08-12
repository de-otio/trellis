---
title: Media moderation configuration
description: Every operator-supplied knob the media-moderation pipeline reads, what absence means for each, and why none of them has a compiled-in default.
sidebar: Media moderation config
order: 16
---

# Media moderation configuration

Every operational parameter below is **supplied by the operator** and has **no
compiled-in default**. That is a deliberate constraint, not an oversight:
`@de-otio/trellis` is published to a public registry, so a threshold compiled
into it is a published threshold, and a published threshold is one an adversary
can tune against. See the threshold-secrecy rule in the project's `CLAUDE.md`.

Two consequences follow, and both are load-bearing:

1. **Absence fails closed.** A missing value never means "use a sensible
   default". It means the feature refuses to run, or the affected media lands
   in `review`. The tables below say which, per knob.
2. **Values are secret by policy.** Do not commit them, do not put them in a
   README, do not echo them in an error message. They belong in the same place
   as your other operational secrets.

## Verdict interpretation

| Key | Type | Absence |
|---|---|---|
| `MEDIA_THRESHOLDS_JSON` | JSON object: `{ "<category-token>": { "review": <0–1>, "quarantine": <0–1> } }` | Required in prod (boot fails). In dev, every category fail-closes to `review`. |

The category tokens are the opaque tokens your provider reports; they are not
human-readable category names and core never interprets them.

### Taxonomy pinning

Passed to `createLabelPolicy()` when the operator installs a label policy.

| Field | Values | Meaning |
|---|---|---|
| `pinMode` | `"response"` | The provider must report a `modelVersion` on every verdict, and for an async video job it must still match the version the job started under. |
| | `"config"` | The reported version must equal `expectedModelVersion`. |
| | `"none"` | No taxonomy pin. Requires `acceptUnpinnedTaxonomy: true` and raises a standing `unpinnedTaxonomy` flag on the ops surface. |
| `expectedModelVersion` | string | Required when `pinMode` is `"config"`; construction throws otherwise. |
| `acceptUnpinnedTaxonomy` | `true` | Required when `pinMode` is `"none"`. Running unpinned is a decision, not a default. |

Under a pinned mode, a verdict whose version is missing or different is
**unverifiable** and floors the result at `review`. It never lifts a
quarantine.

`createLabelPolicy` throws `LabelPolicyConfigError` rather than constructing a
policy nobody configured. An *empty* category map is permitted and is not the
same as a missing one — it is a coherent policy meaning "every category the
provider can report is unmapped, therefore quarantine".

## Frame sampling (video via an image-only classifier)

Passed to `FrameSamplingVideoModerationAdapter`.

| Key | Type | Absence |
|---|---|---|
| `framesPerSecond` | number > 0 | The adapter refuses to sample; the visual track is `review`. |
| `maxFramesPerJob` | integer ≥ 1 | Same. An absolute per-job ceiling, independent of rate × duration. |
| `maxDurationSeconds` | number > 0 | Same. Passed through to the extractor so one clip cannot run it unbounded. |
| `policyVersion` | string | Optional. When absent, a digest of the effective parameters is recorded so the audit trail is never empty. That digest tells two policies APART; it does **not** conceal them (a small preimage space is trivially exhausted), so treat `policyVersion` as server-side-only either way. |
| `policy` | `LabelPolicy` | Optional. Applies the operator's label policy to every sampled frame, so the video path is governed by the same rules as the image path. |
| `frameConcurrency` | integer ≥ 1 | Optional; defaults to a conservative value. A *resource* bound (wall-clock vs. provider rate limits), not a moderation parameter, which is why it may have a default at all. |

`maxFramesPerJob` is a cost and disk bound as much as a sampling one: without
it, a long clip at a high rate turns one upload into an unbounded number of
paid classifier calls and an unbounded number of temp files.

An unknown, zero, or non-finite duration is a **refusal**, not a plan
(`duration-unknown`). Treating it as "expect one frame" would switch off both
the shortfall rule and the ceiling rule at once — any single decoded frame
would satisfy the expectation — so a probe that returns `0` on failure must not
be able to disable the law by failing.

When `framesPerSecond × duration` exceeds `maxFramesPerJob`, the job **fails
closed to `review`** rather than silently sampling fewer frames. Quietly
under-sampling would scan a long video at an effective rate nobody chose, and
afterwards would be indistinguishable from a decode failure.

## Deadlines

Passed to `withModerationDeadline`.

| Key | Type | Absence |
|---|---|---|
| `timeoutMs` | number > 0 | `ModerationDeadlineConfigError` at wiring time — the wrapper refuses to construct. |

A wiring-time throw rather than a per-call `review`, deliberately: an
unconfigured deadline is a deployment mistake, and it should be visible at boot
rather than as a slow drip of review items nobody attributes to it.

The timeout is threshold-secrecy material in its own right: it tells an
adversary exactly how long a call must be stalled for to force every upload
into review.

## Observability

Passed to `ModerationMetrics`.

| Key | Type | Notes |
|---|---|---|
| `declaredProviders` | string[] | The provider names permitted as metric dimensions. Anything else is recorded under `unknown` rather than becoming a new dimension. |
| `windowMs` | number > 0 | Counter bucket width. Coarser means a smaller correlation window. |
| `now` | `() => number` | Injected clock — no ambient time. |

Snapshots report **closed** windows only; the window currently accumulating is
withheld. That omission is the anti-oracle control, not a rounding detail: a
probe uploaded now must not be readable back now.

The unauthenticated health payload carries exactly one moderation fact:
`moderationProviderActive: boolean`. Verdict counters belong on an
authenticated operations surface.

## Bytes access

Passed to `createMediaBytesAccess`.

| Key | Type | Absence |
|---|---|---|
| `maxBytes` | number > 0 | `MediaBytesAccessConfigError` — refuses to read unbounded. |

## Startup

| Key | Values | Effect |
|---|---|---|
| `STAGE` | `dev`, `test`, `local` | The only stages where boot tolerates the fail-closed Null moderation provider. Anything else — **including an unset `STAGE`** — refuses to serve without a real provider. An absent stage is guarded rather than waved through: forgetting it is exactly the deployment mistake the check exists for. |
| `MEDIA_MODERATION_ALLOW_NULL` | `"true"` | Permits the Null provider anyway, with a loud warning. Every upload will land in review with no path to approval. |

## What is deliberately not configurable

Some bounds are in code, and the distinction is worth stating because it looks
inconsistent from outside:

- The **256 KiB completion-body cap** and the **256-character provider-id cap**
  are robustness bounds. They cap the work a hostile message can cause and say
  nothing about moderation policy, so they belong in code where they cannot be
  misconfigured.
- The **sampling rate, frame ceiling, confidence bars, and call timeout** are
  moderation policy. Knowing them helps an adversary evade or exhaust the
  pipeline, so they are operator-supplied and secret.

The test is not "is it a number" but "does knowing it help someone get
something past the pipeline".
