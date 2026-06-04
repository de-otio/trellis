# Caption-Generation Primitive

**Date:** April 2026
**Status:** Exploratory analysis

---

A generic, domain-agnostic primitive: given media (image or short video) plus
a caller-supplied style guide and optional structured context, return N caption
suggestions, each tagged with a tone. Nothing in the primitive is tied to a
particular content domain — the consuming application supplies the style guide
and any domain enrichment.

## 1. The core decision

There are four axes to pick on:

| Axis | Options |
|------|---------|
| Model location | Cloud (managed inference: Bedrock / OpenAI / Google) vs. on-device |
| Media input | Direct video input vs. frame-sampling vs. image-only |
| Model vendor | AWS Bedrock (Claude, Nova) vs. OpenAI GPT-4o vs. Google Gemini |
| Prompting strategy | Zero-shot with style guide vs. few-shot with curated examples vs. fine-tune |

Recommended starting point, with reasoning below: **a frontier multimodal model
(e.g. Bedrock Claude Sonnet 4.5), frame-sampling for video, zero-shot with a
strong caller-supplied style guide, with a path to a curated few-shot library
once taste-graded examples exist**.

## 2. Model location: cloud vs. on-device

### On-device

The [on-device AI analysis](../on-device-ai/README.md) concluded there are real
uses for on-device AI (privacy-sensitive retrieval, content warnings,
classification). Humour-grade caption generation does **not** clearly qualify:

- **Multimodal on-device models are markedly weaker at humour and prose** than
  frontier cloud models. Good caption writing requires world knowledge,
  cultural reference, and prose craft — exactly the strengths of large frontier
  models.
- **Video on-device is still limited.** Apple's Foundation Models framework and
  Gemini Nano are moving toward video but, as of April 2026, practical video
  understanding at humour-capable quality still requires a cloud model.
- **The privacy argument is weaker here.** On-device processing matters when the
  alternative is leaking sensitive data the user never intended to publish.
  Caption generation operates on content the user is **about to publish** —
  server-side processing is not meaningfully less private than posting. (The
  media still should not be retained after inference, but that is a
  data-lifecycle concern, not an architecture one — see §7.)

**Decision:** Cloud only, at least for v1. Revisit if on-device video
multimodal becomes competitive.

### Cloud vendor

The choice is the consuming application's, constrained by its existing infra.
A managed inference service (e.g. Bedrock) is the natural default for an
AWS-hosted application. Indicative tradeoffs as of April 2026:

| Model | Image | Video | Cost (approx) | Prose / voice control |
|-------|-------|-------|---------------|-----------------------|
| Claude Sonnet 4.5 (Bedrock) | ✓ | via frames | ~$3/Mtok in, $15/Mtok out | Excellent prose, strong voice control |
| Claude Haiku 4.5 (Bedrock) | ✓ | via frames | ~$1/Mtok in, $5/Mtok out | Good enough for light humour, ~4× cheaper |
| Nova Pro (Bedrock) | ✓ | ✓ direct video | AWS-competitive | Decent, weaker prose than Claude |
| GPT-4o (OpenAI) | ✓ | ✓ direct video | ~$5/Mtok in, $20/Mtok out | Strong, slightly more "safe" tone |
| Gemini 2.x (Vertex) | ✓ | ✓ direct video | Competitive | Good at video understanding |

**Recommendation:** Start with a high-quality model (e.g. Claude Sonnet 4.5)
for the first suggestion set, with a cheaper fallback (e.g. Haiku) for
cost-sensitive regenerations — the second and third "give me more" clicks use
the cheaper model. A direct-video model (e.g. Nova Pro) is a strong candidate
specifically if direct video input is wanted without frame sampling — worth a
spike but not the first choice.

## 3. Video handling

Two paths:

### 3a. Frame sampling (recommended for v1)

1. On upload, sample 4–8 frames evenly across the clip (cap clip length at e.g.
   30 seconds for caption eligibility).
2. Optional: transcribe audio if present (whisper-style, cheap).
3. Pass frames + transcript to an image-capable model with a prompt like:
   *"These frames are in chronological order from a short video. Audio
   transcript: {...}. Write captions for the post."*

**Why this first:**
- Works with any image-capable multimodal model.
- Lets the caller tune frame count per cost/quality tradeoff.
- Simpler to cache — frame hashes dedupe retries.
- Avoids the awkward "large video upload to a non-co-located API" path.

### 3b. Direct video input

Nova Pro, GPT-4o, and Gemini all accept video directly. Better for motion-heavy
clips where intermediate frames carry the joke.

**Plan:** Ship 3a first. If users upload motion-heavy clips and the captions
fall flat, spike 3b with a direct-video model as a comparison.

## 4. Prompt / context strategy

The model gets three layers of context:

1. **Caller-supplied style guide (system prompt).** An opinionated guide
   (~500 words) owned by the consuming application. This is the application's
   main IP and the thing that makes the output better than a generic caption
   bot. Version it.
2. **Structured domain context (optional).** Caller-supplied structured signals
   about the subject, pulled from the application's own data model. Optional —
   the primitive works without it, just better with it.
3. **Media.** The image or frames + transcript.

The output shape should be structured JSON with a tone tag per caption, so the
consuming UI can render a tag chip:

```json
[
  { "tone": "absurd-internal-monologue", "caption": "..." },
  { "tone": "self-deprecating", "caption": "..." },
  { "tone": "wholesome", "caption": "..." }
]
```

Frontier models with structured-output / tool-use mode are reliable at this.

## 5. Retrieval / past-style conditioning

A v2 enhancement worth noting now so it is not designed out:

- After a user has used the feature a handful of times, there is a small corpus
  of **which suggestions they picked** and **how they edited them**. That is a
  voice signal.
- Feed their last 3–5 chosen captions into the prompt as few-shot examples:
  *"This user tends to pick captions like: [...]"*.
- On-device embeddings (see
  [on-device-ai/03-rag-architecture.md](../on-device-ai/03-rag-architecture.md))
  could retrieve semantically similar past picks, but for a 3-example few-shot
  the most-recent-N approach is fine.

This is where the feature goes from "generic caption bot" to "captions that
sound like me" — a real retention hook, though see
[02 §3](02-slop-detection-and-edit-distance.md) on whether a caption feature
should have retention hooks at all.

## 6. Where the responsibility sits

The split between core and consuming application:

- **Trellis core** owns the generic "multimodal caption suggestion" primitive.
  It takes media + style guide + optional structured context and returns N
  caption suggestions. Nothing in it is domain-specific.
- **The consuming application** owns its own style guide, its domain-context
  enrichment step, and the compose-flow UI.

The primitive is reusable across consuming applications; each application
supplies the taste.

## 7. Storage and retention

- **Media sent to the model is not retained** after inference. Verify the
  inference provider's default retention policy per-model and document it.
- **Generated suggestions** are kept briefly (e.g. 24 hours, via a TTL store
  such as DynamoDB) to support "give me more" without re-inferencing rejected
  options. After the TTL or when the post publishes, they are purged except for
  the chosen caption (which is now just post content).
- **Edit distance between suggestion and posted text** is persisted on the post
  row for slop-detection analytics (see
  [02](02-slop-detection-and-edit-distance.md)). The original AI-generated text
  is NOT kept — only the edit-distance number and the `ai_assisted=true` flag.

## 8. Failure modes

| Failure | Handling |
|---------|----------|
| Model times out / 5xx | Return a friendly "couldn't think of anything — try again?" and do not charge a rate-limit slot |
| Model returns unsafe content (passes provider guardrails but still off) | Post-filter against the style guide (see [03](03-moderation-and-safety-pipeline.md)) |
| Model returns low-quality captions | Ship with a quality filter that rejects captions below a minimum character count, with a banned-opener list, etc. |
| Cost spike | Per-user rate limit + global circuit breaker on inference spend; fall back to the cheaper model then to "feature unavailable" |
| Media too large | Frame-sample and downscale client-side before upload |
