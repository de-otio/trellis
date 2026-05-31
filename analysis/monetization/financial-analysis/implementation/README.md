# Implementation Gap Analysis

What must change in the Trellis codebase to implement the freemium + voluntary value-exchange monetization model.

**Key simplification**: Nothing is live yet — no production users, no data, no migrations needed. All models, enums, and APIs can be modified directly.

---

## Documents

| Document | Description |
|---|---|
| [01-current-state.md](01-current-state.md) | What exists and can be leveraged, complete gaps |
| [02-phase-0-foundation.md](02-phase-0-foundation.md) | Subscription model, per-user gating, Stripe setup, age enforcement |
| [03-phase-1-subscriptions.md](03-phase-1-subscriptions.md) | Premium subscriptions: routes, webhooks, session, Flutter UI |
| [04-phase-2-wallet-value-exchange.md](04-phase-2-wallet-value-exchange.md) | Wallet, transactions, value actions, brand model |
| [05-phase-3-brand-tools.md](05-phase-3-brand-tools.md) | B2B campaign management, analytics, brand billing |
| [06-phase-4-attribution.md](06-phase-4-attribution.md) | AI-powered ambient value attribution engine |
| [07-effort-summary.md](07-effort-summary.md) | Critical path, files changed, SSM parameters |

---

## Critical Path

```
Phase 0 (Foundation)
  └─→ Phase 1 (Premium Subscriptions)  ← unlocks Revenue Stream 1
       └─→ Phase 2 (Wallet & Value Exchange)  ← unlocks Revenue Streams 2 + 3
            ├─→ Phase 3 (B2B Brand Tools)  ← unlocks Revenue Stream 4
            └─→ Phase 4 (Attribution Engine)  ← enhances Revenue Stream 3
```
