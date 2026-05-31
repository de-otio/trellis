# Phase 4: Universal Micro-Influencer Attribution (Revenue Stream 3 — Ambient)

The most architecturally complex piece. Can be deferred until Streams 1, 2, and 4 are generating revenue.

---

## Attribution Engine

- Lambda worker processes new posts
- Identifies brand mentions (text) and brand products (image recognition)
- Calculates ambient value based on reach (views, shares, click-throughs)
- Credits user wallet with micro-earnings

---

## New Prisma Model

```prisma
model AmbientAttribution {
  id              String   @id @default(cuid())
  postId          String   @map("post_id")
  userId          String   @map("user_id")
  brandId         String   @map("brand_id")
  attributionType String   @map("attribution_type")
  estimatedValue  Decimal  @map("estimated_value") @db.Decimal(10, 4)
  impressions     Int      @default(0)
  clickThroughs   Int      @default(0) @map("click_throughs")
  settled         Boolean  @default(false)
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")
  settledAt       DateTime? @map("settled_at")

  user  User  @relation(fields: [userId], references: [id])
  post  Post  @relation(fields: [postId], references: [id])
  brand Brand @relation(fields: [brandId], references: [id])

  @@index([userId])
  @@index([brandId])
  @@index([postId])
  @@map("ambient_attributions")
}
```

---

## CDK Changes

- Lambda worker for attribution processing
- SQS queue: `{stage}-attribution-processing`
- Possibly AWS Rekognition for image-based product recognition
- Possibly Bedrock for text-based brand mention detection
