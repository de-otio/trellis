# Phase 1: Premium Subscriptions (Revenue Stream 1)

---

## Prisma Changes

- Add `Subscription` model (see [Phase 0](02-phase-0-foundation.md))
- Add `subscriptions Subscription[]` relation to `User` model

---

## New API Routes

| Route | Method | Description |
|---|---|---|
| `/api/subscriptions` | `GET` | Get current subscription status |
| `/api/subscriptions` | `POST` | Create Stripe checkout session |
| `/api/subscriptions/cancel` | `POST` | Cancel subscription |
| `/api/subscriptions/portal` | `POST` | Get Stripe billing portal link |
| `/api/webhooks/stripe` | `POST` | Handle Stripe events (no auth — verified by signature) |

**New handler**: `apps/api/src/lib/subscription-handler.ts`
**New route file**: `apps/api/src/lib/routes/subscriptions.ts`
**New webhook handler**: `apps/api/src/lib/routes/webhooks.ts`

---

## Stripe Webhook Events to Handle

| Event | Action |
|---|---|
| `checkout.session.completed` | Create/activate `Subscription` record |
| `customer.subscription.updated` | Update subscription status/period |
| `customer.subscription.deleted` | Mark subscription as cancelled |
| `invoice.payment_failed` | Set status to `PAST_DUE`, notify user |

---

## Session Changes

Add `hasPremium` to `Session` interface in `apps/api/src/lib/session-manager.ts`:

```typescript
export interface Session {
  // ... existing fields (userId, email, role, ageTier, dataRegion, etc.) ...
  hasPremium?: boolean; // true if user has an active Subscription (any source)
}
```

Load during session creation: query `Subscription` table for an `ACTIVE` record for this user. Cache as a boolean in the session cookie to avoid a DB lookup on every request.

**Why `hasPremium` instead of `subscriptionTier`**: Premium access is identical regardless of source (Stripe payment vs. value-exchange). Feature gating only needs a boolean. The `Subscription.source` field tracks the origin for analytics without complicating access-control logic.

---

## CDK Changes

- SSM parameters for Stripe keys
- Update API task role to read Stripe SSM parameters
- Optional: add to `infra/lib/config/index.ts` StageConfig for Stripe price IDs per environment

---

## Flutter Changes

- New `features/subscription/` directory
- Premium upgrade screen with Stripe checkout (web) or IAP (mobile)
- Subscription status display in settings
- Premium badge on profile
- Feature-locked UI states (greyed out features with "Upgrade" prompt)
