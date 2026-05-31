# Phase 0: Foundation

Everything else depends on these primitives.

---

## 0.1 Subscription Model

The `User` model has no concept of subscription status. Add:

```prisma
model Subscription {
  id                   String               @id @default(cuid())
  userId               String               @map("user_id")
  status               SubscriptionStatus   @default(ACTIVE)
  source               SubscriptionSource   @default(STRIPE)
  stripeCustomerId     String?              @map("stripe_customer_id")
  stripeSubscriptionId String?              @map("stripe_subscription_id")
  currentPeriodStart   DateTime?            @map("current_period_start")
  currentPeriodEnd     DateTime?            @map("current_period_end")
  cancelledAt          DateTime?            @map("cancelled_at")
  createdAt            DateTime             @default(now()) @map("created_at")
  updatedAt            DateTime             @updatedAt @map("updated_at")

  user User @relation(fields: [userId], references: [id])

  @@index([userId])
  @@index([userId, status])
  @@map("subscriptions")
}

enum SubscriptionSource {
  STRIPE           // User paid via Stripe
  VALUE_EXCHANGE   // Earned via value-action contributions
}

enum SubscriptionStatus {
  ACTIVE
  PAST_DUE
  CANCELLED
  EXPIRED
}
```

### Design Decisions

- **No `FREE` tier**: Free users simply have no `Subscription` record. The session treats `null` subscription as free access.
- **No `PREMIUM_VE_UNLOCK` tier**: Premium access is identical regardless of how it was obtained. The `source` field tracks *how* the user got premium (payment vs. value exchange) for analytics, without polluting access-control logic.
- **`userId` is NOT unique**: A user may subscribe, cancel, and re-subscribe. History is preserved. Find the current subscription with `WHERE userId = ? AND status = 'ACTIVE'`.

**Files affected**: `prisma/schema.prisma`, `apps/api/src/lib/session-manager.ts` (add `hasPremium: boolean` to `Session` interface)

---

## 0.2 Per-User Feature Gating

Current `FeatureToggleService.isEnabled(key)` is global. Extend with per-user checks:

```typescript
async isEnabledForUser(key: string, session: Session): Promise<boolean> {
  const toggle = await this.prisma.featureToggle.findUnique({
    where: { key },
    select: { enabled: true, requiresPremium: true },
  });
  if (!toggle?.enabled) return false;

  // Data-driven premium gating — no hardcoded feature lists
  if (toggle.requiresPremium) {
    return session.hasPremium === true;
  }

  return true;
}
```

This requires adding a `requiresPremium Boolean @default(false)` field to the `FeatureToggle` model. Premium gating is then data-driven (set per toggle in the database), not hardcoded in an array that becomes a maintenance problem.

**Files affected**: `prisma/schema.prisma` (`FeatureToggle` model), `apps/api/src/lib/feature-toggle-service.ts`, every route handler that serves premium content

---

## 0.3 Payment Processor (Stripe)

- Add `stripe` npm dependency to `apps/api/`
- Store secrets in SSM: `/trellis/{stage}/stripe-secret-key`, `/trellis/{stage}/stripe-webhook-secret`
- Create Stripe client initialization in `apps/api/src/env.ts`
- CDK: add SSM parameters, update API task IAM policy to read them
- Auth remains AWS Cognito (JWT via `aws-jwt-verify`) — Stripe is for payments only, not auth. The Stripe webhook endpoint uses signature verification, not Cognito sessions.

**Files affected**: `apps/api/package.json`, `apps/api/src/env.ts`, `infra/lib/api-stack.ts`, `infra/lib/config/index.ts`

---

## 0.4 Age-Gated Economic Exclusion

`AgeTier` and `ParentalLink` already exist. Add enforcement:

- `CHILD` and `TEEN` users cannot create wallets or subscriptions
- Check `session.ageTier` in subscription and wallet route handlers
- Age verification before wallet activation (not just self-reported DOB)

**Files affected**: New route handlers (subscription, wallet) — enforcement is built in from the start, not retrofitted
