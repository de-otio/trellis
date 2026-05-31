# Architecture Audit: Monetization Domain-Specificity Check

Every monetization model and component reviewed for domain-specific assumptions.

> **Scope**: This audit covers only the monetization models (Subscription, Wallet, Brand, ValueAction, etc.). For the full codebase coupling audit (Entity model, routes, handlers, ActivityPub), see [analysis/generic-core/01-current-state.md](../../../../../generic-core/01-current-state.md) through [06-gaps.md](../../../../../generic-core/06-gaps.md).

---

## Prisma Models

| Model | Domain-Agnostic? | Notes |
|---|---|---|
| `Subscription` | **Yes** | No vertical-specific fields. `source` (STRIPE, VALUE_EXCHANGE) is universal. |
| `Wallet` | **Yes** | Currency, balance, transactions — all generic. |
| `WalletTransaction` | **Yes** | Transaction types (EARNING, PAYOUT, etc.) work for any vertical. |
| `ValueAction` | **Yes** | `type` enum (PRODUCT_REVIEW, PEER_QA, etc.) uses generic terms. `content: Json` is flexible. |
| `Brand` | **Yes** | `category` is free-form String, not a pet-specific enum. `slug`, `name`, `description` are generic. |
| `BrandCampaign` | **Yes** | `actionTypes: Json` allows any configuration. |
| `BrandSubscription` | **Yes** | Tiers (STARTER, PROFESSIONAL, ENTERPRISE) are business-size tiers, not vertical tiers. |
| `AmbientAttribution` | **Yes** | `attributionType` is String, not a pet-specific enum. |

**Result**: All models pass. No domain-specific fields or assumptions.

---

## Enums

| Enum | Domain-Agnostic? | Risk |
|---|---|---|
| `ValueActionType` | **Yes** | PRODUCT_REVIEW, PEER_QA, FEEDBACK_SURVEY, ENDORSED_RECOMMENDATION, PRODUCT_PHOTO — all generic. |
| `BrandStatus` | **Yes** | PENDING, ACTIVE, PAUSED, SUSPENDED — universal lifecycle. |
| `CampaignStatus` | **Yes** | DRAFT, ACTIVE, PAUSED, COMPLETED, CANCELLED — universal. |
| `TransactionType` | **Yes** | EARNING, AMBIENT_EARNING, PAYOUT, PREMIUM_UNLOCK, DONATION — all generic. |
| `SubscriptionSource` | **Yes** | STRIPE, VALUE_EXCHANGE — payment method, not vertical. |
| `BrandSubscriptionTier` | **Yes** | STARTER, PROFESSIONAL, ENTERPRISE — business size. |

**Result**: All enums pass.

---

## API Routes

| Route Group | Domain-Agnostic? | Risk |
|---|---|---|
| `/api/subscriptions/*` | **Yes** | Standard subscription CRUD. |
| `/api/wallet/*` | **Yes** | Balance, transactions, payout — generic financial operations. |
| `/api/value-actions/*` | **Yes** | Action listing, completion, history — works for any product/service. |
| `/api/brands/*` | **Yes** | Brand directory, opt-in/opt-out — generic. |
| `/api/brand-tools/*` | **Yes** | Campaign management, analytics — generic B2B tools. |
| `/api/webhooks/stripe` | **Yes** | Payment processor webhook — not domain-specific. |

**Result**: All routes pass.

---

## Feature Toggles

| Toggle | Domain-Agnostic? | Risk |
|---|---|---|
| `monetization_enabled` | **Yes** | Master switch. |
| `requiresPremium` (on FeatureToggle) | **Yes** | Per-feature premium gating. |

**Result**: No domain-specific toggles needed. The existing toggle pattern is generic.

---

## Configuration

| Config | Domain-Agnostic? | Risk |
|---|---|---|
| StageConfig.monetization | **Yes** | `enabled`, `stripeLiveMode`, `payoutEnabled` — all generic. |
| SSM parameters | **Yes** | Stripe keys, price IDs — payment processor config, not vertical. |
| Brand.actionConfig (Json) | **Yes** | Per-brand configuration is flexible JSON — can hold any vertical's config. |

**Result**: All configuration is generic.

---

## Where Domain Assumptions COULD Leak

These are not current problems, but areas to watch during implementation:

### Quality Scoring Algorithm

If the quality scoring for value actions is trained on or calibrated against pet product reviews, it may not work for other verticals. A plant care review has different quality signals than a dog food review.

**Mitigation**: Quality scoring should evaluate generic signals (length, helpfulness votes, relevance to the question) rather than domain-specific content patterns. If domain-specific scoring is ever needed, it should come from the extension system.

### Brand Verification

If brand onboarding checks for "legitimate pet brand" signals (e.g., checking against a pet industry database), it won't work for other verticals.

**Mitigation**: Brand verification should check generic legitimacy signals (business registration, website, contact info) rather than industry-specific databases. Domain-specific verification can be added via extensions.

### Value Action Prompts and Templates

If the UI for completing value actions includes pet-specific prompts ("How does your dog like this food?"), it won't work for other verticals.

**Mitigation**: Action prompts should be configurable, not hardcoded. The extension system can provide domain-specific prompt templates. The default should be generic ("How was your experience with this product?").

### Ambient Attribution (Phase 4)

If the attribution engine is trained to recognize pet products in images, it's pet-specific by design.

**Mitigation**: This is inherently domain-specific — an image recognition model for pet products won't recognize garden tools. Phase 4 should be designed so the recognition model is pluggable (different model per vertical). This is a Phase 4 concern, not a launch concern.

---

## Audit Summary

| Category | Models Audited | Pass | Fail | Watch |
|---|---|---|---|---|
| Prisma models | 8 | 8 | 0 | 0 |
| Enums | 6 | 6 | 0 | 0 |
| API routes | 6 | 6 | 0 | 0 |
| Feature toggles | 2 | 2 | 0 | 0 |
| Configuration | 3 | 3 | 0 | 0 |
| Implementation areas | 4 | — | — | 4 |

**Conclusion**: The monetization architecture is fully domain-agnostic. Four implementation areas need attention during development to prevent domain assumptions from leaking in.
