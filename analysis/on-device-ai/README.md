# On-Device AI Analysis

**Date:** April 2026
**Context:** Expanding on Option A (On-Device Small Model) from the [Border Safety Mode AI Strategy](../../doc/01-business/features/b2c-features/border-safety-mode/AI_STRATEGY.md). Investigating broader applications of on-device AI for Trellis, platform capabilities, and RAG architectures.

---

## Documents

| # | Document | Focus |
|---|----------|-------|
| 1 | [Platform Landscape](01-platform-landscape.md) | What Apple, Google, and cross-platform tools provide for on-device AI in Flutter apps |
| 2 | [Use Cases](02-use-cases.md) | On-device AI applications across Trellis beyond border safety mode |
| 3 | [RAG Architecture](03-rag-architecture.md) | Technical design: embedding models, vector stores, feasibility constraints |
| 4 | [RAG Use Cases](04-rag-use-cases.md) | Specific RAG-powered features for Trellis with interaction patterns |
| 5 | [Hybrid Architecture](05-hybrid-architecture.md) | On-device vs. server vs. tiered patterns, device capability gating |
| 6 | [Open Questions](06-open-questions.md) | Key decisions, unknowns, and next steps |

---

## Summary

On-device AI is feasible for Trellis's use cases. The corpus is small (user posts + policy documents = under 5K chunks), modern phones have sufficient hardware, and both Apple and Google provide relevant APIs -- though with different levels of openness.

The recommended architecture is **hybrid**: on-device retrieval (privacy-preserving) with server-side generation (quality), falling back to fully on-device for high-risk scenarios where any server contact is unacceptable.

On-device AI enables features beyond border safety -- semantic search, content warnings, moderation pre-filtering, notification triage, and writing style analysis -- all with a strong privacy story.

---

**Last Updated:** April 2026
