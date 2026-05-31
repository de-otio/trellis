# Recommendations

Concrete actions organized by urgency.

---

## Commit Now (Safe, Aligned with Values)

These decisions are safe to lock in. They're either easily reversible or fundamental to the product identity.

| Decision | Rationale |
|---|---|
| Free basic platform, forever | Core brand identity. Financial model is profitable without a paywall. Irreversible once launched, but that's the point. |
| Premium subscription via Stripe ($6.99/month) | Standard infrastructure. Price, features, and processor are all easily changeable. |
| Per-user feature gating via `requiresPremium` on `FeatureToggle` | Data-driven, flexible. Add tiers later by extending the field. |
| `Subscription` model with `source` field (STRIPE vs VALUE_EXCHANGE) | Clean separation of access from payment method. New sources addable without breaking anything. |
| Architectural separation of social and contribution spaces | Aligns with transparency values. Prevents feed contamination (top risk). |
| `Brand` model separate from `Partner` (1:many) | Correct cardinality. Minimal overhead even if some partners only have one brand. |
| `Wallet` and `WalletTransaction` models with transaction-as-source-of-truth | Sound financial data model. Denormalized balance + reconciliation is the right pattern. |
| Age-gated exclusion of children from economic layer | Non-negotiable per COPPA/GDPR/JuSchG. Already supported by `AgeTier` architecture. |

---

## Defer (Build Infrastructure, Not Policy)

These should be structurally supported in the data model but not activated at launch.

### Cash Payouts to Users

**Build**: `Wallet` model, `WalletTransaction` with `PAYOUT` type, `Wallet.stripeConnectId` field (nullable).

**Don't activate**: No Stripe Connect onboarding, no cash-out UI, no tax reporting.

**Launch with**: Platform credits for premium unlock and charity donations only.

**Activate when**:
1. Value-exchange model is validated (participation rates, brand ROI confirmed)
2. Legal opinions obtained per market (DE, AT, CH minimum)
3. Tax reporting automation is built
4. Volume justifies Stripe Connect fees

### Ambient Attribution (Phase 4)

**Build**: Nothing yet. The `AmbientAttribution` model and attribution engine are expensive and speculative.

**Launch with**: Streams 1 (subscriptions), 2 (explicit value actions), and 4 (B2B tools) only.

**Activate when**: Streams 1, 2, 4 are generating revenue and the platform has enough content volume to make attribution meaningful.

### Annual Pricing

**Build**: Nothing yet. Stripe supports annual prices natively.

**Launch with**: Monthly pricing only.

**Activate when**: You have 6+ months of churn data to optimize against. Annual pricing is a retention tool, not a launch feature.

### Per-Tenant Feature Gating

**Build**: The `requiresPremium` field is sufficient. Don't add per-tenant dimensions.

**Activate when**: B2B partners request differentiated feature access. Add a `requiredTier` or `tenantOverrides` field to `FeatureToggle` at that point.

---

## Fix in Documentation

### High Priority

**1. Write a "model evolution" document**

Create `value-exchange-social-platform/00-model-overview.md` explaining:
- The model has two layers: explicit value actions (primary) and ambient attribution (secondary)
- Docs 01-06 describe Layer 1 (explicit actions)
- Doc 11 describes the vision for Layer 2 (ambient/universal)
- Financial analysis models both layers, but Layer 2 is deferred (Phase 4)
- The model is viable without Layer 2

**2. Add architectural constraints to implementation docs**

Create `implementation/08-cross-cutting-concerns.md` covering:
- Data residency: all financial models must follow `User.dataRegion`
- Federation safety: monetization data stays local, never in ActivityPub activities
- Privacy: brand analytics must respect `analyticsOptOut`, `stealthMode`, `locationAnonymizationLevel`
- Audit logging: all payment operations logged at `severity: "high"`
- Generic core: all monetization models are entity-agnostic
- Stage config: add `monetization` block to `StageConfig`

**3. Note the "credits first, cash later" strategy**

Update `implementation/04-phase-2-wallet-value-exchange.md`:
- Wallet launches with PREMIUM_UNLOCK and DONATION transaction types only
- PAYOUT type is defined in the enum but not activated
- `Wallet.stripeConnectId` remains nullable
- Cash payouts are a separate activation milestone, not part of Phase 2

### Medium Priority

**4. Design contributor social recognition**

The 20% participation assumption depends on "social recognition" as a third incentive. Options:
- Contributor badge on profile (visible to other users)
- "Top contributors this month" in Contribution Space (opt-in)
- Helpfulness ratings visible on contributor profile

Add to `value-exchange-social-platform/04-gamification.md` or create a new doc.

**5. Resolve annual pricing**

Either:
- Add annual pricing to `financial-analysis/04-financial-projections.md` with a blended ARPPU assumption (e.g., 30% annual at $5.00/month effective, 70% monthly at $6.99)
- Or remove the mention from `02-revenue-model.md` and note it as a future optimization

### Low Priority

**6. Clarify earnings expectations in doc 11**

Add a note to `value-exchange-social-platform/11-universal-micro-influencer.md` that the earnings spectrum ($0.50-$1,000+/month) is aspirational and includes Phase 4 ambient attribution. Initial earnings will follow the action-based model in the financial analysis.

**7. Add BrandSubscription transaction types**

Extend `TransactionType` enum or create a separate `BrandTransactionType` for B2B billing events (charge success, charge failure, refund) to maintain audit trail parity with user transactions.

---

## Summary: What Changes vs. What Stays

| Area | Status | Action |
|---|---|---|
| Financial model | Solid | No changes needed |
| Revenue projections | Consistent | Add annual pricing note (minor) |
| Unit economics | Well-sourced | No changes needed |
| Sensitivity analysis | Thorough | No changes needed |
| Risk analysis | Complete | No changes needed |
| Implementation phases | Correct | Add cross-cutting concerns doc |
| Prisma models | Sound after review fixes | Add data residency awareness |
| Conceptual docs | Need evolution narrative | Write model overview doc |
| Values alignment | Strong | Document the tensions explicitly |
