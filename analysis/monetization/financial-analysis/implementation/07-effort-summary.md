# Effort Summary

## By Phase

| Phase | Scope | Effort | Dependency |
|---|---|---|---|
| **Phase 0: Foundation** | Subscription model, per-user gating, Stripe setup, age enforcement | Small-Medium | None |
| **Phase 1: Premium Subscriptions** | Checkout flow, webhook handling, session changes, Flutter UI | Medium | Phase 0 |
| **Phase 2: Wallet & Value Exchange** | Wallet, transactions, value actions, brand model, Flutter UI | Large | Phase 0 + 1 |
| **Phase 3: B2B Brand Tools** | Campaign management, analytics, contributor discovery | Medium | Phase 2 |
| **Phase 4: Attribution Engine** | AI-powered content analysis, ambient value tracking | Large | Phase 2 |

---

## Critical Path

```
Phase 0 (Foundation)
  └─→ Phase 1 (Premium Subscriptions)  ← unlocks Revenue Stream 1
       └─→ Phase 2 (Wallet & Value Exchange)  ← unlocks Revenue Streams 2 + 3
            ├─→ Phase 3 (B2B Brand Tools)  ← unlocks Revenue Stream 4
            └─→ Phase 4 (Attribution Engine)  ← enhances Revenue Stream 3
```

---

## Files Changed vs. Files Created

| Category | Changed (Existing) | Created (New) |
|---|---|---|
| Prisma schema | `prisma/schema.prisma` | — |
| API handlers | — | `subscription-handler.ts`, `wallet-handler.ts`, `value-action-handler.ts`, `brand-handler.ts` |
| API routes | `routes/index.ts` (register new routes) | `routes/subscriptions.ts`, `routes/webhooks.ts`, `routes/wallet.ts`, `routes/value-actions.ts`, `routes/brands.ts`, `routes/brand-tools.ts` |
| Auth/session | `session-manager.ts` (add `hasPremium`), `env.ts` (add Stripe client) | — |
| Feature gating | `feature-toggle-service.ts` (add per-user), `FeatureToggle` model (add `requiresPremium` field) | — |
| CDK infra | `api-stack.ts` (IAM), `data-stack.ts` (SQS), `config/index.ts` | `workers-stack.ts` (new workers) or extend existing |
| Flutter | `core/api/api_client.dart` (new endpoints) | `features/subscription/`, `features/wallet/`, `features/value_actions/`, `features/brands/` |

---

## SSM Parameters to Add

| Parameter | Purpose |
|---|---|
| `/trellis/{stage}/stripe-secret-key` | Stripe API secret |
| `/trellis/{stage}/stripe-webhook-secret` | Stripe webhook signature verification |
| `/trellis/{stage}/stripe-price-premium-monthly` | Stripe Price ID for premium monthly |
| `/trellis/{stage}/stripe-price-premium-annual` | Stripe Price ID for premium annual |
| `/trellis/{stage}/stripe-connect-client-id` | Stripe Connect for user payouts |
