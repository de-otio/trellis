# Reversibility Assessment

What's easy to change later, what's hard, and what to be careful about.

---

## Easily Reversible (Don't Worry)

These decisions can be changed with minimal cost or disruption:

| Decision | Why Reversible |
|---|---|
| Stripe as payment processor | Swap to Paddle, Lemonsqueezy, etc. — just API integration changes |
| $6.99 price point | Change a Stripe price ID and a config value |
| Premium feature set | Toggle `requiresPremium` per feature in the database |
| Value action types (review, Q&A, survey) | Enum values can be added freely; action content is JSON |
| Brand payment rates ($2-5/action) | Configuration via `Brand.actionConfig`, not code |
| Platform take rate (35%) | Business logic, single constant |
| VE premium unlock threshold | Single constant |
| Number of SQS queues | CDK infrastructure, add or remove freely |
| SSM parameter names | Change before launch with no impact |

---

## Moderately Reversible (Be Thoughtful)

These require more effort to change but are manageable:

| Decision | Why It's Harder | Mitigation |
|---|---|---|
| Single premium tier (not multiple tiers) | Adding tiers later means migrating existing subscribers and reworking feature gating | **One tier is correct for launch.** Adding tiers is standard SaaS evolution. The `requiresPremium` field on `FeatureToggle` already supports any number of tiers — just add a `requiredTier` field later if needed. |
| `Subscription.source` enum (STRIPE, VALUE_EXCHANGE) | Historical data references these values; adding new sources is fine, renaming is not | **Well-designed.** Source is analytics metadata, not access control. New sources can be added without breaking anything. |
| Brand model separate from Partner | Changing the Brand ↔ Partner cardinality later means data migration | **Correct design.** 1:many Partner→Brand is right. The only risk is if partners NEVER have multiple brands, in which case the separate model is unnecessary overhead — but the overhead is minimal. |
| Wallet balance as denormalized field | If transaction-based reconciliation doesn't run, balances drift | **Acceptable tradeoff** if reconciliation job is built in Phase 2 as noted. The alternative (computing balance from transactions on every read) has performance costs at scale. |

---

## Hard to Reverse (Think Carefully)

These decisions have significant switching costs or irreversible consequences:

### Free Basic Platform (No Paywall)

**Reversibility**: Very hard. Once users expect free access, adding a paywall destroys trust and violates the brand promise.

**Assessment**: **Commit to this.** The entire anti-exploitation positioning depends on it. The financial model shows profitability without a paywall. This IS the product differentiation.

### Paying Users Real Money (Cash Payouts)

**Reversibility**: Very hard. Once users have cash balances, you have:
- Tax reporting obligations (1099 in US, equivalent in DACH)
- Regulatory scrutiny (money transmitter licensing in some jurisdictions)
- User expectations that are painful to roll back ("you used to pay me, now you don't")
- Payment processing infrastructure that's expensive to maintain at low volume

**Assessment**: **Don't start with cash payouts.** The wallet model supports multiple transaction types. Launch with:
- `PREMIUM_UNLOCK` — value actions earn premium access (platform credits)
- `DONATION` — optionally donate earned credits to animal welfare charities

Add `PAYOUT` (cash via Stripe Connect) later, after:
1. The model is validated (participation rates, brand ROI)
2. Legal opinions are obtained per market
3. Volume justifies the infrastructure cost
4. Tax reporting automation is built

The `Wallet.stripeConnectId` field can remain nullable until then. The financial projections don't need to change — platform revenue from value exchange is the same regardless of whether users receive cash or credits.

### Brand Data Access Patterns

**Reversibility**: Hard. Once brands get used to seeing certain user data or analytics, removing access feels like a service downgrade and may violate contracts.

**Assessment**: **Start minimal.** Phase 3 brand tools should launch with:
- Aggregated, anonymized data only (no individual user identification)
- Respect `analyticsOptOut` from day one
- Respect `locationAnonymizationLevel`
- No raw content access — brands see quality scores and aggregate metrics, not individual reviews

You can always give brands MORE data access later (with user consent). Taking data away is hard and may trigger GDPR right-of-access complications.

### Architectural Separation of Social and Contribution Spaces

**Reversibility**: Hard. Building two distinct UI spaces (social feed vs. contribution section) creates structural decisions in both API and Flutter that are expensive to merge.

**Assessment**: **Commit to this.** This is not a compromise — it IS the transparency architecture. It prevents feed contamination, which is identified as a top risk. The separation is a feature that aligns with the project's core values (Wellbeing, Transparency).

### Per-User vs. Per-Tenant Feature Gating

**Reversibility**: Medium-hard. The current `FeatureToggle` is global. Adding `requiresPremium` makes it per-tier. But if you later need per-tenant gating (e.g., Partner X's users get different features than Partner Y's), the model needs another dimension.

**Assessment**: **`requiresPremium` is sufficient for now.** True per-tenant gating is a B2B feature that can be added in Phase 3 if needed. Don't over-engineer the gating system before you need it.

---

## Decision Summary

| Decision | Recommendation | Confidence |
|---|---|---|
| Free basic platform | **Commit** | High |
| Single premium tier | **Commit** (add tiers later if needed) | High |
| Stripe for payments | **Commit** (easy to swap) | High |
| Wallet with credit types | **Commit** (flexible foundation) | High |
| Cash payouts to users | **Defer** (start with credits only) | High |
| Brand data access | **Start minimal**, expand with consent | High |
| Social/contribution separation | **Commit** | High |
| Ambient attribution (Phase 4) | **Defer** until Streams 1, 2, 4 are proven | Medium |
| Annual pricing | **Defer** until churn data exists | Medium |
| Per-tenant feature gating | **Defer** until B2B needs emerge | Medium |
