# Phase 2: Wallet & Value Exchange (Revenue Streams 2 + 3)

---

## New Prisma Models

### Wallet

```prisma
model Wallet {
  id               String   @id @default(cuid())
  userId           String   @unique @map("user_id")
  balance          Decimal  @default(0) @db.Decimal(10, 2)
  lifetimeEarnings Decimal  @default(0) @map("lifetime_earnings") @db.Decimal(10, 2)
  currency         String   @default("EUR")
  stripeConnectId  String?  @map("stripe_connect_id")
  createdAt        DateTime @default(now()) @map("created_at")
  updatedAt        DateTime @updatedAt @map("updated_at")

  user         User                @relation(fields: [userId], references: [id])
  transactions WalletTransaction[]

  @@map("wallets")
}
```

**Balance reconciliation**: `Wallet.balance` and `Wallet.lifetimeEarnings` are denormalized for read performance. The `WalletTransaction` table is the source of truth. All balance updates MUST go through a transaction record — never update balance directly. A periodic reconciliation job should verify balance matches `SUM(transactions)` and flag discrepancies via `SecurityEvent`.

### WalletTransaction

```prisma
model WalletTransaction {
  id          String          @id @default(cuid())
  walletId    String          @map("wallet_id")
  type        TransactionType
  amount      Decimal         @db.Decimal(10, 2)
  description String?
  actionId    String?         @map("action_id")
  createdAt   DateTime        @default(now()) @map("created_at")
  updatedAt   DateTime        @updatedAt @map("updated_at")

  wallet Wallet @relation(fields: [walletId], references: [id])

  @@index([walletId])
  @@map("wallet_transactions")
}

enum TransactionType {
  EARNING
  AMBIENT_EARNING
  PAYOUT
  PREMIUM_UNLOCK
  DONATION
}
```

### ValueAction

```prisma
model ValueAction {
  id            String            @id @default(cuid())
  userId        String            @map("user_id")
  brandId       String            @map("brand_id")
  type          ValueActionType
  status        ValueActionStatus @default(PENDING)
  content       Json?
  qualityScore  Decimal?          @map("quality_score") @db.Decimal(3, 2)
  brandPayment  Decimal?          @map("brand_payment") @db.Decimal(10, 2)
  platformShare Decimal?          @map("platform_share") @db.Decimal(10, 2)
  userEarning   Decimal?          @map("user_earning") @db.Decimal(10, 2)
  createdAt     DateTime          @default(now()) @map("created_at")
  updatedAt     DateTime          @updatedAt @map("updated_at")
  completedAt   DateTime?         @map("completed_at")

  user  User  @relation(fields: [userId], references: [id])
  brand Brand @relation(fields: [brandId], references: [id])

  @@index([userId])
  @@index([brandId])
  @@map("value_actions")
}

enum ValueActionType {
  PRODUCT_REVIEW
  PEER_QA
  FEEDBACK_SURVEY
  ENDORSED_RECOMMENDATION
  PRODUCT_PHOTO
}

enum ValueActionStatus {
  PENDING
  COMPLETED
  REJECTED
  EXPIRED
}
```

---

## Brand Model (New — Relates to Existing `Partner`)

The `Partner` model represents the B2B organization (e.g., Fressnapf the company). It stays as-is — it owns the `User[]` relation for staff who log in with `B2B_PARTNER` role. The new `Brand` model represents a commercial identity within the value-exchange system. A `Partner` can have multiple brands (store brand, premium line, etc.):

```prisma
model Brand {
  id              String      @id @default(cuid())
  partnerId       String?     @map("partner_id")
  name            String
  slug            String      @unique
  logoUrl         String?     @map("logo_url")
  category        String?
  description     String?
  monthlyBudget   Decimal?    @map("monthly_budget") @db.Decimal(10, 2)
  budgetRemaining Decimal?    @map("budget_remaining") @db.Decimal(10, 2)
  actionConfig    Json?       @map("action_config")
  status          BrandStatus @default(PENDING)
  createdAt       DateTime    @default(now()) @map("created_at")
  updatedAt       DateTime    @updatedAt @map("updated_at")

  partner       Partner?            @relation(fields: [partnerId], references: [id])
  actions       ValueAction[]
  campaigns     BrandCampaign[]
  subscription  BrandSubscription?
  attributions  AmbientAttribution[]

  @@map("brands")
}

enum BrandStatus {
  PENDING
  ACTIVE
  PAUSED
  SUSPENDED
}
```

Also add `brands Brand[]` relation to `Partner` model.

---

## New API Routes

| Route | Method | Description |
|---|---|---|
| `/api/wallet` | `GET` | Get wallet balance and summary |
| `/api/wallet` | `POST` | Create wallet (age-gated: adults only) |
| `/api/wallet/transactions` | `GET` | Transaction history (paginated) |
| `/api/wallet/payout` | `POST` | Request cash-out via Stripe Connect |
| `/api/value-actions` | `GET` | Available actions for current user |
| `/api/value-actions/:id/complete` | `POST` | Submit completed action |
| `/api/value-actions/history` | `GET` | User's action history |
| `/api/brands` | `GET` | Brand directory (public) |
| `/api/brands/:id` | `GET` | Brand detail |
| `/api/brands/:id/opt-in` | `POST` | User opts in to a brand |
| `/api/brands/:id/opt-out` | `POST` | User opts out of a brand |

**New handlers**: `wallet-handler.ts`, `value-action-handler.ts`, `brand-handler.ts`
**New route files**: `wallet.ts`, `value-actions.ts`, `brands.ts`

---

## Premium Unlock Logic

When a user's monthly value-action earnings exceed the premium threshold (~$5-7), create or reactivate a premium subscription sourced from value exchange:

```typescript
// In value-action completion handler or async worker:
if (monthlyEarnings >= PREMIUM_UNLOCK_THRESHOLD) {
  // Check for existing active subscription (user may already be a paying subscriber)
  const existing = await db.subscription.findFirst({
    where: { userId, status: 'ACTIVE' },
  });

  if (!existing) {
    await db.subscription.create({
      data: {
        userId,
        source: 'VALUE_EXCHANGE',
        status: 'ACTIVE',
        currentPeriodStart: new Date(),
        currentPeriodEnd: endOfMonth(),
      },
    });
    // Invalidate session cache so next request picks up hasPremium = true
  }
  // If user already has an active Stripe subscription, do nothing —
  // they keep their paid subscription and also earn wallet income.
}
```

Value-exchange subscriptions expire at end of month. A monthly worker checks whether each VE subscriber met the threshold; if not, their subscription status is set to `EXPIRED`. They can re-earn it the following month.

---

## SQS Queues to Add

| Queue | Purpose | Visibility | Retention |
|---|---|---|---|
| `{stage}-value-action-processing` | Async quality scoring, payment calculation | 120s | 3d |
| `{stage}-wallet-events` | Transaction processing, balance updates | 60s | 3d |

**CDK**: Add to `data-stack.ts` following existing SQS queue pattern. Add Lambda workers to `workers-stack.ts`.

---

## Flutter Changes

- New `features/wallet/` — balance display, transaction history, payout request
- New `features/value_actions/` — available actions, completion flow, action history
- New `features/brands/` — brand directory, opt-in/opt-out
- Contribution Space as separate tab in bottom navigation (architecturally separate from social feed)
