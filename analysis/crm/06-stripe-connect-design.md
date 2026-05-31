# Stripe Connect Design

This doc owns the design decisions on the rails layer that docs 04
and 05 depend on. Doc 02 defaulted two large choices — **Express**
account type and **destination** charge model — and named the
financial primitives. This doc ratifies (or revisits) those
defaults, designs the connected-account onboarding flow, the
payment lifecycle, the application-fee mechanism, refund and
dispute handling, and the webhook ingestion that feeds the
Payment / PlatformFee tables in doc 05's schema.

Stripe is the first concrete rails implementation, not the only
one. Doc 02's China-readiness directive requires that adding
Alipay / WeChat Pay / UnionPay later be a new implementation, not
a schema migration. The "rails-abstraction interface" section
below makes that concrete.

## Caveats and scope

- **Doc 02 is the parent.** Geographic scope (DACH/EU first), the
  China-readiness directive, the entity sketch, the open question
  on MoR / VAT, and the buy-vs-build call (rails are bought,
  application is built) all carry over and are not re-litigated
  here.
- **Schema entities from doc 05** (Payment, PlatformFee,
  PayoutAccount + Stripe extension, TaxArtifact) are the data
  model this doc binds to Stripe. Doc 05 is the data-model spec;
  this doc fills in the rails-extension shape.
- **Marketplace-ops dashboard from doc 04** is the customer of
  the webhook ingestion built here. The dispute / failed-payment
  alerts in doc 04 are direct consumers of webhook events
  surfaced through this doc's pipeline.
- **VAT and DAC7 mechanics** are not designed here beyond what
  Stripe-the-platform contributes. The operator is the Reporting
  Platform Operator under DAC7; Stripe provides data, not the
  filing. External tax-advisor review is flagged in doc 02 and
  not duplicated here.
- **Stripe API minutiae change.** This doc names the design
  decisions (account type, charge model, MoR, fee mechanism,
  refund / dispute behaviour, idempotency, retry semantics)
  rather than the specific 2026-vintage API names. Where it
  names a specific Stripe primitive (PaymentIntent,
  Account Link, application_fee_amount) it does so to anchor
  the design — implementation should re-check the current docs.

## Ratifying the doc 02 defaults

### Account type — Express, ratified

Doc 02's table compared Standard / Express / Custom across
onboarding UX, operator data access, and compliance UX ownership.
Walking the choice in light of doc 04 and doc 05 needs:

- **Standard.** The connected partner runs their own Stripe
  dashboard and files their own taxes / disputes. Operator data
  access via API is restricted (no partner PII through the API,
  by design). Rejected: doc 04's marketplace-ops surface needs
  KYC status, payout-readiness, and dispute exposure per
  partner — all gated when the account is Standard. Doc 05's
  tenant CRM also wants this on the partner detail view.
- **Express.** Stripe-hosted onboarding (operator-branded);
  Express dashboard for the partner; operator gets reasonable
  API access to KYC status, charges, payouts, requirements;
  Stripe owns the regulated UX surfaces. **Default.**
- **Custom.** Operator builds onboarding UX, dashboard,
  dispute UX, evidence submission UX. Compliance burden is
  significant (KYC collection UX is regulated; the OFAC /
  PEP / sanctions checks live behind it). Rejected for MVP
  on cost-of-build grounds; reconsider only if Express UX
  becomes a real partner-experience blocker.

**Confirmed: Express.** Migration path from Express to Custom
later is non-trivial (the connected-account type cannot be changed
in place — partners would need to re-onboard) but is a known path
if the tradeoffs flip.

### Charge model — Destination charge, ratified

Doc 02's table compared Direct / Destination / Separate
charges-and-transfers on MoR, refund/dispute liability, and
fee mechanism.

- **Direct charge on connected account.** Partner is MoR;
  partner owns refund / dispute liability; operator's fee is an
  application fee. Pro: clean partner-side accounting. Con:
  fragments the operator's reporting (tenant pays "the partner"
  not "the platform"); makes the operator's VAT picture more
  awkward in DACH; gives partners more autonomy than the
  operator wants for a marketplace this regulated. Rejected.
- **Destination charge on platform, transfer to connected
  account.** Operator is MoR; refund / dispute liability sits on
  the platform; fee is `application_fee_amount` on the
  PaymentIntent. Pro: clean operator-side reporting; matches the
  mental model that the tenant is paying "the platform" which
  forwards funds; supports the platform-fee VAT picture cleanly.
  **Default.**
- **Separate charges and transfers.** Operator captures full
  charge, then transfers asynchronously. Maximum control but
  also maximum operational surface (transfer scheduling, failure
  handling, reconciliation). Useful for milestone-based payouts
  where charge and transfer are not 1:1. Considered but rejected
  for the default — the marketplace pattern is per-payment 1:1
  with the partner, which destination charge handles natively.

**Confirmed: destination charge.** The schema in doc 05
(`Payment` with `agreementId`, `partnerId`, `platformFeeId`)
matches this model.

If the marketplace later needs milestone payouts (charge happens
once, payouts staggered over months), separate-charges-and-transfers
becomes the right model for that subset of payments. The schema
admits both — `Payment.kind` covers `charge` / `payout` / `refund`
/ `dispute` and the `railsExternalId` carries either a charge ID
or a transfer ID. Decide when the use case is real.

### Merchant of record, locked by destination charge

Destination charge places the **operator** as MoR on the
tenant→platform leg. The implications confirmed:

- The operator collects payment from the tenant.
- The operator is liable for refunds and disputes on that
  payment.
- The operator's revenue (the application fee) is a separate
  VAT event from the underlying transaction. Per doc 02, the
  operator likely needs to issue a VAT-compliant invoice for
  the platform fee.
- The underlying service / goods transaction (between partner
  and tenant) is a separate VAT event. In B2B reverse-charge
  jurisdictions this is typically the partner's responsibility
  to invoice; the operator does not handle this VAT, but does
  need to surface enough data for the partner / tenant to do
  so. **External tax-advisor review still required** per doc 02.

## Connected-account onboarding

The tenant invites a partner; the partner completes Stripe-hosted
onboarding; the operator stores the connection.

### Flow (sequence)

```
Tenant      Operator API     Stripe         Partner
  │             │               │              │
  │ invite ────►│               │              │
  │             │ create connected acct ──────►│
  │             │◄──── account_id              │
  │             │                              │
  │             │ create Account Link ────────►│
  │             │◄──── onboarding URL          │
  │             │ send invitation email ──────►│
  │             │                              │
  │             │                       Partner clicks link
  │             │                       Stripe-hosted onboarding
  │             │                       (KYC, banking, terms)
  │             │                              │
  │             │◄──── account.updated webhook ┤
  │             │ (charges_enabled = true,      │
  │             │  payouts_enabled = true)     │
  │             │                              │
  │             │ persist PayoutAccount        │
  │             │ + PayoutAccountStripeConnect │
  │             │                              │
  │ "ready" ────┤                              │
```

### Account Links vs. Account Sessions

Stripe ships two primitives for the onboarding redirect: classic
Account Links (URL the partner is redirected to) and the newer
Account Sessions (embedded onboarding component the operator's app
renders inline). Trade-offs:

- **Account Links** — simpler integration; full-page redirect
  away from the operator's app; partner sees Stripe branding more
  prominently.
- **Account Sessions / Connect Embedded Components** — keeps the
  partner inside the operator's UI; better branding control;
  more frontend work.

**Recommendation: Account Links for MVP.** Embedded components are
preferable from a UX standpoint but the integration cost is real
and the partner will be on Stripe's hosted form for the regulated
sections regardless. Worth revisiting once v1 is out.

### Country selection

Each connected account has a country, set at creation, immutable.
Onboarding flow must capture the country before account creation —
either from the tenant's invitation form (if the tenant knows) or
from the partner during onboarding (if not). Implication: the
operator's tenant-side invite UI needs a country picker.

DACH/EU scope: DE / AT / CH / and the broader EU country list.
Partners outside this set should not be onboardable until the
operator has cleared the regulatory / tax / payouts implications
for that country. Country whitelist enforced at the operator side.

### Re-onboarding (KYC expiry, requirements outstanding)

Stripe surfaces account-side requirements via the `requirements`
object (currently_due, eventually_due, past_due,
disabled_reason). When a webhook indicates new requirements:

- Operator surfaces the partner-side prompt in the tenant CRM
  (doc 05's partner detail view) — "this partner needs to update
  KYC."
- Operator generates a fresh Account Link and presents to the
  partner.
- `disabled_reason = "requirements.past_due"` blocks new payments
  to the partner; doc 04's marketplace-ops dashboard surfaces
  this as a "stuck KYC" alert (one of the 10 core views).

### Onboarding state in the schema

`PayoutAccount` (per-tenant) carries the rails-neutral state:
status, KYC status, country, currency, default flag. The
Stripe-specific `PayoutAccountStripeConnect` (operator-shared)
carries:

```
PayoutAccountStripeConnect
├── payoutAccountId (PK / FK → PayoutAccount.id)
├── tenantId
├── stripeAccountId          (UNIQUE)
├── chargesEnabled
├── payoutsEnabled
├── detailsSubmitted
├── disabledReason           (nullable)
├── requirementsCurrentlyDue (JSONB)
├── requirementsPastDue      (JSONB)
├── lastWebhookAt
├── createdAt / updatedAt
```

The `stripeAccountId` is the operator's lookup key for inbound
webhooks — the webhook handler resolves it to the owning tenant
via this row's `tenantId`.

## Payment lifecycle

A tenant pays a partner. End-to-end:

```
Tenant UI         Operator API         Stripe
   │                   │                  │
   │ "pay €500" ──────►│                  │
   │                   │ validate:         │
   │                   │  - agreement active
   │                   │  - partner KYC OK
   │                   │  - currency match
   │                   │  - fee calc → €25 (5%)
   │                   │                  │
   │                   │ PaymentIntent ───►│
   │                   │  amount=50000     │
   │                   │  application_fee_amount=2500
   │                   │  transfer_data.destination=acct_X
   │                   │  metadata={...}   │
   │                   │◄── pi_id, client_secret
   │                   │                  │
   │ render 3DS ◄──────┤                  │
   │                   │                  │
   │ confirm ──────────────────────────►│ │
   │                   │                  │
   │                   │◄── webhook       │
   │                   │  payment_intent.succeeded
   │                   │  charge.succeeded
   │                   │                  │
   │                   │ persist Payment + PlatformFee
   │                   │ emit "payment confirmed" event
   │ "paid" ◄──────────┤                  │
```

Validation checks before creating the PaymentIntent:

- Agreement is in `active` status.
- Partner's connected account has `charges_enabled = true` and
  `payouts_enabled = true`.
- Currency on the payment matches the agreement's currency
  (mismatched currency requires explicit FX handling — punt).
- Idempotency key (operator-generated, e.g. UUID stored on the
  Payment row) is fresh.
- Fee calculation: `applyFeeRate(amount, agreement.rateModel)` →
  `application_fee_amount`. See "Application-fee mechanism" below.

The PaymentIntent carries metadata that ties Stripe-side data
back to operator-side records:

```
metadata: {
  trellis_payment_id: "...",
  trellis_tenant_id: "...",
  trellis_partner_id: "...",
  trellis_agreement_id: "...",
}
```

This metadata flows through to subsequent webhooks (charge,
refund, dispute) and is the cross-reference that lets the
operator resolve any Stripe event to the right operator-side
records without a join through the connected-account ID.

## Application-fee mechanism

The fee per payment is `application_fee_amount` in the smallest
currency unit (cents for EUR, etc.). Operator computes this at
PaymentIntent creation time from:

```
applyFeeRate(amount, rateModel) → fee_amount
```

`rateModel` is a JSONB field on Agreement (per doc 05). MVP
shapes the operator likely needs:

- `{ kind: "percentage", rate: 0.05 }` → 5% of amount
- `{ kind: "flat", amount: 250 }` → flat fee (in smallest unit)
- `{ kind: "hybrid", rate: 0.03, flat: 100 }` → % + flat
- `{ kind: "tiered", tiers: [...] }` → volume-tiered (defer
  per-payment computation; aggregate elsewhere)

Edge cases:

- **Minimum / maximum fee.** Most agreements specify a floor
  (operator's economics) and rarely a ceiling. Encode in
  `rateModel` as `{ ..., min: 100, max: 5000 }`.
- **Currency rounding.** Compute in the smallest unit; floor to
  integer; document whether floor or round-half-up. Floor is
  conservative for the partner.
- **Currency mismatch.** Defer — agreements specify a currency
  and payments must match.
- **Recovery from a misconfigured rate.** A wrong fee on an
  already-captured charge is corrected by issuing a partial
  application-fee refund. Stripe's API supports this. The
  operator-side flow is: file a correction, append a
  PlatformFee row with the negative delta, link to the
  original PlatformFee.

## Webhook ingestion

The webhook handler is the load-bearing surface. Doc 04's
marketplace-ops dashboard reads the tables this populates; doc 05's
Payment / PlatformFee semantics depend on what this writes.

### Endpoint and verification

- One webhook endpoint per Stripe environment
  (test / live). Operator owns the URL.
- Stripe signs every event with a webhook secret; signature
  verification is the first thing the handler does. Reject on
  failure with 400.
- Endpoint accepts both platform-account events
  (`account.updated`, `payout.failed`, etc.) and
  Connect-account events (`payment_intent.succeeded`,
  `charge.dispute.created`) where relevant.

### Inbox pattern (idempotent persistence)

The handler does **not** process events synchronously. It
persists the raw event to an inbox table and returns 200; a
worker drains the inbox.

```
StripeWebhookEvent
├── id (PK)
├── stripeEventId (UNIQUE)
├── eventType
├── apiVersion
├── livemode
├── payload (JSONB)
├── receivedAt
├── processedAt (nullable)
├── attemptCount
├── lastError (nullable)
```

`stripeEventId` UNIQUE means duplicate deliveries (Stripe retries,
ALB retries, network glitches) collapse to a no-op — the second
INSERT fails with a unique-violation, and the handler returns 200.

This is the "Stripe is idempotent on event_id, the operator
should be too" property in concrete form. Stripe explicitly
recommends this pattern.

### Worker / processor

A separate worker (cron or queue-driven) drains
`StripeWebhookEvent WHERE processedAt IS NULL`:

- Looks up the event type, dispatches to a handler.
- Handler resolves the operator-side record(s) via metadata or
  connected-account ID.
- Writes Payment / PlatformFee / PayoutAccount mutations.
- Sets `processedAt` on success; increments `attemptCount` and
  records `lastError` on failure.
- Backoff on retries; alert on exceeding `max_attempts`
  (deferred to operator-side incident handling).

### Out-of-order tolerance

Stripe webhooks arrive in approximate order, not guaranteed
order. `payment_intent.succeeded` may arrive after
`charge.succeeded`. Handlers must be robust:

- Each handler is an upsert against the operator-side record,
  not a strict insert.
- Handlers tolerate "operator-side row not yet present" by
  creating a stub row from metadata.
- Handlers tolerate "operator-side row already in a later
  state" by leaving it alone.

Concretely: if `charge.succeeded` arrives first and creates a
Payment row, the later `payment_intent.succeeded` is a no-op
that updates timestamps. If they arrive in the documented
order, the PaymentIntent handler creates the row and the charge
handler enriches it with charge-specific fields.

### Events to ingest (MVP set)

| Event | Effect on operator-side state |
|---|---|
| `account.updated` | Update PayoutAccountStripeConnect: charges_enabled, payouts_enabled, requirements, disabled_reason. Drives doc 04 KYC alerts. |
| `payment_intent.succeeded` | Upsert Payment to status=succeeded. |
| `payment_intent.payment_failed` | Upsert Payment to status=failed. |
| `charge.succeeded` | Enrich Payment with charge_id; upsert PlatformFee. |
| `charge.refunded` | Append Payment row of kind=refund (negative); append PlatformFee negative delta if application fee refunded. |
| `charge.dispute.created` | Append Payment row of kind=dispute; trigger doc 04 real-time alert. |
| `charge.dispute.closed` | Update dispute Payment row's status (won / lost). |
| `payout.failed` | Surface partner payout failure on doc 04 dashboard. |
| `payout.paid` | Update PayoutAccount last-payout timestamp. |
| `application_fee.refunded` | Append PlatformFee negative delta. |

This is the MVP set. The full Stripe event catalogue has dozens
more events; ingest only what affects operator-side state. Add
on demand.

### Webhook → real-time alerting

Doc 04's real-time alerts (dispute opened, payment failure spike,
KYC blocker, payout failure) are emitted by the worker when it
processes the corresponding event. Two delivery shapes:

- **Synchronous alert** for individual high-severity events
  (dispute opened) — emit to the operator's alerting channel
  (Slack / PagerDuty) in the same worker run.
- **Aggregate alert** for spike detection (failed-payment rate
  over a window) — a separate scheduled job that reads the
  Payment table.

## Refund and dispute flows

### Refund

A refund can be initiated by the tenant (full / partial against a
specific Payment) or programmatically by the operator (e.g.
service issue). Flow:

```
Initiator      Operator API        Stripe
   │              │                   │
   │ refund ─────►│                   │
   │              │ validate          │
   │              │ create refund ───►│
   │              │◄── refund_id      │
   │              │                   │
   │              │◄── webhook        │
   │              │ charge.refunded   │
   │              │ application_fee.refunded (if applicable)
   │              │                   │
   │              │ append Payment(kind=refund, neg amt)
   │              │ append PlatformFee neg delta
   │  ack ◄───────┤                   │
```

Default behaviour on destination charge: the application fee is
**also refunded** unless the operator opts out. Three configurable
behaviours:

- **Full refund, fee returned.** Default. Most consumer-friendly.
- **Full refund, fee retained.** Operator absorbs the fee gap by
  explicitly setting `refund_application_fee=false`. Painful for
  the partner (they're out the original fee on a refunded
  charge); use sparingly.
- **Partial refund, proportional fee returned.** Operator
  computes the fee delta and refunds proportionally.

Default for MVP: refund the application fee on full refunds,
proportional on partial. Tenant-configurable per agreement is a
plausible v2 feature.

### Dispute (chargeback)

A tenant disputes a charge through their card issuer. Flow:

- Stripe receives the dispute notification, emits
  `charge.dispute.created`.
- Operator receives the webhook, appends a `Payment(kind=dispute)`
  row, surfaces it on doc 04's dispute alert and doc 05's
  partner detail view.
- Stripe deducts the disputed amount from the operator's
  available balance immediately (the operator is MoR).
- Operator submits evidence via Stripe API or dashboard within
  the response window.
- Stripe emits `charge.dispute.closed` with the outcome.
  - **Won:** operator's balance is restored; no operator-side
    schema change beyond updating dispute Payment status.
  - **Lost:** the disputed amount stays deducted; operator's
    revenue (PlatformFee) on the original charge may also be
    clawed back; the partner's payout is reversed (Stripe
    handles).

The operator absorbs the dispute fee (~€15 per dispute on EU
card payments — varies). This is a cost line item on the
operator's side, not a partner-facing cost.

Evidence submission UX: deferred. Express dashboard provides a
basic flow; the operator can build a custom evidence-collection
UX if dispute volume justifies. MVP: route disputes to the
operator's ops queue, submit through the Stripe dashboard
manually.

## Failure modes and operational concerns

### Stripe outage

Stripe outages are rare but real. Behaviour:

- **PaymentIntent creation fails** → operator returns an error
  to the tenant; tenant retries. No state mutation occurred.
  No queueing of intents. Adding a "queue while Stripe is down"
  layer is more reliability surface than it's worth at MVP.
- **Webhook delivery fails on operator side** (operator's
  endpoint returns 5xx or times out) → Stripe retries with
  exponential backoff for up to 3 days. The inbox pattern
  ensures replays are no-ops once the endpoint recovers.
- **Webhook delivery fails on Stripe side** (Stripe drops or
  delays an event) → an out-of-band reconciliation job (daily)
  pulls events for the last 48 hours via the Stripe API and
  inserts any missing ones. The unique constraint on
  `stripeEventId` makes this safe.

### Idempotency-key collision

The operator-side idempotency key (UUID stored on Payment row)
is used as Stripe's `Idempotency-Key` header on PaymentIntent
creation. A collision (same key reused for a different
PaymentIntent) is a programming error; Stripe returns the
original PaymentIntent's response, which is wrong for the new
attempt. UUIDs make this practically impossible; defensive
check at insert time is still cheap.

### Currency mismatch

A tenant pays in EUR, the partner's PayoutAccount is in CHF, the
agreement is in EUR. Stripe converts at payout time at Stripe's
FX rate (subject to a spread). This is a partner-facing cost —
the partner receives less than the application-fee math would
suggest. Two decisions:

- **Constrain at agreement time.** Enforce that the
  PayoutAccount currency matches the agreement currency.
  Cleanest. Loses some flexibility.
- **Surface FX cost at payment time.** Show the tenant and
  partner the expected FX cost before confirming. More flexible,
  more UX work.

MVP: constrain. Loosen when partners or tenants ask.

### Reconciliation

Daily reconciliation job:

- Pulls Stripe balance transactions for the trailing 48 hours.
- Joins to operator-side Payment / PlatformFee rows by
  `railsExternalId`.
- Reports any orphans on either side (Stripe txns without
  operator-side rows; operator-side rows without Stripe txns).
- Surfaces orphans on doc 04's marketplace-ops dashboard as
  data-quality alerts.

This catches: dropped webhooks, stuck inbox rows, schema bugs.

## Schema extensions (full Stripe-side)

Consolidating the rails-extension tables that this doc adds /
specifies, in addition to doc 05's core schema:

| Table | Placement | Purpose |
|---|---|---|
| `PayoutAccountStripeConnect` | Operator-shared (`tenantId`) | Stripe account state per partner. UNIQUE on `stripeAccountId`. |
| `StripeWebhookEvent` | Operator-shared | Inbox table for idempotent webhook ingestion. UNIQUE on `stripeEventId`. |
| `PaymentRailsExtension` (Stripe row, per Payment) | Operator-shared | `paymentIntentId`, `chargeId`, `transferId`, `disputeId` (nullable). |

These are all operator-shared because Stripe identifies entities
by its own IDs without operator-side context, so cross-tenant
lookups are needed at webhook resolution time.

Per doc 02's China-readiness directive: the rails-extension table
pattern means adding Alipay later is **a new table**
(`PayoutAccountAlipay`, `PaymentAlipayExtension`,
`AlipayWebhookEvent`), not a migration to existing ones. The
core `Payment` and `PayoutAccount` tables stay rails-neutral.

## Rails-abstraction interface

Doc 02's open question: *"How thin can the rails abstraction be
before it becomes either a leaky proxy for Stripe Connect or an
over-engineered framework?"* Concrete proposal: a typed
discriminator with a small interface, per rails:

```typescript
interface RailsProvider {
  // Onboarding
  createConnectedAccount(input: {
    country: string;
    currency: string;
    tenantId: string;
    partnerId: string;
  }): Promise<{ railsAccountId: string }>;

  generateOnboardingLink(input: {
    railsAccountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string }>;

  // Payments
  initiatePayment(input: {
    railsAccountId: string;
    amount: bigint;
    currency: string;
    applicationFeeAmount: bigint;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ railsPaymentId: string; clientSecret?: string }>;

  refundPayment(input: {
    railsPaymentId: string;
    amount?: bigint;
    refundApplicationFee: boolean;
  }): Promise<{ railsRefundId: string }>;

  // Webhooks
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
  parseWebhookEvent(rawBody: string): NormalisedEvent;
}
```

The interface is **deliberately small**. It does not abstract
over the entire Stripe surface; it abstracts over the operations
the operator-side application actually performs. Stripe-specific
behaviour outside this interface (advanced reporting,
Express-dashboard URL generation, Stripe Tax integration) lives
in Stripe-specific code paths called only from the Stripe
implementation.

`NormalisedEvent` is a narrow shape: kind, externalId, accountId,
amount, currency, metadata. Every rails implementation maps its
native event shape into this, and the operator-side worker
dispatches on `kind`. Adding Alipay means writing
`AlipayRailsProvider` and an `AlipayWebhookEvent` inbox; the
operator-side processing logic can be largely unchanged.

This is **the** deliverable for the China-readiness
architectural directive. Without this interface, Stripe leaks
into every payment path; with it, Stripe is one of N
implementations.

## Open questions

1. **Account Sessions / Embedded Components vs. Account Links.**
   MVP recommendation is Account Links; Embedded improves UX but
   is more frontend integration. Revisit post-v1.
2. **Stripe Tax integration for platform-fee VAT.** Likely yes
   for DACH/EU, but depends on tax-advisor review of the MoR
   model. Defer until that review lands.
3. **Currency support at MVP.** EUR + CHF for DACH; GBP for
   non-EU EU; USD for cross-border partners. Each FX corridor
   adds complexity. CNY/CNH deferred.
4. **Subscription-billing patterns.** Doc 02 framed the model
   as ad-hoc transaction fees; some tenants may want recurring
   payments to partners (retainers). Stripe supports this via
   subscriptions on connected accounts. Out of scope for MVP;
   note for the recommendation doc.
5. **Custom dispute evidence UX.** MVP routes disputes through
   the Stripe dashboard manually. Custom evidence-submission UX
   only when dispute volume justifies.
6. **Reverse-charge VAT mechanics for B2B partner→tenant.** Out
   of scope for the rails design; flagged for tax advisor.
7. **Express dashboard branding limits.** Stripe-hosted; some
   colour / logo customisation; not full operator branding.
   Acceptable for MVP; revisit if partner-experience research
   says it matters.
8. **Maximum number of rails implementations the abstraction
   should anticipate.** Two (Stripe + one Chinese rail) seems
   right at the architectural level. Three+ is speculative;
   don't design for it.

## What this doc deliberately does not decide

- Bucket 1 dashboard layout / wireframes (doc 04 sketches the
  10 views; rendering is downstream).
- Bucket 2 application surface (doc 05 owns).
- Fee structure choice (doc 08).
- VAT / DAC7 compliance choices in detail (external advisor).
- Pricing or packaging.
- The synthesis recommendation (doc 09).
- China-specific rails implementation detail (doc 10).
- The exact operator-side queue / worker technology (cron
  vs. SQS vs. Postgres-LISTEN). All viable; choose at
  implementation time based on existing Trellis-core
  primitives.
