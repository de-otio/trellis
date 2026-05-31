# Identity Federation

**Status:** design — not yet implemented
**Created:** 2026-05-02
**Owner:** Richard
**Companions:** [`architecture/05-auth.md`](../architecture/05-auth.md) (base Cognito design)

> **Where this lives.** Identity federation, multi-tenancy, and tenant-scoped roles are **trellis framework capabilities** — not specific to any one product built on trellis. This folder is the canonical design. Concrete deployment plans (CDK, frontend wiring, dogfood) live in the *consuming product's* repo. The first consumer is [Trellis](https://github.com/de-otio/trellis); product-side rollout details live in `trellis/doc/02-technical/architecture/identity-federation-adoption.md`.

## What this is

How a trellis-based product identifies tenants, federates with their identity providers, and enforces tenant-scoped roles and permissions. **Critical capability for any multi-tenant trellis deployment.** The first consumer (Trellis) drove the design: de otio is its first tenant and will federate with Microsoft Entra ID. Onboarding must be self-service end-to-end — no human in the loop on the product-vendor side.

## MVP scope (read this first)

**MVP delivers Microsoft Entra ID via OIDC only.** Schema, Cognito setup, and Lambda triggers are designed IdP-agnostic so that adding Okta, Google Workspace, Auth0, generic SAML, etc. is a Phase 2 increment with no rework — but **none of those are MVP-scope**. The first paying tenant (de otio) uses Entra; that's the only path we test, document, and ship Flutter UI for in MVP.

This narrows what needs to ship while keeping the architecture future-proof. See [08-mvp-scope.md](./08-mvp-scope.md) for the explicit acceptance cut.

## Why now

The first product on trellis (Trellis) needs multi-employee B2B tenants — solo-operator-only support is insufficient for a real B2B vertical. Trellis's MVP plan includes de otio + Entra as its alpha tenant; that's the dogfood that drives this design. Trellis's v0.7 release ships the framework features so Trellis can integrate. See [08-mvp-scope.md](./08-mvp-scope.md) for the framework-feature cut and the consuming-product MVP perspective.

## Guiding principles

These are non-negotiable and override conflicting design considerations elsewhere in this folder. Every decision in the design must be checkable against this list.

### P1. Security is not a price point.

**Every tenant — solo operator, mom-and-pop business, mid-size org, enterprise — gets the full security feature set for free.** That includes IdP federation, SAML, OIDC, SCIM (when it ships), audit log, MFA enforcement, authentication policies, tenant-scoped roles. We never paywall a security capability. If we monetize tenancy later it's on capacity, advanced workflow, or value-add features — never on "you have to pay extra to be secure."

This is the explicit philosophical break from Atlassian (and Slack, Notion, GitHub, most of the SaaS industry). Atlassian Guard at $4/user/mo for SAML SSO is exactly the pattern we refuse to copy. The reasoning is simple: tenants who can't afford the security tier still represent attack surface that puts *their* users at risk and reflects on us. Making security free is both right and load-bearing for our reputation.

### P2. IT-friendly onboarding for the influential customers.

The most lucrative customers (mid-to-large businesses) have internal IT teams. **Internal IT is influential** — they kill or champion vendor adoption. Onboarding has to feel respectful of how they actually work:

- **Bring-your-own-IdP, standard protocols.** SAML 2.0 and OIDC, no custom nonsense. We adapt to their IdP, not the other way around.
- **Self-service end-to-end.** No "schedule a call with our sales team to enable SSO." An IT admin can verify their domain, connect their Entra/Okta/Google Workspace, define group-to-role mappings, and have employees signing in without ever talking to anyone at Trellis.
- **Test-before-enforce.** "Test sign-in" feature lets them validate the full federation chain (claim shape, group membership, role mapping) with a single test user before flipping it on for the org.
- **Predictable, documented endpoints.** ACS URL, redirect URI, entity ID — fixed, copy-pasteable, identical for every tenant.
- **Per-IdP setup walkthroughs in our docs** — Entra, Okta, Google Workspace, Auth0, OneLogin. The walkthrough is a sequence of screenshots and exact values, not generic SAML theory.
- **Operational handles IT recognizes:** rotate client secrets, revoke individual sessions, see the audit log, export it, get notified on misconfiguration. They run their own playbooks; we don't ask them to learn ours.
- **No vendor lock-in.** Disconnect the IdP, the data stays. SCIM (when shipped) follows the standard.
- **Standard claim names.** `email`, `given_name`, `family_name`, `groups`. Their IdP has these by default; no asks for "please add a custom claim called `trellis_role`."

### P3. Compliance is a first-class design constraint, not an afterthought.

We design **for GDPR from day one** and structure the implementation so other compliance regimes (CCPA, UK GDPR, Australian Privacy Act) drop in cheaply. Concretely:

- **Right to access** — every piece of personal data we hold about a user is exportable in a structured format on demand.
- **Right to erasure** — full cascade-delete is designed-in, even if Phase 3 implements it.
- **Lawful basis** — we collect only what's needed for the federation to work; the privacy policy articulates each piece (email = identification, group memberships = role assignment, etc.).
- **Audit trail** — every administrative action on identity is logged with who/when/what; tenant admins can export their tenant's audit log.
- **Subprocessor transparency** — IdPs are subprocessors per Article 28. We surface the relationship in the tenant's settings (visible to their DPO).
- **Data minimization** — we don't store IdP claims we don't use. We don't log claim *values* (just claim *names* and resolution outcomes).
- **Cross-border** — region-aware tenant placement (EU customers' data stays in EU region) is supported by the existing region-routing architecture; federation respects it.
- **Breach posture** — audit log + structured event emission is what powers a 72-hour notification capability if it's ever needed.

The full GDPR mapping is in [07-security-and-isolation.md §GDPR-alignment](./07-security-and-isolation.md#gdpr-alignment).

### P4. Agent-driven setup and review are first-class.

The IT engineer at a mid-to-large tenant increasingly works with an AI agent (Claude Code, etc.). The agent is the *first* thing that sees Trellis's onboarding surface — and possibly the *only* thing during a security/compliance review. Trellis must be **agent-legible by design**:

- Every step a human can do via UI is also expressible as an idempotent API call with structured errors.
- Setup state is queryable: `GET /api/tenants/{id}/setup-status` tells the agent where it is in the flow without parsing prose.
- Compliance facts are publishable: `https://example.com/.well-known/compliance.json` answers _"does Trellis meet our requirements?"_ without a sales call.
- Discovery is standard: `/llms.txt`, `/openapi.json`, `/.well-known/compliance.json`, `/.well-known/openid-configuration`.
- Agent authentication uses **OIDC, not static API tokens.** Short-lived OAuth tokens via PKCE + localhost-listener (interactive) or device authorization grant (headless). Tenant admins revoke from the UI.
- Documentation includes both human walkthroughs (click-by-click in the IdP portal) and machine equivalents (Microsoft Graph API call sequences).

Two related doc bundles enumerate the design:

- [10-agent-friendly-onboarding.md](./10-agent-friendly-onboarding.md) — the agent-driven setup flow.
- [11-agent-friendly-compliance.md](./11-agent-friendly-compliance.md) — the agent-driven compliance review.

The implication for procurement velocity: an internal IT team that previously spent days getting a vendor green-lit can now do it in an afternoon with their agent. That's a B2B sales accelerator, not just a developer-experience nicety.

## Functional goals

These follow from the principles above:

1. **Self-service tenant onboarding.** Anyone can create a tenant. No human approval. No paid tier gating it.
2. **IdP federation as a free, first-class feature.** Architecture supports both SAML 2.0 and OIDC and any conformant IdP. **MVP ships Entra ID via OIDC only**; SAML and other IdPs (Okta, Google Workspace, etc.) are Phase 2 increments on top of the same machinery.
3. **Per-employee role granularity.** Different employees of the same tenant can have different roles; roles map from IdP groups so the tenant admin manages them in their existing IdP, not in Trellis.
4. **Single Cognito user pool serving everyone.** Consumer (B2C) users and tenant employees share one pool. No pool-per-tenant proliferation.
5. **No data leakage between tenants.** Every resource is tenant-scoped at the data layer; every API call enforces it.
6. **Painless dogfooding for de otio + Entra.** Phase 1 acceptance is "an Entra-managed de otio employee can log into Trellis, gets the right Trellis role from their Entra group membership, and can act within de otio's tenant boundary."
7. **Compliance-ready posture.** Audit log, data export hooks, subprocessor transparency, region-aware data placement — all live before a paying enterprise customer asks for them.
8. **Agent-driven setup and review.** Discovery surfaces (`/llms.txt`, `/openapi.json`, `/.well-known/compliance.json`), idempotent APIs with structured errors, OIDC-based agent auth (no static API tokens), and dual-format docs let an IT engineer's agent drive setup and compliance review end-to-end.

## Non-goals (for MVP)

- **Org/site separation** — Atlassian-style multi-site-per-org. Trellis has one app surface; one tenant = one Trellis instance. (Re-evaluate if we ever ship multiple products under one tenant.)
- **Multi-active-tenant sessions.** A user is "in" exactly one tenant at a time. Switching requires a token refresh.
- **Cross-tenant entity sharing.** A venue belongs to exactly one tenant; if a chain wants the same venue under multiple tenants, they create distinct entities.
- **SCIM provisioning.** Deferred to Phase 2 (see [06-just-in-time-provisioning.md](./06-just-in-time-provisioning.md) §SCIM-future).
- **Cognito user pool per tenant.** Rejected — operationally too heavy and unnecessary given Cognito's 300+ IdPs/pool default. See [04-cognito-federation.md](./04-cognito-federation.md) §Pool-topology-decision.
- **Tenant deletion.** Phase 3. MVP supports `SUSPENDED` status; full cascade-delete needs SQS plumbing.
- **Audit log retention beyond 30 days.** MVP keeps 30 days in CloudWatch Logs; longer retention is paid-tier later.

## How it differs from Atlassian

Atlassian's model was the explicit reference. To make the comparison honest, you need to know that Atlassian has **two different "log in via your IdP" paths**, only one of which is comparable to what we're building.

### Atlassian's two paths

| Atlassian feature | Protocol | Free? | What it actually does |
|---|---|---|---|
| **"Continue with Microsoft" / "Continue with Google"** | OAuth 2.0 / OIDC (a single Atlassian-owned enterprise app shared across all customers) | ✅ Free | Personal social-login. A user signs in with their Microsoft/Google account; Atlassian links the identity. **No per-tenant IdP isolation. No group-claim → role mapping. No authentication-policy enforcement. No audit log of SSO events. No SCIM.** |
| **Atlassian Guard Standard** ($4/user/mo) | SAML 2.0, per-org IdP | 💰 Paid | True org-level federation. The customer's IT admin connects *their tenant's* IdP, defines group-to-role mappings, can enforce SSO-only sign-in, gets SCIM, gets the audit log, gets domain-managed accounts. |

What Trellis is matching is the **paid Atlassian Guard feature set**, delivered for free.

### Side-by-side

| Concept | Atlassian — free (OAuth) | Atlassian — Guard Standard ($4/user/mo) | Trellis |
|---|---|---|---|
| Top-level container | Organization | Organization → Site | **Tenant** (flat) |
| Branded URL | `acme.atlassian.net` | `acme.atlassian.net` | `de-otio.example.com` (Phase 2) |
| Product instances | 1 of each per site | 1 of each per site | 1 (Trellis is one app) |
| Free tenant creation | ✅ | ✅ | ✅ |
| Domain verification (DNS TXT) | ✅ | ✅ | ✅ |
| Per-tenant IdP (BYO-IdP isolation) | ❌ (shared "Atlassian" Entra app) | ✅ | ✅ |
| SAML 2.0 federation | ❌ | ✅ | ✅ free |
| OIDC federation | (only the shared social-login app) | ✅ | ✅ free |
| Group claim → role mapping | ❌ | ✅ | ✅ free |
| Authentication policy (force SSO-only) | ❌ | ✅ | Phase 3 (free when shipped) |
| JIT user provisioning | (linked on social-login) | ✅ | ✅ free |
| SCIM provisioning | ❌ | ✅ | Phase 2, free |
| Audit log of SSO events | ❌ | ✅ | ✅ free, 30-day retention MVP |
| Domain-claim → managed accounts | ❌ | ✅ | ✅ free |
| Org/site billing | Free | Per-user, per-month | Free |

### The philosophical break

Atlassian's free OAuth path is convenient but not federation in the enterprise-IT sense — it's the same shared "Continue with Microsoft" app every Atlassian customer uses, with no tenant-side claim mapping or policy controls. Atlassian's *real* federation is paid (Guard).

**Trellis gives every tenant the equivalent of Guard Standard for free**, per [P1 (Security is not a price point)](#p1-security-is-not-a-price-point). The paid Atlassian feature is exactly the price point we refuse to make.

This is also why the spec asked for "different employees, different roles" mapped from the IdP — that's *only* available in Atlassian's paid Guard tier (where it's done via SAML group attributes), not in their free OAuth path. Free Continue-with-Microsoft can't deliver per-employee role granularity.

## Locked design decisions

These are settled (see linked docs for rationale):

| # | Decision | Where |
|---|---|---|
| 1 | Flat tenancy. No org/site. | [01-tenancy-model.md](./01-tenancy-model.md) |
| 2 | Single Cognito user pool, N IdPs (one per federated tenant) | [04-cognito-federation.md](./04-cognito-federation.md) |
| 3 | Tenant-scoped roles live in Postgres, not Cognito groups | [05-roles-and-permissions.md](./05-roles-and-permissions.md) |
| 4 | Single-active-tenant per session; tenant ID in JWT custom claim | [04-cognito-federation.md](./04-cognito-federation.md) §JWT-claims |
| 5 | Email-domain → IdP routing via discovery endpoint | [03-onboarding-flows.md](./03-onboarding-flows.md) §Sign-in-discovery |
| 6 | TXT-record domain verification | [03-onboarding-flows.md](./03-onboarding-flows.md) §Domain-verification |
| 7 | Architecture supports OIDC + SAML; **MVP ships Entra OIDC only**, SAML + other IdPs Phase 2 | [04-cognito-federation.md](./04-cognito-federation.md) §IdP-types |
| 8 | JIT in MVP; SCIM Phase 2 | [06-just-in-time-provisioning.md](./06-just-in-time-provisioning.md) |
| 9 | IdP groups → tenant roles via per-tenant mapping table | [05-roles-and-permissions.md](./05-roles-and-permissions.md) §Role-mapping |
| 10 | Pre-token-generation Lambda resolves tenant context with DynamoDB cache | [04-cognito-federation.md](./04-cognito-federation.md) §Pre-token-gen |
| 11 | Agent auth is OIDC-based (PKCE + localhost or RFC 8628 device-grant); **no static API tokens** | [10-agent-friendly-onboarding.md](./10-agent-friendly-onboarding.md) §MVP-2 |
| 12 | Compliance posture is published as machine-readable `compliance.json` at `/.well-known/` | [11-agent-friendly-compliance.md](./11-agent-friendly-compliance.md) |

## File index

| # | File | Contents |
|---|---|---|
| | [README.md](./README.md) | This file |
| 1 | [01-tenancy-model.md](./01-tenancy-model.md) | Tenant entity, hierarchy, isolation principles, lifecycle |
| 2 | [02-data-model.md](./02-data-model.md) | Prisma schema additions, ER diagram, migration strategy |
| 3 | [03-onboarding-flows.md](./03-onboarding-flows.md) | Sign-up, tenant creation, domain verification, IdP connect, member invite |
| 4 | [04-cognito-federation.md](./04-cognito-federation.md) | Cognito pool design, IdP CRUD, attribute mapping, Entra specifics, JWT shape |
| 5 | [05-roles-and-permissions.md](./05-roles-and-permissions.md) | Two-layer role model, capability catalog, IdP group mapping, route guards |
| 6 | [06-just-in-time-provisioning.md](./06-just-in-time-provisioning.md) | JIT user provisioning, deprovisioning, SCIM-future |
| 7 | [07-security-and-isolation.md](./07-security-and-isolation.md) | Threat model, tenant isolation guarantees, IdP secret handling, audit |
| 8 | [08-mvp-scope.md](./08-mvp-scope.md) | What ships in MVP vs Phase 2/3 |
| 9 | [09-implementation-plan.md](./09-implementation-plan.md) | Work breakdown, sequencing, risks |
| 10 | [10-agent-friendly-onboarding.md](./10-agent-friendly-onboarding.md) | Discovery surfaces, OIDC-based agent auth (PKCE + localhost / device authorization), idempotency, structured errors, sample agent transcript |
| 11 | [11-agent-friendly-compliance.md](./11-agent-friendly-compliance.md) | `compliance.json`, sub-processor disclosure, DPA, tenant-scoped compliance endpoint, JSON Schema |

## Quick read path

If you want the design in 15 minutes: README → 01 → 04 → 08.
If you're going to implement: read all in order.
