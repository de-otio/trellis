# T4 — Domain Verification (DNS TXT)

**Recommended model:** Sonnet 4.6
**Effort:** ~3 days
**Depends on:** T1 (schema), T3 (auth context + capability skeleton)
**Blocks:** T5 (IdP CRUD requires verified domain)
**Branch:** `feat/T4-domain-verification`

## Goal

Self-service DNS TXT-record domain verification. Tenant admin claims a domain, gets a token, adds the TXT record, hits verify, the API checks DNS and flips the verified flag.

## Design reference

[`doc/02-technical/identity-federation/03-onboarding-flows.md §3`](../../doc/02-technical/identity-federation/03-onboarding-flows.md#3-domain-verification)

## Scope

### In scope

1. **Routes:**
   - `POST /api/tenants/{id}/domains {domain}` — claim a domain, returns verification token.
   - `GET /api/tenants/{id}/domains` — list (returns hidden tokens for unverified-by-others).
   - `DELETE /api/tenants/{id}/domains/{domainId}` — remove (with safety check: not the only verified domain on a tenant with ACTIVE IdP).
   - `POST /api/tenants/{id}/domains/{domainId}/verify` — perform DNS lookup and flip verified.
2. **Domain validation:**
   - Lowercase normalization, IDN/punycode handling.
   - PSL check (no claiming `gmail.com`, `co.uk`, etc.).
   - No claims for the platform's own domain or its subdomains (the consuming deployment configures the protected apex/wildcard).
3. **TXT-record verification:**
   - Looks up `_trellis-verify.{domain}` via `node:dns/promises` `resolveTxt`.
   - Match `trellis-verify={token}` exactly.
   - Fail closed on NXDOMAIN, no records, network error.
4. **Token generation:** 128-bit hex via `crypto.randomBytes(16)`.
5. **Rate limiting:** 10 verify attempts per hour per `(tenantId, domain)`.
6. **Per-tenant uniqueness:** a domain claimed by another tenant returns 409 (without leaking which tenant).
7. **Token expiry** *(sec finding #5)*: verification tokens expire **7 days** after creation. After expiry, the `tenant_domains` row's `verificationToken` is invalidated; admin must re-claim (which deletes the old row and issues a new token). Verified domains have no expiry — only unverified pending tokens expire.
8. **Token regeneration on failure:** after 10 failed verify attempts in 24 hours, the token is rotated automatically (new `verificationToken` generated; old TXT value no longer accepted). Admin notified to update DNS.

### Out of scope

- Periodic re-verification cron (Phase 2).
- Apex/wildcard or sub-domain claims (Phase 2).

## Acceptance criteria

- [ ] Add domain → 201 + token + instruction.
- [ ] Re-add same domain (same tenant) → 200 with existing record (idempotent).
- [ ] Add domain claimed by another tenant → 409.
- [ ] Add `gmail.com` → 400 (PSL check).
- [ ] Verify with correct TXT → 200, `verifiedAt` set.
- [ ] Verify with missing TXT → 422 with `remediation`.
- [ ] Verify with wrong token → 422.
- [ ] Verify when DNS errors → 422 (not 500).
- [ ] Delete verified-only domain on a tenant with ACTIVE IdP → 409 with remediation.
- [ ] Rate limiter kicks in at 11th verify attempt within an hour → 429 with `Retry-After`.
- [ ] **Cross-tenant isolation tests:** auth-as-tenant-A cannot see/verify/delete tenant-B's domains.
- [ ] **Token expires after 7 days** *(sec finding #5)*: attempting to verify with an expired token returns 422 with `remediation` instructing the admin to re-claim the domain.
- [ ] **Token rotates after 10 failed verify attempts in 24 hours**: 11th call onward presents a new token; admin must update DNS.

## Test requirements

### Coverage floor

- **Handlers:** 85% lines.
- **DNS-lookup wrapper:** 90% (mocked).

### Required tests

1. Per-handler unit tests with mocked `dns.resolveTxt`.
2. Real-DNS integration test against a controlled subdomain (`_trellis-test.<a-domain-the-deployment-controls>`) with a known TXT record.
3. PSL test: load the public-suffix-list snapshot, assert representative domains rejected.
4. Idempotency test: same `(tenantId, domain)` POST twice returns same record.
5. Cross-tenant isolation tests for all 4 endpoints.

## Files to add/modify

| File | Action |
|---|---|
| `apps/api/src/lib/routes/tenant-domains.ts` | new |
| `apps/api/src/lib/tenant/domain-verifier.ts` | new (DNS-lookup wrapper) |
| `apps/api/src/lib/tenant/domain-validator.ts` | new (format + PSL check) |
| `apps/api/test/routes/tenant-domains.test.ts` | new |
| `apps/api/test/lib/domain-verifier.test.ts` | new |
| `apps/api/test/lib/domain-validator.test.ts` | new |
| `apps/api/test/integration/dns-lookup.test.ts` | new (real DNS) |

## Security considerations

- [ ] Token generated with `crypto.randomBytes`, never with `Math.random`.
- [ ] No SSRF via DNS lookup (`dns.resolveTxt` doesn't follow HTTP — safe by design).
- [ ] PSL list bundled (don't fetch at runtime — supply-chain risk).
- [ ] Rate-limit storage in DynamoDB (not in-memory; survives Lambda restarts).
- [ ] Domain string sanitized before logging (no log injection).

## Definition of done

All acceptance criteria checked. PR reviewed, merged to integration branch.
