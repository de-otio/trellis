# Phase 3: B2B Brand Tools (Revenue Stream 4)

---

## New API Routes

| Route | Method | Description |
|---|---|---|
| `/api/brand-tools/campaigns` | `GET/POST` | Campaign management |
| `/api/brand-tools/campaigns/:id` | `GET/PATCH/DELETE` | Campaign CRUD |
| `/api/brand-tools/analytics` | `GET` | Brand dashboard analytics |
| `/api/brand-tools/contributors` | `GET` | Contributor discovery |
| `/api/brand-tools/actions` | `POST` | Define new value action types |

**Access control**: `B2B_PARTNER` or `PARTNER_ADMIN` role required.

---

## New Prisma Models

### BrandCampaign

```prisma
model BrandCampaign {
  id          String             @id @default(cuid())
  brandId     String             @map("brand_id")
  name        String
  description String?
  actionTypes Json               @map("action_types")
  budget      Decimal            @db.Decimal(10, 2)
  spent       Decimal            @default(0) @db.Decimal(10, 2)
  startDate   DateTime           @map("start_date")
  endDate     DateTime           @map("end_date")
  status      CampaignStatus     @default(DRAFT)
  createdAt   DateTime           @default(now()) @map("created_at")
  updatedAt   DateTime           @updatedAt @map("updated_at")

  brand Brand @relation(fields: [brandId], references: [id])

  @@index([brandId])
  @@map("brand_campaigns")
}

enum CampaignStatus {
  DRAFT
  ACTIVE
  PAUSED
  COMPLETED
  CANCELLED
}
```

Add `campaigns BrandCampaign[]` relation to `Brand` model.

---

## B2B Billing

Brand subscriptions are a **separate model** from user subscriptions — they have different pricing tiers, billing cycles, features, and Stripe products. Sharing a model between consumer and B2B would create messy conditional logic.

```prisma
model BrandSubscription {
  id                   String                   @id @default(cuid())
  brandId              String                   @map("brand_id")
  tier                 BrandSubscriptionTier    @default(STARTER)
  status               SubscriptionStatus       @default(ACTIVE)
  stripeCustomerId     String?                  @map("stripe_customer_id")
  stripeSubscriptionId String?                  @map("stripe_subscription_id")
  currentPeriodStart   DateTime?                @map("current_period_start")
  currentPeriodEnd     DateTime?                @map("current_period_end")
  createdAt            DateTime                 @default(now()) @map("created_at")
  updatedAt            DateTime                 @updatedAt @map("updated_at")

  brand Brand @relation(fields: [brandId], references: [id])

  @@index([brandId])
  @@map("brand_subscriptions")
}

enum BrandSubscriptionTier {
  STARTER        // $199/month
  PROFESSIONAL   // $599/month
  ENTERPRISE     // $1,500+/month
}
```

Reuses the `SubscriptionStatus` enum (ACTIVE, PAST_DUE, CANCELLED, EXPIRED) which is shared with user subscriptions — status semantics are identical.

---

## Flutter Changes

- Extend `features/admin/` with brand tools screens (or new `features/brand_tools/`)
- Campaign creation wizard
- Analytics dashboard
- Contributor discovery with filters
