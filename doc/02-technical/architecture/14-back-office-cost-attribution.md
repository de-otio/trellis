# 14 — Back-office integration & cost attribution

A coordination note, not a build task. De Otio's back-office substrate
(**Quaestor**) treats Trellis-based products as **systems of record it
captures from** — spend, and eventually product metrics — per project
("entity": `de_otio`, `trellis`, …). Three cheap-now / expensive-later
alignments make that clean. None of them couples Trellis to Quaestor at
the code level; the coordination is *conventions and schema shapes*.

Identity stays as designed — Cognito with per-tenant federation
([`identity-federation/04-cognito-federation.md`](../identity-federation/04-cognito-federation.md)).
Quaestor reads data through a read-only role; it never sits in the
auth path.

## 1. Adopt the house cost-allocation tagging

Today there is **no cost-allocation-tag scheme** — [`12-cost-estimates.md`](12-cost-estimates.md)
is per-instance, and cost protection is the 9-layer guardrail set, not
attribution. The fleet runs across many AWS accounts under one
Organisation, and Quaestor attributes spend per project.

- Use the **`@de-otio/saas-foundation-cdk` tagging aspect** so every
  resource carries `CostCenter` set to the project value from the house
  cost-center vocabulary (see `saas-foundation` `doc/13-cost-attribution-conventions.md`).
  The CDK lives in **Trellis**, not here ([`08-cdk-structure.md`](08-cdk-structure.md)),
  so the aspect is applied in Trellis's stacks — Trellis ships the
  Lambda source; Trellis owns deployment and therefore the tags.
- Account placement: keep the project's accounts (`Trellis-dev-*` /
  `Trellis-prod-*`) under the project's OU, single-project where
  practical, so attribution is structural; shared accounts fall back to
  the `CostCenter` tag.
- `CostCenter` (which house project) is **orthogonal** to `tenantId`
  (which end customer). Don't conflate them.

## 2. Reserve a read-only operational-stats surface (don't build it yet)

When a "Trellis product metrics" capture process eventually lands,
Quaestor will want a **read-only, OAuth client-credentials,
`since=`-cursored, EU-region operational-stats** endpoint — the Tier-A
shape any clean billing/stats source offers. Trellis already has the
bones: OpenAPI 3.1 at `/openapi.json`, per-tenant admin / audit /
compliance endpoints, and an agent-authorization path. The only gap is
a documented read-only *operational-stats* route plus a machine
principal scoped to it.

**Reserve the route shape and the auth scope now; build when asked.**
Trellis may not need monitoring yet — but reserving the seam keeps it
Tier-A instead of forcing a scrape later. Cost now ≈ zero.

## 3. Align the financial-primitive schema *shapes* before coding

The Stripe-Connect operator design in [`../../../analysis/crm/`](../../../analysis/crm/README.md)
(`Partner` / `Payment` / `PlatformFee` / `TaxArtifact`, ZUGFeRD / DAC7)
is the **issuer-side mirror** of Quaestor's invoice schema and its
issuer-side wishlist (`quaestor` repo,
`doc/processes/invoice-automation/trellis-issuer-handoff.md`). **Both
are still design-only**, and money-movement schemas are the most
expensive thing to retrofit.

Coordinate the **field shapes** — the ZUGFeRD field set, the audit-log
shape (timestamp / principal / entity / counterparty / action /
outcome), and the project/`entity` tag — across the two designs before
either is coded. Shapes shared, **not code**: no `@de-otio/quaestor-*`
import, no shared package. During incubation Trellis's revenue and cost
land on De Otio's books tagged `entity = trellis`, so the data flow is
real.

## Non-goals

- No Quaestor code dependency, no shared package, no event hook wired
  into Quaestor.
- Identity stays Cognito / per-tenant federation; Entra (Quaestor's
  IdP) is a separate boundary.
- Quaestor reads; it does not deploy, scale, or operate Trellis or
  Trellis.

The consumer-side rationale and the full fleet picture live in the
`quaestor` repo at `doc/analysis/fleet-integration.md` (De Otio
internal).
