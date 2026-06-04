# MVP Scope

What ships in MVP, what's deferred to Phase 2 and 3, and the explicit acceptance criteria for "identity federation done."

> **Perspective.** This doc is written from the perspective of the *first consuming product* of trellis multi-tenancy — Trellis. The framework features themselves (schema, Lambdas, route handlers, etc.) are stable in the trellis v0.7 release; this doc enumerates what trellis must contain at v0.7 and what dogfood the first consumer needs to validate it. A second consumer would have a different MVP-scope doc in their repo.

## The headline cut

**MVP supports Microsoft Entra ID via OIDC. Only.**

The Tenant / TenantMember / TenantDomain / TenantIdentityProvider schema, the Cognito IdP CRUD endpoints, the JIT Lambda, the role-grant logic — all are IdP-agnostic and can serve any conformant SAML 2.0 or OIDC provider. But for MVP:

- Only the **OIDC** branch of the IdP CRUD is end-to-end tested.
- Only the **Entra OIDC** flow has a Flutter UI ("Connect Microsoft Entra ID").
- Only the **Entra OIDC** walkthrough is shipped in `doc/01-business/features/internal-features/onboarding/`.
- Only **de otio + Entra** is the dogfood acceptance test.
- The **SAML branch** of the API exists for code symmetry but isn't exposed in the UI.
- **No other IdPs** (Okta, Google Workspace, Auth0, OneLogin, generic SAML) ship validated UI or docs in MVP.

This narrows the build envelope considerably without locking us in. The first paying tenant in a different IdP family unlocks that path in Phase 2 with new walkthroughs and UI surfacing — no architecture changes.

## Must ship (MVP / Phase 1)

### Tenancy primitives
- [ ] `Tenant`, `TenantMember`, `TenantDomain`, `TenantIdentityProvider`, `TenantRoleMapping`, `TenantInvitation` Prisma models — see [02-data-model.md](./02-data-model.md).
- [ ] `tenantId` foreign key added to `Entity`, `Post`, `PostComment`, `Group`, `GroupMember`, `ConnectionCode`, `ConnectionCodeRedemption`, `EntityOwnership`, `Notification`.
- [ ] `Partner` model + `User.partnerId` removed.
- [ ] Migration runs cleanly on greenfield dev/CI (no data to backfill).

### Personal tenants (auto-created)
- [ ] On Cognito post-confirmation, every new user gets a personal `Tenant` of `type=PERSONAL` and a `TenantMember` row with `role=OWNER`.
- [ ] User's `personalTenantId` set in the same transaction.
- [ ] All existing B2C features continue to work — posts about dogs, connection codes, etc. — now scoped to the user's personal tenant.

### Organization tenant creation
- [ ] `POST /api/tenants` creates an organization tenant; caller becomes OWNER; their global `User.role` bumps `END_USER → B2B_PARTNER`.
- [ ] Slug uniqueness, regex validation, reserved-list enforcement.
- [ ] Tenant switcher endpoint (`POST /api/auth/switch-tenant`) flips the active tenant in JWT.

### Domain verification (TXT record)
- [ ] `POST /api/tenants/{id}/domains` issues a verification token.
- [ ] `POST /api/tenants/{id}/domains/{domainId}/verify` checks TXT record via `dns.resolveTxt`.
- [ ] Once verified, domain is bound to tenant and unique across the platform.
- [ ] `DELETE` endpoint with safety check (no active IdP referencing it).

### IdP federation — Entra OIDC
- [ ] `POST /api/tenants/{id}/identity-provider` creates a `TenantIdentityProvider` row + a Cognito `UserPoolIdentityProvider` via `CreateIdentityProviderCommand`.
- [ ] **OIDC path** validates issuer reachability, stores client secret in Secrets Manager, attribute mapping defaulted, end-to-end-tested with Entra.
- [ ] SAML path: code exists for symmetry; **not exposed in MVP UI; not shipped with a walkthrough.** Phase 2.
- [ ] `PATCH` updates configuration; `DELETE` removes IdP and cleans up.
- [ ] Disable/enable toggle.
- [ ] App client `SupportedIdentityProviders` mutated dynamically.

### Sign-in routing
- [ ] `POST /api/auth/discover` returns either `{method: "idp", idpRedirect: ...}` or `{method: "password"}`.
- [ ] Cognito hosted UI is configured at `auth.example.com`.
- [ ] Email-domain → IdP routing works via `IdpIdentifiers` on the IdP record.

### JIT user provisioning
- [ ] PostConfirmation Lambda handles federated users: creates User row, personal tenant, and TenantMember in the federated tenant atomically.
- [ ] Idempotent — safe under retry.
- [ ] Group claims parsed and mapped to TenantRole via `TenantRoleMapping`.

### Pre-token-generation Lambda
- [ ] Returns `custom:userId`, `custom:globalRole`, `custom:activeTenantId`, `custom:tenantSlug`, `custom:tenantRole`, `custom:handle`.
- [ ] DynamoDB cache (1h TTL).
- [ ] Group → role refresh on every issuance (no waiting for cache expiry on role demotions).
- [ ] Cache invalidation on tenant switch, member role change, member remove.

### Roles and capabilities
- [ ] `TenantRole` enum: OWNER, ADMIN, MEMBER, GUEST.
- [ ] `Capability` constant strings ([05-roles-and-permissions.md](./05-roles-and-permissions.md) §catalog).
- [ ] `RoleGrants` matrix.
- [ ] `requireCapability` middleware in trellis.
- [ ] All existing routes audited — every tenant-scoped endpoint enforces `auth.activeTenantId === path.tenantId` and the right capability.

### Member management
- [ ] `GET /api/tenants/{id}/members` — paginated list with role + status.
- [ ] `PATCH /api/tenants/{id}/members/{memberId}` — change role (ADMIN+).
- [ ] `DELETE /api/tenants/{id}/members/{memberId}` — soft-remove + AdminUserGlobalSignOut.
- [ ] `POST /api/tenants/{id}/transfer-ownership`.

### Role-mapping management
- [ ] `GET / POST / PATCH / DELETE /api/tenants/{id}/role-mappings`.
- [ ] Validation: admin can't map a group to OWNER (only transfer-ownership creates OWNER); priority must be positive integer.

### Flutter UI
- [ ] **Sign-in screen:** email entry → discovery → either password form or IdP redirect.
- [ ] **Tenant switcher:** dropdown in app bar listing user's memberships, calls switch-tenant endpoint.
- [ ] **Settings → Organization:**
  - Tenant info (display name, slug)
  - Members list with role chips and remove/role-change actions
  - Domains list with add/verify/remove
  - Identity provider — OIDC and SAML connect flows, status, test sign-in button
  - Role mappings — add/edit/delete
- [ ] **Onboarding for new tenant:** "Create organization" wizard (slug + name) → verify domain → connect IdP, with a clear progress indicator.

### Audit logging
- [ ] All events listed in [07-security-and-isolation.md](./07-security-and-isolation.md) §audit-log emitted to CloudWatch + `security_events` table.
- [ ] `GET /api/tenants/{id}/audit` for tenant admins.

### Security
- [ ] All cross-tenant test cases ([07](./07-security-and-isolation.md) §threat-specific-test-cases) passing.
- [ ] IdP secrets only in Secrets Manager.
- [ ] Reserved slug list seeded.
- [ ] `aws-jwt-verify` middleware validates every request.

### Compliance posture (GDPR baseline)

Per [README §P3](./README.md#p3-compliance-is-a-first-class-design-constraint-not-an-afterthought) and [07-security-and-isolation.md §GDPR-alignment](./07-security-and-isolation.md#gdpr-alignment):

- [ ] Data export hooks: `GET /api/users/me/export` includes federation-related rows (TenantMember, audit-log entries pertaining to the user).
- [ ] Audit log: every admin action emits structured event; tenant-admin export endpoint works (`GET /api/tenants/{id}/audit?format=csv`).
- [ ] Subprocessor list visible in tenant settings — at minimum: AWS (named services), the tenant's own IdP, SES.
- [ ] Region pinning honored: EU-region tenant's federation flow stays in eu-central-1.
- [ ] Member removal triggers `AdminUserGlobalSignOut` (right-to-restriction).
- [ ] No claim *values* logged anywhere (only claim *names* and resolution outcomes).
- [ ] Privacy policy updated to enumerate what federation reads from the IdP and why.

### IT-experience (P2) acceptance

Per [README §P2](./README.md#p2-it-friendly-onboarding-for-the-influential-customers) and [03-onboarding-flows.md §Designed-for-IT-admin-sanity](./03-onboarding-flows.md#designed-for-it-admin-sanity):

- [ ] Fixed-string redirect URI / ACS URL / SP Entity ID documented in tenant-admin docs.
- [ ] "Test sign-in" diagnostic button surfaces raw claims + resolved role.
- [ ] **Entra OIDC walkthrough** in `doc/01-business/features/internal-features/onboarding/entra-oidc-setup.md` — exact app-registration steps, screenshots, group-claim configuration. **Includes both the human (portal-click) flow and the agent (Microsoft Graph API) flow.** _(Other IdP walkthroughs are Phase 2.)_
- [ ] Standard claim names (`email`, `groups`, etc.) work without IdP-side custom-claim work.
- [ ] Client-secret rotation, member force-signout, IdP disable — all admin-self-service via UI, no support ticket.

### Agent-friendliness (P4) acceptance

Per [README §P4](./README.md#p4-agent-driven-setup-and-review-are-first-class), [10-agent-friendly-onboarding.md](./10-agent-friendly-onboarding.md), and [11-agent-friendly-compliance.md](./11-agent-friendly-compliance.md):

#### Discovery surfaces
- [ ] `/llms.txt` published at `https://example.com/llms.txt` and `https://api.example.com/llms.txt`. Lists OpenAPI, compliance bundle, walkthroughs, agent-auth contract.
- [ ] OpenAPI 3.1 spec at `https://api.example.com/openapi.json`, auto-generated from trellis Zod schemas; valid by `swagger-cli validate`.
- [ ] `/.well-known/compliance.json` and `/.well-known/compliance.md` published, validated against [`compliance.schema.json`](./11-agent-friendly-compliance.md#json-schema).
- [ ] `/.well-known/openid-configuration` exposes the agent-OAuth client config and device-authorization endpoint URLs.
- [ ] `/security.txt` per RFC 9116 with security contact + PGP key.

#### Agent auth (OIDC, no API tokens)
- [ ] Cognito app client `trellis-agent-cli` provisioned: public, PKCE-required, `127.0.0.1` redirect family, scopes limited to onboarding.
- [ ] PKCE + localhost-listener flow tested end-to-end with a real Claude Code session.
- [ ] Device authorization grant (RFC 8628) adapter implemented on top of Cognito (`POST /oauth2/device_authorization` + `/agents/authorize` + `POST /oauth2/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`).
- [ ] `/settings/agents` Flutter UI: list authorized agent sessions per user with last-used timestamp, scope, revoke button.
- [ ] Refresh-token rotation + reuse-detection working (RFC 6749 §6 + RFC 6819 §5.2.2.5).
- [ ] All agent-session API calls audit-logged with `agentSessionId`.

#### API contract
- [ ] `GET /api/tenants/{id}/setup-status` returns documented structured shape with `nextStep` + `remediation`.
- [ ] All federation POST endpoints accept `Idempotency-Key` header with 24h dedup window.
- [ ] All federation 4xx responses use the structured error format (`error`, `message`, `remediation`, `field`).
- [ ] `GET /api/tenants/{id}/compliance.json` returns tenant-scoped compliance bundle (auth: tenant admin or agent session).

#### Safety
- [ ] Destructive operations require `?confirm=true` (no-confirm returns 400 with remediation).
- [ ] IdP `clientSecret` never returned by `GET` endpoints (write-only).
- [ ] Compliance JSON CI lint forbids unverified claims and marketing language.

#### Validation
- [ ] **End-to-end agent transcript fixture:** a real Claude Code session drives canonical onboarding flow against dev environment, completes successfully. Saved as fixture in `doc/02-technical/development/testing/agent-onboarding-fixtures/`.
- [ ] **End-to-end compliance-review transcript fixture:** Claude Code answers "does Trellis meet our requirements?" using only the public compliance surface.
- [ ] **de otio dogfood is performed via Claude Code** (Richard's own Claude session is the integration test for both onboarding and compliance review).

### Dogfood
- [ ] de otio Tenant created.
- [ ] de otio domain `de-otio.org` verified.
- [ ] Entra OIDC IdP connected.
- [ ] Entra group `Trellis-Admins` mapped to `ADMIN`; default role `MEMBER`.
- [ ] At least 2 de otio employees can sign in via Entra and act in their roles.

### Acceptance criteria

The feature is "shipped" when:

1. **Self-service tenant creation works for any signed-up user.** End-to-end, no human in the loop.
2. **An Entra-managed de otio admin can sign in via SSO** without password prompt.
3. **A de otio employee in the `Trellis-Members` Entra group gets `MEMBER` role** automatically on first login.
4. **A de otio admin can promote/demote members and add domains** through the Trellis UI; changes propagate to subsequent tokens within ~1 hour.
5. **Tenant isolation tests all pass** in CI.
6. **No tenant data leaks across tenants** under any tested API call.
7. **80%+ unit test coverage** on the federation Lambdas, route handlers, and capability checks (per project policy `feedback_test_coverage`).

## Out of MVP — Phase 2 (post-Phase-1 alpha)

| Feature | Why deferred | Trigger for revisiting |
|---|---|---|
| **SCIM 2.0 endpoints** | Significant spec compliance work; JIT covers de otio's case | First customer with > 50 employees needing same-day deprovisioning |
| **Per-domain re-verification (nightly cron)** | DNS changes are rare; manual revoke is fine for ~10 tenants | Hit ~50 federated tenants OR first domain-takeover incident |
| **Tenant invitation flow (non-federated orgs)** | Federated tenants don't need it; unfederated B2B (solo café operator) does | Phase 2 B2B vertical kickoff if it includes solo operators |
| **Custom Cognito UI in Flutter** (replacing hosted UI) | Branding and UX preference, not security | After dogfood feedback if hosted UI causes friction |
| **Tenant subdomain branding** (`de-otio.example.com`) | Reverse-proxy + CloudFront listener-rule complexity | Customer asks for branded URLs |
| **Authentication policies (test SSO on subset)** | Niche; tenant admins of MVP-scale don't need staged rollout | First > 100-employee tenant onboarding |
| **`platform.*` capabilities + admin UI** | Not needed yet; CLI tools cover platform work | First non-developer support hire |
| **Cognito user-pool feature plan upgrade** (Lite → Essentials/Plus) | Cost — wait until features are needed | When asked for advanced security features (compromised credentials check, adaptive auth) |
| **Apple/Google social login** | Out of B2B path; Phase 1 B2C uses email/password | Add when consumer-onboarding metrics show signup-friction issues |
| **Auto-deprovision Lambda for "removed from all groups"** | Ahead of need; SCIM Phase 2 supersedes | Phase 2 |
| **Audit log retention beyond 30 days** | CloudWatch-Logs cost; 30 days is enough for incident triage | First customer compliance request |
| **Full Article-30 RoPA document** | Technical hooks satisfy Art. 30; the human-readable register is a doc artifact | First enterprise customer compliance review or DPO ask |
| **DPA template + customer self-serve download** | Mechanical hooks present; legal template needs lawyer pass | Phase 2 |
| **DPIA document** | Trellis processing isn't high-risk per Art. 35; can be authored from this design when first asked | Phase 2 |
| **Tenant-deletion right-to-erasure cascade** | SQS pipeline non-trivial; soft-delete + Cognito disable in MVP satisfies the right within the regulatory window | Phase 3 |

## Out of MVP — Phase 3+ (after public launch)

- Postgres row-level security for tenant scope (defense-in-depth)
- Org/site multi-product hierarchy (revisit only if a separate B2B vertical splits)
- Custom per-tenant roles + capability bundles
- Resource-level grants ("admin of *this* venue")
- Tenant deletion cascade pipeline
- Multi-region tenancy (data-residency requirements)
- Marketplace integrations (Slack/Teams notifications, Zapier triggers)
- Tenant-paid tiers (subscription billing)
- Audit log export (S3, SIEM, Splunk)
- Compliance certifications (SOC 2 Type II, ISO 27001) — depend on audit log retention upgrade

## Sequencing within MVP

The build order matters because some pieces unblock others. See [09-implementation-plan.md](./09-implementation-plan.md) for the detailed schedule.

```
Schema migration ────────────┐
                             │
Cognito CDK changes ─────────┤
(triggers + custom attrs)    │
                             ▼
                    PostConfirmation rewrite
                    PreTokenGen rewrite
                             │
                             ▼
                    Tenant CRUD endpoints
                             │
                  ┌──────────┴──────────┐
                  ▼                     ▼
        Domain verification    Member management
                  │                     │
                  ▼                     ▼
        IdP CRUD endpoints      Role-mapping CRUD
                  │
                  ▼
        Flutter UI (org wizard)
                  │
                  ▼
        de otio dogfood
```

Critical-path bottleneck: **Cognito triggers + tenant model + IdP CRUD must all land before any Flutter work**. Backend can be tested via curl. Flutter wiring is the last step.

## Cost ceiling for MVP

- **Cognito MAU:** stays in 50K free-tier. de otio has ~5–20 employees; aggregate MAU including B2C alpha (~100–200 users) is well under threshold. Federated MAU is `EnterpriseMAU` and counts the same as regular MAU on Lite plan.
- **Lambda invocations** (PreTokenGen on every refresh): negligible at MVP scale; well under free-tier. Reserved concurrency 50 is for safety.
- **DynamoDB cache:** sub-MB read/write. Pennies.
- **Secrets Manager:** $0.40/secret/month × ~10 tenants = $4/month.
- **Total marginal cost over current Cognito setup:** ~$5/month at MVP scale. Not a blocker.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Entra-side OIDC tenant config fails for non-obvious reason | Medium | High (de otio can't dogfood) | Have a SAML fallback; pair with someone who's done this before; AWS Cognito + Entra have a Microsoft-published guide we follow |
| Pre-token-gen Lambda timeout under load | Low | High (sign-ins fail) | DynamoDB cache + RDS Proxy; load-test with 10x expected concurrency |
| Cognito IdP-record corruption | Low | Medium | All metadata also in Postgres; can recreate IdP record from DB state |
| Flutter integration delays | Medium | Medium | Backend + curl tests prove correctness regardless of UI; ship UI in pass 2 if needed |
| Tenant slug squatting (adversarial signup) | Low | Medium | Reserved-list seeded; abuse-report flow informal but real |
| Greenfield migration breaks dev environment for too long | Low | Medium | Migration is one PR with seeds; can be reverted cleanly |

## Definition of done

- [ ] All "Must ship" boxes above checked.
- [ ] de otio dogfood complete: at least 2 employees signed in via Entra, with the right roles.
- [ ] All threat-specific test cases ([07](./07-security-and-isolation.md) §threat-specific-test-cases) automated and passing.
- [ ] [09-implementation-plan.md](./09-implementation-plan.md) work breakdown items all closed or explicitly punted to Phase 2.
- [ ] The first consuming product's MVP plan is updated to reflect that identity-federation is no longer a Phase 2 gate. (For Trellis: `trellis/plans/mvp/PLAN.md`.)
