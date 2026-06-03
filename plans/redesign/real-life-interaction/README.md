# Real-life-interaction primitives (trellis core)

**Date:** 2026-06-01
**Status:** Design exploration — not yet built. Sibling to
[`../entity-location-subsystem.md`](../entity-location-subsystem.md).
**Trigger:** Trellis defines "healthy social media" almost entirely
*negatively* — anti-addiction guardrails. This folder proposes the *positive*
half: generic primitives whose purpose is to **convert online connection into
offline connection**, argues they belong in trellis core, and — the part this
folder adds over the original single-file sketch — works out **what (if
anything) actually moves from skybber, and how**.

## The one-sentence summary

Promoting real-life interaction is a trellis-core decision for the same reason
the circles model was; but the surprising finding is that **the platform
boundary is already clean** — the generic engine lives in core, skybber is
thin, so the work is *building* two net-new primitives in core and *relocating
generic design docs*, not migrating code.

## Topic map

| File | What it covers |
|---|---|
| [`01-thesis.md`](01-thesis.md) | Why promoting IRL interaction is a trellis-core decision, not a vertical feature |
| [`02-current-state.md`](02-current-state.md) | Grounded inventory: what's already in core, what's placeholder, what's design-only, what's vertical — with file paths |
| [`03-primitives.md`](03-primitives.md) | The four primitives (gathering, presence, proximity, "met in person") + the wellbeing payoff |
| [`04-skybber-to-trellis.md`](04-skybber-to-trellis.md) | **What moves and how** — the four buckets (already-core / build-new / relocate-doc / stays-vertical), the npm-package mechanism, and an ordered checklist |
| [`05-open-questions-and-sizing.md`](05-open-questions-and-sizing.md) | Open questions, risks, and sizing |
| [`06-attention-ethics-grounding.md`](06-attention-ethics-grounding.md) | External academic grounding (Watzl/GoodAttention 2026): reframes "healthy" as *agency/cognitive liberty*, and the steer toward privacy-over-surveillance |

## How to read it

If you only read two files: [`02-current-state.md`](02-current-state.md) tells
you where things stand today (and corrects the intuition that the IRL
ingredients live in skybber — they mostly live in core already), and
[`04-skybber-to-trellis.md`](04-skybber-to-trellis.md) is the actionable
migration plan.
