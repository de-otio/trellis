# Vertical Portability

How the monetization system would work in non-pet verticals — demonstrating that the architecture is genuinely reusable.

> **Context**: The extension system that enables vertical portability is designed in [analysis/generic-core/07-extension-architecture.md](../../../../../generic-core/07-extension-architecture.md). This document focuses on whether the **monetization layer** is portable, not the core social features (which are already validated as generic).

---

## The Test

If the monetization models, API routes, and revenue model structure work for three very different verticals without code changes, the architecture is portable. If any vertical requires model changes, there's a domain leak.

---

## Vertical 1: Plant Community ("GreenThumb")

A social platform for plant enthusiasts in the DACH region.

### Market Context

| Metric | Value |
|---|---|
| German indoor plant market | ~EUR 4B (Statista, houseplants + garden) |
| Plant owners in Germany | ~35M households have plants |
| Plant content engagement | High on Instagram/TikTok (#plantparent, #planttok) |

### How Each Revenue Stream Works

**Stream 1: Premium Subscription ($6.99/month)**
- Free: Basic plant profiles, social feed, community
- Premium: Advanced plant care tracking, pest identification, seasonal reminders, growth analytics
- Same `Subscription` model, same `FeatureToggle.requiresPremium` gating

**Stream 2: Brand Value-Exchange**
- Brands: Dehner, OBI garden, Compo, Substral, local nurseries
- Value actions: Fertilizer reviews, plant pot Q&A, soil feedback surveys, nursery recommendations
- Same `Brand`, `ValueAction` models — `Brand.category = "garden-supplies"` instead of `"pet-food"`

**Stream 3: Ambient Attribution**
- User posts photo of thriving monstera in a specific pot → ambient attribution to pot brand
- Same `AmbientAttribution` model — different image recognition model (plants vs. dogs)

**Stream 4: B2B Brand Tools**
- Garden centers use campaign tools to reach plant enthusiasts
- Same `BrandCampaign`, `BrandSubscription` models

**Code changes required**: Zero. Extension provides plant-specific metadata schemas, care tracking features, and taxonomy seeds. Monetization layer is untouched.

---

## Vertical 2: Local Running Community ("RunLocal")

A social platform for recreational runners in a specific city/region.

### Market Context

| Metric | Value |
|---|---|
| Recreational runners in Germany | ~20M (DOSB) |
| Running gear market (Germany) | ~EUR 1.5B |
| Running event market | ~EUR 500M |

### How Each Revenue Stream Works

**Stream 1: Premium Subscription ($6.99/month)**
- Free: Basic run logging, social feed, group runs
- Premium: Advanced training plans, pace analytics, race predictions, route planning
- Same `Subscription` model

**Stream 2: Brand Value-Exchange**
- Brands: Asics, Brooks, local running stores, race organizers, sports nutrition (PowerBar, SiS)
- Value actions: Shoe reviews, race Q&A, nutrition feedback surveys, store recommendations
- Same models — `ValueActionType.PRODUCT_REVIEW` covers shoes exactly as it covers dog food

**Stream 3: Ambient Attribution**
- User posts finish-line photo wearing identifiable shoes → ambient attribution to shoe brand
- User logs a run past a local running store → check-in attribution
- Same `AmbientAttribution` model

**Stream 4: B2B Brand Tools**
- Running stores and race organizers use campaign tools
- Same models

**Code changes required**: Zero. Extension provides run-tracking features, race integration, route maps. Monetization is untouched.

---

## Vertical 3: Vintage Car Enthusiasts ("ClassicDrive")

A social platform for vintage/classic car owners.

### Market Context

| Metric | Value |
|---|---|
| Classic cars registered in Germany | ~650,000 (KBA H-Kennzeichen) |
| Classic car parts/services market | ~EUR 5-8B (estimated) |
| High-value, passionate, brand-loyal demographic | Premium pricing opportunity |

### How Each Revenue Stream Works

**Stream 1: Premium Subscription ($9.99/month — higher price justified)**
- Free: Car profiles, social feed, meetup discovery
- Premium: Maintenance tracking, parts sourcing, valuation estimates, insurance comparisons
- Same `Subscription` model — different Stripe price ID

**Stream 2: Brand Value-Exchange**
- Brands: Parts suppliers (Hella, Bosch Classic), specialty oils (Liqui Moly), restoration services, classic car insurance
- Value actions: Parts reviews, restoration Q&A, service feedback, supplier recommendations
- Same models — `Brand.category = "classic-car-parts"`
- **Higher per-action rates**: Classic car brand budgets are larger; parts are expensive. $5-15/review is plausible.

**Stream 3: Ambient Attribution**
- User posts photo of restored engine with visible Bosch parts → ambient attribution
- Same model

**Stream 4: B2B Brand Tools**
- Parts suppliers and restoration shops use campaign tools
- Same models — higher `BrandSubscriptionTier` pricing justified by niche value

**Code changes required**: Zero. Extension provides car-specific profiles (make, model, year, engine), maintenance logging, parts catalog integration. Monetization is untouched.

---

## What Differs Across Verticals

| Aspect | Pets | Plants | Running | Classic Cars |
|---|---|---|---|---|
| Entity type | Dog | Plant | Runner/Route | Car |
| Brand categories | Pet food, accessories, health | Garden supplies, pots, fertilizer | Shoes, nutrition, events | Parts, oils, services |
| Avg brand payment/action | $2-5 | $1.50-4 | $2-6 | $5-15 |
| Premium price point | $6.99 | $6.99 | $6.99 | $9.99 |
| Content type | Pet photos, health updates | Growth photos, care tips | Run logs, race reports | Restoration photos, meetups |
| Ambient attribution signals | Product in pet photo | Pot/soil in plant photo | Shoes in run photo | Parts in car photo |

**Everything that differs is configuration or extension content, not code.** The revenue model structure, Prisma models, API routes, and feature gating are identical.

---

## The One Exception: Phase 4 Attribution Engine

The ambient attribution engine (image recognition) IS inherently domain-specific. A model trained to recognize dog food bags cannot recognize vintage car parts.

### How to Keep It Portable

The attribution engine should be designed with a pluggable recognition model:

```
Attribution Pipeline:
  Post → Content Analyzer → Brand Matcher → Value Calculator → Wallet Credit

Content Analyzer:
  - Text analyzer: generic (keyword/NER-based brand mention detection)
  - Image analyzer: pluggable per vertical (different ML model per domain)
```

The text analyzer is already generic — brand name detection in text works the same regardless of vertical. The image analyzer needs a per-vertical model, provided by the extension system.

This is a Phase 4 concern. At launch (Phases 0-3), there is no image analysis and no portability issue.

---

## Conclusion

The monetization architecture is fully portable across verticals. Every non-pet vertical tested works with zero code changes. The only domain-specific component is the Phase 4 image recognition model, which should be pluggable by design.

The financial projections (TAM, brand economics, comparable companies) are pet-specific and cannot be reused — each vertical needs its own market analysis. But the revenue model structure (4 streams, unit economics formulas, sensitivity analysis methodology) transfers directly.
