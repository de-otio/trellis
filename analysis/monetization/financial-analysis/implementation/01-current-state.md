# Current State

## What Exists and Can Be Leveraged

| Existing | Relevance to Monetization |
|---|---|
| `UserRole` enum (6 roles incl. `B2B_PARTNER`, `CONTENT_CREATOR`) | Brand partners and creators already have role distinctions |
| `FeatureToggle` model + `FeatureToggleService` | Can gate premium features — extend with per-user checks |
| `AgeTier` enum (`CHILD`, `TEEN`, `ADULT`) + `ParentalLink` | Child exclusion from economic layer is already modeled |
| `Partner` model (basic: id, name, users) | Seed for brand partner organization — needs major expansion |
| `PostSentiment` / `CommentSentiment` | Reaction system exists — not reviews, but a foundation |
| `ProductTaxonomyTag` + Shopify sync | Product catalog tagging exists (read-only) |
| `CustomAudience` / `CustomAudienceMember` | Creator audience management — relevant for contributor segmentation |
| `Notification` + `NotificationPreference` | Notification infrastructure for earnings alerts, brand prompts |
| Session with `ageTier`, `role`, `dataRegion` | Auth already carries fields needed for tier-aware access |
| SQS queues (5 existing + pattern) | Pattern for adding payment/wallet event queues |
| `SecurityEvent` model | Audit logging pattern for financial transactions |

## Complete Gaps

| Area | Status |
|---|---|
| Payment processor (Stripe, etc.) | Does not exist |
| Subscription / billing models | Does not exist |
| Wallet, credits, earnings, transactions | Does not exist |
| Review / rating system (distinct from sentiments) | Does not exist |
| Brand campaign / value-action models | Does not exist |
| Per-user premium feature gating | Does not exist (toggles are global only) |
| Flutter payment / subscription / wallet UI | Does not exist |
| CDK infrastructure for payment processing | Does not exist |
| SQS queues for financial events | Does not exist |
| SSM parameters for payment secrets | Does not exist |
| B2B brand tools API | Does not exist |
| Attribution engine for ambient value | Does not exist |
