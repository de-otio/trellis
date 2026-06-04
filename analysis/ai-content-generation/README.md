# AI Content-Generation Primitives — Analysis

**Date:** April 2026
**Status:** Exploratory analysis (not a planning doc)

---

## What this is

Trellis-core design for the generic primitives a consuming application needs
when it offers **AI-assisted content suggestions** — the canonical example
being "suggest a caption for this image or video, let the user pick and edit
one, and post it." The primitives here are domain-agnostic: they take media
plus a caller-supplied style guide and optional structured context, and return
ranked suggestions, with the infrastructure to keep the result from degrading
feed quality.

The consuming application supplies the taste (its own style guide, its own
domain context enrichment, its own UX and rollout). Trellis supplies the
mechanism: a multimodal suggestion primitive, slop-detection / edit-distance
tracking, and a two-pass moderation-and-safety pipeline.

This is the generic counterpart to a consuming application's product-side
feature analysis. It was extracted from a downstream application's
"AI-assisted caption" exploration; the application-specific framing (style
guide content, domain enrichment, client UX, cost/rollout) stays in that
application.

## Documents

| # | Document | Focus |
|---|----------|-------|
| 1 | [Caption-Generation Primitive](01-caption-generation-primitive.md) | Model-location decision (cloud vs. on-device), vendor/video tradeoffs, prompt-context layering, structured output, retention, failure modes |
| 2 | [Slop Detection and Edit-Distance Tracking](02-slop-detection-and-edit-distance.md) | Edit-distance metric, AI-assist disclosure flags, rate limiting, perceptual-hash dedupe, anti-homogenisation, feed-down-ranking signal |
| 3 | [Moderation Pipeline and Safety Classifier](03-moderation-and-safety-pipeline.md) | Input pre-screen, second-pass safety classifier, anti-prompt-injection, logging/review, moderator surfacing, residual-risk acceptance, kill switch |

## Relationship to on-device AI

The [on-device-ai](../on-device-ai/README.md) analysis covers the *retrieval*
and *privacy-preserving* half of the AI story (embeddings, RAG, device
capability gating). The caption-generation primitive here deliberately lands
on the **cloud / server-side** for generation quality — see
[01 §2](01-caption-generation-primitive.md) for the reasoning. The two
analyses are complementary: on-device for privacy-sensitive retrieval and
classification, cloud for humour-grade multimodal generation. The past-style
conditioning idea in [01 §5](01-caption-generation-primitive.md) can reuse the
on-device embeddings work described in
[on-device-ai/03-rag-architecture.md](../on-device-ai/03-rag-architecture.md).

---

**Last Updated:** April 2026
