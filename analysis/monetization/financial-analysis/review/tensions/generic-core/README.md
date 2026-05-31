# Tension 4: Generic Core vs. Vertical Monetization

**Risk level**: Low — the architecture is correct, but awareness is needed to keep it that way.

Trellis's long-term goal is a reusable social-network core deployable for any vertical community. The monetization analysis is framed entirely around the pet industry. These must coexist without the pet-specific market strategy leaking into the generic codebase.

> **Related**: The technical generic-core analysis lives in [analysis/generic-core/](../../../../../generic-core/). That analysis covers code architecture (coupling, extension system, migration phases, ActivityPub). This directory focuses specifically on **monetization portability** — whether domain assumptions leak into financial models, pricing, and brand economics. The two are complementary, not overlapping.

---

## Documents

| Document | Description |
|---|---|
| [01-architecture-audit.md](01-architecture-audit.md) | Audit of every monetization model and component for domain-specificity |
| [02-vertical-portability.md](02-vertical-portability.md) | How the monetization system would work in non-pet verticals — with examples |
| [03-hardcoding-risks.md](03-hardcoding-risks.md) | Specific ways domain assumptions could leak into code, and how to prevent it |
| [04-investor-narrative.md](04-investor-narrative.md) | Framing the generic core as a strength for investors, not a distraction |

---

## Current Status

The implementation models are already entity-agnostic — `Brand`, `ValueAction`, `Wallet`, `Subscription` have no dog-specific fields. The extension system supports domain-specific behavior if needed. The risk is low but requires discipline during implementation.
