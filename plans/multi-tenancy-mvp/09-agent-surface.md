# T9b — Agent-Friendly Surface

**Recommended model:** Sonnet 4.6 for most; **Opus 4.7** for OIDC device-authorization adapter
**Effort:** ~5 days
**Depends on:** T3 (tenant CRUD), T7 (audit log)
**Blocks:** publish gate G4; consuming-app stages — S5 (`/settings/agents` UI), S6 (compliance.json content)
**Branch:** `feat/T9b-agent-surface`

## Goal

Make trellis discoverable, idempotent, machine-checkable, and OIDC-agent-authenticatable per [README §P4](../../doc/02-technical/identity-federation/README.md#p4-agent-driven-setup-and-review-are-first-class).

## Design reference

- [`doc/02-technical/identity-federation/10-agent-friendly-onboarding.md`](../../doc/02-technical/identity-federation/10-agent-friendly-onboarding.md)
- [`doc/02-technical/identity-federation/11-agent-friendly-compliance.md`](../../doc/02-technical/identity-federation/11-agent-friendly-compliance.md)

## Scope

This stage **splits into 4 substages** to allow Opus only where needed:

### T9b-a: Discovery surfaces (Haiku, ~1d)

- `GET /llms.txt` — static, served via the trellis API root or the consuming app's static site (trellis-side wins for portability).
- `GET /openapi.json` — auto-generated from Zod schemas + route metadata. Use existing trellis route registration to introspect.
- `GET /security.txt` per RFC 9116.

### T9b-b: Setup-status + structured errors (Sonnet, ~1d)

- `GET /api/tenants/{id}/setup-status` returning the documented shape from [10-agent-friendly-onboarding.md §setup-status](../../doc/02-technical/identity-federation/10-agent-friendly-onboarding.md#setup-status).
- Standardize all 4xx responses to `{error, message, remediation, field?}` format. Refactor every existing T3–T8 handler that doesn't already conform.

### T9b-c: Idempotency-Key middleware (Sonnet, ~1d)

- `Idempotency-Key` header support on all federation POSTs.
- DynamoDB-backed dedup window 24h.
- Per [10-agent-friendly-onboarding.md §MVP-4](../../doc/02-technical/identity-federation/10-agent-friendly-onboarding.md#mvp-4-idempotency-contract).

### T9b-d: OIDC agent auth (Opus, ~2d)

This is the most complex piece. Two flows:

1. **PKCE + localhost-listener flow.** Just requires a public Cognito app client for the agent CLI (e.g. `{appName}-agent-cli`) to be configured — the consuming deployment owns its CDK; trellis-side just verifies the flow works against it.
2. **Device authorization grant adapter** ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)) — Cognito doesn't support natively, so we implement on top:
   - `POST /oauth2/device_authorization` — generates `device_code` (256-bit random) + `user_code` (8 chars from BCDFGHJKLMNPQRSTVWXZ alphabet, no ambiguous chars). Stores in DynamoDB with TTL `expires_in`.
   - `GET /agents/authorize?user_code=...` — the consuming app's web UI; checks active session (forces login if missing); **enforces MFA challenge** *(sec finding #1)* — if the admin authenticated via Cognito's hosted UI without MFA in the current session, an MFA challenge is presented before approval; displays scopes + agent metadata; admin clicks Approve.
   - On approve, server calls `AdminInitiateAuth` for the admin's user, captures resulting tokens.
   - **Token storage is application-layer-encrypted** *(sec finding #1, critical)*. The DynamoDB record stores the ciphertext of the tokens encrypted with a per-`device_code` data-encryption key (DEK) that is itself encrypted by KMS. The `device_code` value (held only by the polling agent) is mixed into the DEK derivation, so a DynamoDB read by anyone who lacks the agent's `device_code` cannot decrypt. Reference: AWS envelope-encryption pattern.
   - **Stored-token TTL after approval:** 60 seconds. If the agent doesn't poll within 60s of approval, the record is deleted and the device-auth flow must restart. Prevents stale tokens sitting in DynamoDB.
   - `POST /oauth2/token grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=...` — agent polls; on first successful poll, server fetches the encrypted record, decrypts using the `device_code`, returns tokens, **and immediately deletes the DynamoDB record** (read-once semantic). Subsequent polls with the same `device_code` return 410 Gone.
   - **Rate limit on the approval page** *(sec finding #3)*: 5 attempts per IP per minute. After 10 failed `user_code` lookups against any single `device_code`, that `device_code` is invalidated server-side (admin must restart device-auth flow). Mitigates brute-force on the 8-char user_code.
3. **Refresh-token reuse detection** per RFC 6819 §5.2.2.5 — single-use refresh; if same refresh seen twice, full session revocation.
4. **`/settings/agents` API support:** `GET /api/users/me/agent-sessions`, `POST /api/users/me/agent-sessions/{id}/revoke` (calls `AdminUserGlobalSignOut`).

### T9b-e: Compliance.json endpoint (Sonnet, ~1d)

- `GET /api/tenants/{id}/compliance.json` — tenant-scoped, auth required.
- Combines platform baseline (loaded from the consuming app's static bundle) + tenant-specific overrides (from RDS).
- Schema reference at `https://{deployment-domain}/.well-known/compliance.schema.json` (owned by the consuming app's compliance stage).

## Acceptance criteria

Per substage:

- [ ] T9b-a: `/llms.txt`, `/openapi.json`, `/security.txt` accessible; OpenAPI valid by `swagger-cli validate`.
- [ ] T9b-b: setup-status returns documented shape; all 4xx errors structured.
- [ ] T9b-c: same Idempotency-Key + body twice in 24h returns identical response.
- [ ] T9b-d:
  - PKCE flow works against local Cognito + the consuming deployment's CDK-provisioned app client.
  - Device-auth flow works: agent gets `user_code`, human approves with MFA, agent gets tokens.
  - **MFA enforced** at the approval step (sec finding #1).
  - **Application-layer encryption** of stored tokens verified: a direct `GetItem` on the DynamoDB record without the `device_code` cannot decrypt the payload (sec finding #1).
  - **Read-once token storage:** after first poll, second poll with same `device_code` returns 410 (sec finding #1).
  - **60-second post-approval TTL** verified (sec finding #1).
  - **Rate limit on approval page** (5 attempts/IP/min) tested with simulated brute-force (sec finding #3).
  - **`device_code` lockout** after 10 failed `user_code` lookups verified (sec finding #3).
  - Refresh-token reuse triggers session revocation.
  - `/settings/agents` GET + revoke endpoints work.
- [ ] T9b-e: tenant compliance bundle returns; cross-tenant isolation enforced.
- [ ] **End-to-end agent transcript fixture:** Claude Code drives canonical onboarding flow against dev environment. Recorded in `apps/api/test/fixtures/agent-onboarding-transcript.md`.
- [ ] **End-to-end compliance-review transcript fixture:** Claude Code answers compliance question from public bundle.
- [ ] **G4 gate review** before merge.

## Test requirements

### Coverage floor

- **OpenAPI generation:** 80% lines.
- **Setup-status:** 90% lines.
- **Idempotency middleware:** 95% lines.
- **Device-auth adapter:** 95% lines (security-critical).
- **Refresh-token reuse detection:** 100% (security-critical).

### Required tests

1. OpenAPI: round-trip — generate, serialize, parse, validate, assert all routes present.
2. Setup-status: every state combination (no domain, domain unverified, IdP pending, etc.) returns expected `nextStep`.
3. Structured-error format: lint test that every handler that throws returns `{error, message, remediation}`.
4. Idempotency: same key + same body = same response; same key + different body = 422.
5. Device-auth: user_code uniqueness, polling flow, approval flow, expiry, token issuance.
6. Refresh-token reuse: simulated replay → all sessions revoked.

## Files to add/modify

| File | Action |
|---|---|
| Various static assets (deployed to the consuming app's static site) | new — handed to the consuming app's compliance stage |
| `apps/api/src/lib/openapi/generator.ts` | new |
| `apps/api/src/lib/routes/setup-status.ts` | new |
| `apps/api/src/lib/middleware/idempotency.ts` | new |
| `apps/api/src/lib/middleware/error-format.ts` | modify (standardize) |
| `apps/api/src/lib/oauth/device-authorization.ts` | new |
| `apps/api/src/lib/oauth/refresh-detection.ts` | new |
| `apps/api/src/lib/routes/agent-sessions.ts` | new |
| `apps/api/src/lib/routes/tenant-compliance.ts` | new |
| Tests for each | new |

## Security considerations

- [ ] `user_code` alphabet excludes `0/O`, `1/I/L`, `2/Z`, etc. to avoid copy errors.
- [ ] `device_code` is 256-bit random; never logged.
- [ ] Approval URL forces login + checks user is a tenant admin **+ enforces MFA in current session** (sec finding #1).
- [ ] Token-exchange in device-auth flow is rate-limited (anti-brute-force on user_code) — **5 attempts per IP per minute on the approval page**, **10 failed user_code lookups per device_code → invalidate**, **token-poll endpoint rate-limited per RFC 8628 §6.1** (sec finding #3).
- [ ] **Per-tenant rate limits across all agent sessions** *(sec finding #9)*: 300 req/min per tenant on federation endpoints; 120 req/min per IP on unauthenticated discovery (`/llms.txt`, `/openapi.json`, `/.well-known/compliance.json`). Enforced at API Gateway / WAF, not just per-session.
- [ ] **Stored-token encryption** in device-auth flow uses application-layer envelope encryption (DEK derived from `device_code`, KEK in KMS). Direct DynamoDB read without `device_code` cannot decrypt (sec finding #1).
- [ ] **Read-once token storage** with 60s TTL post-approval; second poll returns 410 (sec finding #1).
- [ ] Refresh-token reuse detection is bulletproof — if a refresh is presented twice, **all** of that session's tokens revoked.
- [ ] The agent-CLI public client (e.g. `{appName}-agent-cli`) has no client secret; PKCE mandatory.
- [ ] Redirect URIs validated against `127.0.0.1` family (localhost only); no public hosts; **specifically `127.0.0.1` only, not `localhost` (DNS-rebinding mitigation)** *(sec finding #10)*.

## Definition of done

All substages' acceptance criteria checked. PR reviewed at G4 (human + security-reviewer subagent), merged to integration branch.

After this merges, run final integration tests + load tests, then publish trellis v0.7 to npm via OIDC tag-trigger.
