# T8 — Sign-in Discovery + Routing

**Recommended model:** Sonnet 4.6
**Effort:** ~2 days
**Depends on:** T4 (verified domains), T5 (active IdP)
**Blocks:** publish gate G4
**Branch:** `feat/T8-signin-routing`

## Goal

The `/api/auth/discover` endpoint that takes an email and returns either an IdP-redirect URL or a fall-through password-form indicator.

## Design reference

[`doc/02-technical/identity-federation/03-onboarding-flows.md §sign-in-discovery-endpoint`](../../doc/02-technical/identity-federation/03-onboarding-flows.md#5-employee-first-login-jit)

## Scope

### In scope

1. **Route:** `POST /api/auth/discover {email}`.
2. **Lookup:** join on `tenant_domains.domain == email-domain AND verifiedAt IS NOT NULL` + `tenant_identity_providers.status = ACTIVE`.
3. **Response:**
   - Federated: `{ method: "idp", idpRedirect: "https://auth.{deployment-domain}/oauth2/authorize?identity_provider=...", tenantSlug }` (the Cognito hosted-UI domain is configured by the consuming deployment).
   - Not federated: `{ method: "password" }`.
4. **No information leakage:** the endpoint only reveals whether the email's *domain* is claimed by a federated tenant — not whether the email exists in Cognito.
5. **Rate limiting:** per source IP (anti-enumeration).

### Out of scope

- Multiple IdP support per tenant (Phase 2).
- IdP-initiated SSO (Cognito handles this; no trellis endpoint needed).

## Acceptance criteria

- [ ] Email at federated domain → method=idp + correct redirect URL.
- [ ] Email at unfederated domain → method=password.
- [ ] Email at malformed domain (or not an email) → 400.
- [ ] Rate-limit at 30 req/min per IP → 429 with Retry-After.
- [ ] No leak: email domain that's claimed but with `IdpStatus=DISABLED` returns method=password (same as unfederated).

## Test requirements

### Coverage floor

- **Handler:** 90% lines.

### Required tests

1. Federated → idp.
2. Unfederated → password.
3. Disabled IdP → password (no leak).
4. Malformed input → 400.
5. Rate-limiter test.
6. No-leak test: timing-safe (response time within 50ms variance for federated/unfederated).

## Files to add/modify

| File | Action |
|---|---|
| `apps/api/src/lib/routes/auth-discover.ts` | new |
| `apps/api/src/lib/auth/idp-redirect-builder.ts` | new |
| `apps/api/test/routes/auth-discover.test.ts` | new |

## Security considerations

- [ ] Timing-safe lookup to avoid email-enumeration via response-time analysis.
- [ ] Rate-limit per source IP, not per email (else attacker probes).
- [ ] `idpRedirect` URL is signed/scoped; agent cannot inject arbitrary IdP names.

## Definition of done

All acceptance criteria checked. PR reviewed, merged to integration branch.
