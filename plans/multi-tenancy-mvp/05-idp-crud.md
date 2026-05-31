# T5 — IdP CRUD (OIDC for MVP)

**Recommended model:** **Opus 4.7** (security-critical, Cognito SDK integration, secret handling)
**Effort:** ~5 days
**Depends on:** T1 (schema), T3 (auth context), T4 (verified domain required)
**Blocks:** consuming-app stages — S4 (settings IdP page), S7 (Entra walkthrough), S8 (dogfood)
**Branch:** `feat/T5-idp-crud`

## Goal

Implement the IdP CRUD endpoints for the Cognito user pool. MVP scope is **OIDC only**, with Entra ID as the validated target. SAML branch is stubbed for future.

## Design reference

- [`doc/02-technical/identity-federation/04-cognito-federation.md`](../../doc/02-technical/identity-federation/04-cognito-federation.md) §IdP-CRUD-via-the-SDK
- [`doc/02-technical/identity-federation/03-onboarding-flows.md §4`](../../doc/02-technical/identity-federation/03-onboarding-flows.md#4-idp-connect-oidc-and-saml)

## Scope

### In scope

1. **Routes:**
   - `POST /api/tenants/{id}/identity-provider {kind:OIDC, issuerUrl, clientId, clientSecret, defaultRole}` — create IdP.
   - `GET /api/tenants/{id}/identity-provider` — read (clientSecret never returned).
   - `PATCH /api/tenants/{id}/identity-provider` — update (rotate secret, change attribute mapping, change defaultRole).
   - `DELETE /api/tenants/{id}/identity-provider?confirm=true` — disconnect.
   - `PATCH /api/tenants/{id}/identity-provider {status: DISABLED|ACTIVE}` — toggle.
2. **Cognito SDK integration:**
   - `CreateIdentityProviderCommand` (OIDC).
   - `UpdateIdentityProviderCommand`.
   - `UpdateUserPoolClientCommand` to add/remove from `SupportedIdentityProviders`.
   - `DeleteIdentityProviderCommand`.
3. **Secrets Manager integration:**
   - `CreateSecretCommand` on IdP create; tag with `tenantId`.
   - `PutSecretValueCommand` on rotation.
   - `DeleteSecretCommand` on disconnect.
   - Rollback on Cognito failure (delete secret if Cognito create fails).
4. **OIDC issuer probe:**
   - GET `{issuerUrl}/.well-known/openid-configuration` before commit.
   - Reject if 404, malformed, or required endpoints missing.
5. **`cognitoIdpName` generation:**
   - `tenant-{first-12-chars-of-cuid}`. 32 char Cognito limit verified.
6. **`IdpIdentifiers`** populated with verified domains for SP-initiated routing.
7. **Attribute mapping defaults** per [04-cognito-federation.md §attribute-mapping](../../doc/02-technical/identity-federation/04-cognito-federation.md#attribute-mapping).
8. **SAML branch stub:** `POST` with `kind=SAML` returns `501 Not Implemented {error: "SAML_NOT_AVAILABLE_IN_MVP"}`. Schema is ready; UI hides it.

### Out of scope

- SAML metadata parsing (Phase 2).
- Multiple IdPs per tenant (Phase 2).
- Periodic auto-refresh of OIDC well-known config (Cognito does this).

## Acceptance criteria

- [ ] Connect Entra OIDC end-to-end against a real Entra dev tenant: 201 + Cognito IdP record present + secret in Secrets Manager.
- [ ] `clientSecret` never returned in any GET response.
- [ ] Issuer probe failure → 422 with remediation, no Cognito or Secrets Manager state created.
- [ ] Cognito create failure → Secrets Manager rolled back, RDS row not created.
- [ ] Update with new secret → Secrets Manager new version + Cognito UpdateIdentityProvider + RDS metadata refresh.
- [ ] Disable: 200 + Cognito IdP removed from `SupportedIdentityProviders` + status=DISABLED in RDS.
- [ ] Enable: symmetric.
- [ ] Delete with `confirm=true`: 200 + Cognito IdP record deleted + secret deleted + RDS row removed (cascade-deletes role mappings).
- [ ] Delete without `confirm=true`: 400 with remediation.
- [ ] SAML POST: 501 with `SAML_NOT_AVAILABLE_IN_MVP`.
- [ ] Cross-tenant isolation: tenant-B cannot connect/modify/delete tenant-A's IdP.
- [ ] No verified domain → POST IdP returns 422.
- [ ] **G3 gate review:** security-reviewer subagent.

## Test requirements

### Coverage floor

- **Handlers:** 85% lines, 80% branches.
- **Cognito SDK wrapper:** 90% lines.
- **Issuer-probe + secret handling:** 95% lines (security-critical).

### Required tests

1. Per-handler unit tests with `aws-sdk-client-mock` for Cognito + Secrets Manager.
2. Issuer-probe tests: real-Entra integration test, plus mocks for malformed / missing / network-error cases.
3. **Rollback tests:** simulated Cognito failure → secret deleted, RDS row absent.
4. Concurrent writes: two simultaneous creates race → exactly one wins, other returns 409.
5. SAML stub returns 501.
6. Cross-tenant isolation per quality.md.
7. **End-to-end test against Entra dev tenant** in CI (gated, expensive — runs on integration branch only).

## Files to add/modify

| File | Action |
|---|---|
| `apps/api/src/lib/routes/tenant-idp.ts` | new |
| `apps/api/src/lib/cognito/idp-sdk.ts` | new (SDK wrapper) |
| `apps/api/src/lib/cognito/issuer-probe.ts` | new |
| `apps/api/src/lib/secrets/idp-secrets.ts` | new (Secrets Manager wrapper) |
| `apps/api/src/lib/tenant/idp-name.ts` | new (`cognitoIdpName` derivation) |
| `apps/api/test/routes/tenant-idp.test.ts` | new |
| `apps/api/test/lib/idp-sdk.test.ts` | new |
| `apps/api/test/lib/issuer-probe.test.ts` | new |
| `apps/api/test/integration/entra-e2e.test.ts` | new (gated) |

## Security considerations

This is the most security-sensitive stage after T1 + T2. Security-reviewer subagent runs on this PR.

- [ ] Client secret only enters the system via the POST/PATCH body; immediately stored in Secrets Manager; never logged.
- [ ] Secrets Manager secret tagged with `tenantId`; IAM policy grants only `tenant/*` prefix.
- [ ] Issuer URL validated as HTTPS-only (no `http://`).
- [ ] Issuer URL hostname allowlist? **NO** — too restrictive; we want to support any IdP. Instead: the probe enforces well-known shape.
- [ ] No SSRF: issuer probe is a single HTTP GET with timeout 5s, response size limit 1MB; no redirects to internal hosts (deny private IP ranges per [RFC 6890](https://datatracker.ietf.org/doc/html/rfc6890)).
- [ ] Cognito errors mapped to 502 with safe message (don't leak Cognito-internal error text to caller).
- [ ] PII redaction in logs (issuer URL OK; client secret never).
- [ ] Audit-log emission for every IdP CRUD action (placeholder, real in T7).
- [ ] On delete, `AdminUserGlobalSignOut` issued for all tenant members of that tenant — tested.

## Definition of done

All acceptance criteria checked. PR reviewed at G3 (human + security-reviewer subagent), merged to integration branch.
