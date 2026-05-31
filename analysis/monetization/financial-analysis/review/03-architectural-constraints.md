# Architectural Constraints

Hard constraints from the existing codebase that the monetization implementation must follow. These are not mentioned in the current implementation docs and represent gaps.

---

## Constraint 1: Data Residency (Critical)

### What Exists

Trellis enforces strict data-region isolation:
- `User.region` ("US", "EU", "CN") and `User.dataRegion` determine where data is stored
- `createPrismaForRegion()` creates per-region database connections
- `validateRegionAccess()` throws if a request tries to access data across regions
- `CrossRegionConsent` table handles explicit consent for cross-region access
- Default region is EU (strictest GDPR)

### What the Monetization Implementation Must Do

- `Wallet`, `Subscription`, `WalletTransaction`, `ValueAction` records must be stored in the user's `dataRegion`
- `Brand` records may be global (brands operate across regions), but user-brand interactions (value actions, earnings) must follow user's region
- Payment processing must respect region: Stripe accounts may need to be per-region for tax compliance
- Revenue analytics must aggregate per-region and never expose individual user data cross-region

### Gap in Current Implementation Docs

None of the Phase 0-4 docs mention data residency. The `Wallet` and `Subscription` models don't include `dataRegion` fields or note the region-isolation requirement.

---

## Constraint 2: ActivityPub Federation Safety (Critical)

### What Exists

Trellis supports ActivityPub federation (disabled by default, enabled per environment). When enabled:
- User profiles, posts, and entities are visible to remote servers
- Outbox activities are federated
- HTTP Signatures ensure integrity

### What the Monetization Implementation Must Do

- **Never publish** payment, wallet, subscription, or earnings data via ActivityPub
- **Never include** brand relationship data in federated activities
- Value-action content (reviews, Q&A) that a user shares to their social feed may be federated — but the associated payment metadata must be stripped
- Transparency labels ("This review was part of [user]'s platform contribution") must survive federation

### Gap in Current Implementation Docs

Federation is not mentioned in any implementation phase. A note is needed: monetization data stays local; only user-shared content is federable, without payment metadata.

---

## Constraint 3: Privacy Settings (High)

### What Exists

- `User.analyticsOptOut` — user can opt out of analytics
- `User.locationAnonymizationLevel` — controls location precision (0=exact, 1=100m, 2=1km, 3=city)
- `User.stealthMode` — hides online status and activity
- `User.locationTrackingEnabled` — controls whether location is tracked at all

### What the Monetization Implementation Must Do

- **Brand analytics** (Phase 3 B2B tools) must exclude users with `analyticsOptOut = true`
- **Contributor discovery** must respect `stealthMode` — stealth users should not appear in brand contributor lists
- **Location-based brand targeting** must respect `locationAnonymizationLevel` — never share precise location with brands
- **Ambient attribution** (Phase 4) must exclude `analyticsOptOut` users entirely

### Gap in Current Implementation Docs

Phase 3 (B2B Brand Tools) describes "contributor discovery" and "brand dashboard analytics" without mentioning privacy exclusions. Phase 4 (Attribution) doesn't mention `analyticsOptOut`.

---

## Constraint 4: Audit Logging (High)

### What Exists

Trellis has an audit logging system (`auditLogger`) with:
- Event types: `data_access`, `data_create`, `data_update`, `data_delete`, `user_action`, `authentication`, `authorization`
- Severity levels: `low`, `medium`, `high`, `critical`
- Region tracking per event
- `SecurityEvent` model for persistent audit records

### What the Monetization Implementation Must Do

All financial operations must be audit-logged at `severity: "high"` or `"critical"`:
- Subscription creation, cancellation, renewal
- Wallet creation, balance changes, payouts
- Value action completion, payment calculation
- Brand budget changes, campaign start/stop
- Stripe webhook events received and processed

### Gap in Current Implementation Docs

Audit logging is not mentioned in any implementation phase. Should be listed as a cross-cutting concern for all phases.

---

## Constraint 5: Age Tier Enforcement (Critical — Already Noted)

### What Exists

Hard-coded feature access per age tier:
- `CHILD`: 5 max feed pages, 30-min hard session limit, no DMs, hidden sentiments
- `TEEN`: 20 max feed pages, no hard limit, connections-only DMs, distribution sentiments
- `ADULT`: Unlimited, full access

Age tier restrictions **override** everything else, including premium subscriptions.

### What the Monetization Implementation Must Do

Already noted in Phase 0.4 of the implementation docs. This is the one architectural constraint that IS addressed.

Additional nuance: even if a TEEN's parent pays for premium, the child safety restrictions still apply. Premium for a TEEN should only unlock age-appropriate features (e.g., advanced pet health analytics) — never bypass safety limits.

---

## Constraint 6: Generic Core / Entity Agnosticism (Medium)

### What Exists

The codebase is structured as a generic social-network core with domain extensions:
- `Entity` model uses `entityType` and `metadata: Json` for domain-specific data
- Extensions provide hooks, schemas, feed strategies
- ~75-80% of code is domain-agnostic

### What the Monetization Implementation Must Do

- `Brand`, `ValueAction`, `Wallet`, `Subscription` models are already entity-agnostic (no dog-specific fields) — this is correct
- Value action types (PRODUCT_REVIEW, PEER_QA, etc.) should work for any vertical, not just pet products
- Market analysis docs are pet-specific (correctly), but code must not be
- If deploying the core for a different vertical (plants, cars), the monetization system should work without modification

### Gap in Current Implementation Docs

Not explicitly stated but the models are already correct. Worth adding a note: "All monetization models are domain-agnostic and will work across verticals without modification."

---

## Constraint 7: Cost Tracking Pattern (Low)

### What Exists

`CostAccumulator` records per-service costs synchronously:
- Services: openai, sqs, dynamodb, s3, ses
- Daily aggregation and budget enforcement
- Alerts when costs exceed thresholds

### What the Monetization Implementation Should Do

Revenue tracking should follow the same pattern:
- Record revenue events synchronously via a `RevenueAccumulator`
- Aggregate daily in DynamoDB single-table
- Expose via dashboard APIs alongside cost data
- Alert on anomalies (payout failures, revenue drops)

### Gap in Current Implementation Docs

Not mentioned. Revenue tracking is implicitly covered by the `WalletTransaction` model, but the operational tooling (daily aggregation, alerts, dashboard) should be noted.

---

## Constraint 8: Configuration Hierarchy (Low)

### What Exists

`StageConfig` in `infra/lib/config/` provides per-environment configuration:
- `dev.ts` overrides for development
- `prod.ts` overrides for production
- Feature flags, budgets, cost protection per stage

### What the Monetization Implementation Must Do

Add monetization config to `StageConfig`:

```typescript
monetization: {
  enabled: boolean           // Master switch
  stripeLiveMode: boolean    // dev=false (test keys), prod=true
  payoutEnabled: boolean     // Defer cash payouts initially
  payoutMinimumCents: number // Minimum cash-out threshold
}
```

### Gap in Current Implementation Docs

Phase 0.3 mentions adding Stripe config to `StageConfig` but doesn't show the shape. Should include `monetization` config block with the `enabled` master switch.
