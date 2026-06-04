# Security and Isolation

Threat model, tenant data isolation guarantees, IdP-secret handling, audit logging, and the security review checklist this design must pass before going live.

## Threat model

We assume a hostile multi-tenant environment from day one — even though MVP starts with one tenant (de otio). Threats considered:

| # | Threat | Mitigation summary |
|---|---|---|
| T1 | One tenant reads another tenant's data | Mandatory `tenantId` predicate on every query against tenant-scoped tables; lint rule + test suite |
| T2 | One tenant modifies another tenant's data | Active-tenant check in auth middleware; `auth.activeTenantId === path.tenantId` enforced |
| T3 | Domain takeover (attacker proves a domain they don't own) | TXT-record with cryptographically-random token; never accept any other DNS record type |
| T4 | Tenant slug squatting (attacker grabs `coca-cola` to phish customers) | Slug allowlist for branded names; abuse-report flow; no preemptive squatting prevention in MVP |
| T5 | IdP secret leak (Postgres dump exposes client secrets) | Secrets in AWS Secrets Manager only; Postgres holds ARN |
| T6 | IdP impersonation (attacker spoofs Entra response) | Cognito validates SAML signature / OIDC issuer signature; we never accept unsigned responses |
| T7 | Privilege escalation via group-claim manipulation | IdP group claims are signed (within the OIDC ID token / SAML assertion); Cognito verifies before pre-token-gen sees them |
| T8 | Privilege escalation via role-mapping table edit | Mapping edits require `IdpConfigure` capability (OWNER/ADMIN only); audit-logged |
| T9 | JIT-provisioning DoS (attacker drives huge user creation) | Cognito `UserFederation` rate limits + per-source-IP rate limits on hosted UI; PostConfirmation Lambda timeout |
| T10 | Cross-tenant token reuse (token issued for tenant A used to access tenant B) | `custom:activeTenantId` is in the JWT signature; can't be modified without re-auth; route handlers check it equals path tenantId |
| T11 | Stale role after IdP-side group removal | PreTokenGen refreshes role on every token issuance (≤ 1h lag); Phase 2 SCIM closes the gap |
| T12 | Tenant admin demotes platform admin (SUPER_ADMIN) | Tenant role mappings can't promote anyone above ADMIN within the tenant; SUPER_ADMIN is global, not tenant-scoped |
| T13 | Compromised CI deploys malicious IdP record | CDK deploys *don't* create per-tenant IdPs; they're API-driven from authenticated admin sessions, audit-logged |
| T14 | IdP record deletion as a data-destruction attack | Confirm-with-MFA (Phase 2) or 24h cooling-off period before destructive IdP changes (deferred); audit log records the action |

## Tenant isolation guarantees

The fundamental promise: **a query for tenant A's data, executed in the context of tenant B, returns nothing.**

### Layer 1 — schema invariant

Every tenant-scoped table has a non-nullable `tenantId` column with a foreign key to `tenants.id`. New columns added in this design:

```sql
ALTER TABLE entities         ADD COLUMN tenant_id text NOT NULL REFERENCES tenants(id);
ALTER TABLE posts            ADD COLUMN tenant_id text NOT NULL REFERENCES tenants(id);
ALTER TABLE groups           ADD COLUMN tenant_id text NOT NULL REFERENCES tenants(id);
ALTER TABLE connection_codes ADD COLUMN tenant_id text NOT NULL REFERENCES tenants(id);
ALTER TABLE notifications    ADD COLUMN tenant_id text NOT NULL REFERENCES tenants(id);
-- (and others — see 02-data-model.md)
```

### Layer 2 — auth context

Every authenticated request carries `auth.activeTenantId` from the JWT. The middleware refuses to attach an auth context if the claim is empty (treats request as anonymous).

### Layer 3 — handler obligation

Every handler that reads or writes a tenant-scoped table **must** include `tenantId` in the predicate. Three enforcement mechanisms:

1. **Code review checklist** (manual but reliable for our team size).
2. **eslint custom rule** that flags Prisma queries against tenant-scoped models without a `tenantId` field in the `where`. Phase 2 — needs writing.
3. **Integration test fixture** with two seeded tenants (`tenant-a`, `tenant-b`) and identical resource shapes, where every endpoint test verifies "auth-as-A returns A's data, never B's."

### Layer 4 — Postgres row-level security (deferred)

PostgreSQL RLS policies could enforce tenant scope at the database level. Compelling but expensive: every Prisma query would need a session GUC set with the active tenant ID, and Prisma's connection pooling makes this awkward. **Deferred to Phase 3** — the hand-written `tenantId` predicate is sufficient for MVP given the tiny audit surface.

## Cross-tenant resource access — by design "no"

If a user is a member of tenants A and B, and they have a venue entity in A, can they author a post about it from tenant B's context? **No.** The post would carry `tenantId = B`, the entity carries `tenantId = A`, and the foreign-key invariant would be violated by definition (we don't have `Post → Entity` cross-tenant FKs).

To "share" a venue across tenants, we'd need to either:

- **Duplicate the entity** in each tenant. Simple, no shared edits.
- **Introduce cross-tenant resource sharing.** Significant: requires sharing tokens, permission grants, audit, and revocation. Out of scope for MVP and Phase 2.

## IdP secret handling

OIDC client secrets and SAML metadata XML (when pasted instead of fetched) contain sensitive material. Our handling:

| Asset | Storage | Access | Rotation |
|---|---|---|---|
| OIDC client secret | AWS Secrets Manager `tenant/{tenantId}/idp-client-secret` | trellis API task role + Cognito service role | Admin-initiated; old version retained 7 days |
| Cognito IdP record (carries the secret) | Inside Cognito (encrypted at rest) | Cognito service-managed | New secret pushed via UpdateIdentityProvider |
| SAML metadata URL | Postgres (`tenant_identity_providers.metadata_url`) | trellis API DB connection | Public URL; no secret |
| SAML metadata XML | Postgres | trellis API DB connection | Static; admin re-pastes if cert rotates |
| Domain verification token | Postgres (`tenant_domains.verification_token`) | trellis API DB connection | One-shot per domain |

**Secrets Manager pattern:**

```typescript
// On IdP create
const arn = await secretsManager.send(new CreateSecretCommand({
  Name: `tenant/${tenantId}/idp-client-secret`,
  SecretString: clientSecret,
  Tags: [{ Key: 'tenantId', Value: tenantId }, { Key: 'purpose', Value: 'idp-oidc' }],
}));

// On IdP read (only if we need to write to Cognito; never logged)
const { SecretString } = await secretsManager.send(new GetSecretValueCommand({ SecretId: arn }));
```

The trellis task role policy:

```json
{
  "Effect": "Allow",
  "Action": ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
  "Resource": "arn:aws:secretsmanager:eu-central-1:*:secret:tenant/*"
}
```

Tagged so we can audit and bulk-rotate. Every read is in CloudTrail.

## Audit log

Every administrative action on identity-federation surfaces is recorded.

### What's logged

| Event | Captures |
|---|---|
| `tenant.created` | Tenant id, slug, type, creator user id |
| `tenant.member.invited` | Tenant id, invitee email, role, inviter user id |
| `tenant.member.joined` | Tenant id, user id, source (`invitation` / `jit`) |
| `tenant.member.role_changed` | Tenant id, target user id, old role, new role, actor user id |
| `tenant.member.removed` | Tenant id, target user id, actor user id, reason |
| `tenant.domain.added` | Tenant id, domain, actor user id |
| `tenant.domain.verified` | Tenant id, domain, verification method (`txt`) |
| `tenant.idp.connected` | Tenant id, kind (SAML/OIDC), issuer, actor user id |
| `tenant.idp.modified` | Tenant id, what changed (attribute names only — never values) |
| `tenant.idp.disabled` | Tenant id, actor user id, reason |
| `tenant.idp.deleted` | Tenant id, actor user id |
| `tenant.role_mapping.added` | Tenant id, IdP group, role, actor user id |
| `tenant.role_mapping.removed` | Tenant id, IdP group, actor user id |
| `tenant.federated_login.success` | Tenant id, user id, IdP, source IP |
| `tenant.federated_login.denied` | Email, domain, reason (`no-domain-match` / `no-active-idp` / `no-role-mapping`), source IP |
| `tenant.role.refreshed_jit` | Tenant id, user id, old role, new role, source (`jit`) |

### Where it's logged

- **CloudWatch Logs** structured JSON, group `/trellis/{stage}/audit-events`. Retention: 30 days MVP, 1 year Phase 2.
- **Postgres** `security_events` table (already exists — we add new event `type` strings). Retention follows existing `retentionUntil` policy.
- **CloudWatch Metrics** (custom EMF) — counts of denied logins per tenant per minute → alerting.

Tenant admins see a filtered view of their own tenant's events via `GET /api/tenants/{id}/audit`. Platform admins (SUPER_ADMIN) see everything.

### What's NOT logged

- IdP secrets, SAML XML, OIDC tokens — never.
- User attributes from IdP claims beyond `email` and group identifiers (don't log birthdays, phone numbers, etc.).
- Full request bodies for federation endpoints.

## Domain takeover protections

Beyond the TXT-record verification:

- **No DNS record types other than TXT accepted.** No CNAME-of-CNAME tricks.
- **Token is unguessable** (128 bits of entropy). Regenerated if verification fails 10 times in 24 hours.
- **Re-verification on schedule** (Phase 2): nightly Lambda re-checks TXT for verified domains older than 30 days. If TXT is gone, mark `revokedAt` (don't auto-delete; admin must acknowledge), suspend the IdP, audit log.
- **Mutually-exclusive domains:** a domain can be claimed by exactly one tenant. Re-claim by another tenant requires the first tenant to release it (or platform admin override on a documented dispute process — out of MVP).
- **No claiming public-suffix-list TLDs:** can't claim `gmail.com`, `co.uk`, `outlook.com`. Maintained against the public PSL.
- **No claiming subdomains of example.com itself.**

## Tenant slug squatting

Slugs are valuable real estate. We can't prevent all squatting in a self-service-signup world, but:

- **Reserved-list of obvious brands and platform terms** (`amazon`, `apple`, `google`, `meta`, `microsoft`, `trellis`, `de-otio`, `admin`, `system`, `auth`, `api`, ...). The list grows over time.
- **Abuse-report flow:** legit brand owners can report → review → release. **Phase 2** — manual until volume justifies automation.
- **DMCA-style takedown** for blatant impersonation (uses dog imagery + claims to be Pedigree, etc.).

## CSRF and clickjacking on federation endpoints

- **State parameter** on OAuth `/authorize` calls. Cognito generates and validates.
- **PKCE** (Proof Key for Code Exchange) for the Flutter mobile clients. Cognito supports it.
- **`X-Frame-Options: DENY`** on the hosted UI (Cognito-managed; we verify it's set).
- **Cookie security** for Cognito session cookies: `Secure`, `SameSite=Lax`, `HttpOnly` on the hosted UI session cookie. Cognito-managed.

## SAML-specific risks

- **Signature wrapping attacks** — Cognito's SAML implementation validates signature scope per AWS's documentation. We don't write the SAML parser ourselves, which is the hard-to-get-right part.
- **Replay attacks** — assertion `NotOnOrAfter` and `NotBefore` enforced by Cognito.
- **Encrypted assertions** — supported but not required. Recommend HTTPS endpoints (`auth.example.com` is TLS-1.2+ via ACM cert) which protects in transit; encrypt-at-IdP is belt-and-braces.

## OIDC-specific risks

- **Token-binding** to client_id — Cognito ensures the IdP-issued token is bound to our client_id when validating.
- **Authorization code interception** — PKCE mitigates for mobile.
- **Refresh-token theft** — Cognito refresh tokens are stored by the Flutter app's secure storage (Amplify uses Keychain on iOS, Keystore on Android). Refresh-token revocation via `RevokeToken` on tenant disconnect.
- **State / nonce validation** — Cognito's responsibility; we don't reimplement.

## Privilege boundary at the API

The API layer enforces:

```
JWT verified → AuthContext built → activeTenantId pulled
  ↓
Endpoint matches tenant-scoped resource
  ↓
auth.activeTenantId === path.tenantId? (if not SUPER_ADMIN, deny)
  ↓
RoleGrants[auth.tenantRole].has(requiredCapability)? (if not, deny)
  ↓
Handler executes Prisma query that includes `where: { tenantId: auth.activeTenantId }`
```

A failure at any layer rejects with a generic 403 (no information leak about *why* — same response whether the tenantId mismatched or the role was insufficient).

## Threat-specific test cases (must-write before going live)

- [ ] Auth-as-A querying `/api/tenants/{B}/members` returns 403, not 404 or any leak.
- [ ] Auth-as-A creating a Post with `tenantId=B` in the body — body's `tenantId` is ignored; the post is created in A.
- [ ] Auth-as-A reading `/api/posts/{post-in-B}` returns 404 (not 403, no information leak).
- [ ] Auth-as-A with `tenantRole=MEMBER` cannot call `/api/tenants/{A}/members/invite` — 403.
- [ ] Federated login from `alice@unknown-domain.com` does not provision a TenantMember in any org tenant.
- [ ] Direct-to-Cognito IdP-initiated SAML POST without an existing IdP record fails closed (Cognito refuses).
- [ ] Postgres dump (in dev) does not expose any IdP client secrets — only ARNs.
- [ ] Pre-token-gen Lambda failure (RDS down) does not 200 the token request — failure cascades.
- [ ] Tenant admin cannot grant themselves SUPER_ADMIN via role mapping.
- [ ] Removing a domain doesn't orphan an active IdP (the API rejects the delete with a clear error).
- [ ] Audit log entries appear in CloudWatch within 5s of the action.

## Summary of must-haves before MVP launch

1. ✅ All tenant-scoped tables have non-nullable `tenantId`.
2. ✅ All handlers in tenant-scoped routes load `auth.activeTenantId` and use it in queries.
3. ✅ TXT-record domain verification with crypto-random token.
4. ✅ IdP secrets in Secrets Manager only.
5. ✅ Pre-token-gen Lambda has DynamoDB caching with TTL ≤ 1h.
6. ✅ Audit events emitted for every admin action listed above.
7. ✅ JWT verifier validates signature, issuer, audience, expiry on every request.
8. ✅ AdminUserGlobalSignOut on tenant disconnect, member remove, OWNER transfer.
9. ✅ Reserved slug list seeded.
10. ✅ Cross-tenant test cases (above) all pass.

What's deferred and acceptable for MVP:

- Postgres row-level security
- Periodic domain re-verification
- SCIM (auto-deprovisioning faster than 1h)
- Confirm-with-MFA on destructive IdP actions
- Custom roles / per-capability overrides
- IdP record audit-log rollback / undo

## GDPR alignment

Per [README §P3 (Compliance is a first-class design constraint)](./README.md#p3-compliance-is-a-first-class-design-constraint-not-an-afterthought), the federation design treats GDPR as load-bearing. This section maps each relevant GDPR right or obligation to a concrete piece of the design.

### Article-by-article mapping

| GDPR provision | What it requires | How federation supports it | Status |
|---|---|---|---|
| **Art. 5 — Principles** (lawful, fair, transparent; purpose limitation; data minimization; accuracy; storage limitation; integrity & confidentiality; accountability) | Each principle is observable in the data flow | Federation collects email, given_name, family_name, group memberships only. Each has an articulated purpose (identification, role assignment). No surplus claims stored. Audit log demonstrates accountability. | MVP |
| **Art. 6 — Lawful basis** | Each processing activity is justified | Tenant admins onboard under contract (Art. 6(1)(b)). End-user data processing is under legitimate-interest or consent depending on context (carries from existing privacy policy). | MVP |
| **Art. 12–14 — Transparency / privacy notice** | Data subjects know what's processed, why, who the recipients are | Privacy policy lists every IdP claim we read; subprocessor list (federated IdP per tenant) surfaced in tenant settings. | Privacy-policy update needed at MVP launch |
| **Art. 15 — Right of access** | Subject can obtain a copy of their personal data | `GET /api/users/me/export` returns User + all TenantMember rows + audit-log entries about them. Existing user-export Lambda extended to include federation data. | Hooks-in-place MVP; full export Phase 2 |
| **Art. 16 — Right to rectification** | Subject can correct inaccurate data | Email/handle/name are user-editable in profile. Federated sources rectify upstream (in their IdP); changes flow through on next token refresh. | MVP |
| **Art. 17 — Right to erasure ("right to be forgotten")** | Subject can request full deletion | `DELETE /api/users/me` triggers cascade. For federation: TenantMember rows soft-deleted, then hard-deleted in 30-day grace period; Cognito user record `AdminDeleteUser`'d; DDB cache purged. | Cascade-delete Phase 3; **soft-delete + Cognito disable in MVP** |
| **Art. 18 — Right to restriction** | Subject can pause processing | TenantMember.status=`SUSPENDED` removes them from active operations without deleting; existing schema supports it. | Schema MVP; UI Phase 2 |
| **Art. 20 — Right to data portability** | Structured, machine-readable export | Same export endpoint as Art. 15; format JSON. | Hooks MVP |
| **Art. 21 — Right to object** | Subject can opt out of certain processing | Federation itself is required for tenant participation; opt-out is "leave the tenant" (see Art. 17 path). | MVP |
| **Art. 24 / 25 — Privacy by design and default** | Privacy controls baked in | Tenant-scoping invariant, data minimization, single-active-tenant default, no claim-value logging. | MVP |
| **Art. 28 — Processor obligations** | Subprocessors disclosed and bound by contract | Tenant settings page lists "Subprocessors" — Trellis as processor, AWS as sub-processor (Cognito, RDS, S3), and the tenant's own IdP as a special-class sub-processor (the tenant admin onboarded it). DPA covers all. | Disclosure surface MVP; DPA template Phase 2 |
| **Art. 30 — Records of processing activities (RoPA)** | Maintain a register of processing activities | Audit log + structured event emission satisfies the technical side; the human-readable RoPA document is a Phase 2 doc artifact, populated from the design. | Technical MVP; document Phase 2 |
| **Art. 32 — Security of processing** | Appropriate technical and organizational measures | Encryption in transit (TLS 1.2+), encryption at rest (RDS, S3, Cognito), key isolation (Secrets Manager), access control (IAM least-privilege), tenant isolation, audit log. All in this folder. | MVP |
| **Art. 33–34 — Breach notification** | 72-hour notification on personal-data breach | Audit log + structured logging gives the forensic input. The notification process itself is operational, not technical — runbook-driven. | Technical hook MVP; runbook Phase 3 |
| **Art. 35 — Data protection impact assessment (DPIA)** | DPIA for high-risk processing | DPIA template + completed for federation feature set. | Phase 2 doc artifact |
| **Art. 44–49 — International transfers** | EU data has lawful transfer basis | Region-aware data placement (existing `User.dataRegion` + `Post.dataRegion`); EU tenants placed in eu-central-1 by default. AWS provides SCCs for the underlying transfers. | MVP behavior; SCC documentation Phase 2 |

### Concrete data-handling decisions driven by GDPR

These are settled and constrain implementation:

1. **Claim values are never logged.** The audit log records *that* a federation succeeded, *which* IdP, *what role was resolved* — never the raw `groups` claim contents (which can be sensitive: department names, project codenames, etc.).
2. **Group identifiers in `TenantRoleMapping` are stored in plaintext** — they're configuration, not personal data. But group *memberships* of specific users are computed on-the-fly during token issuance, never persisted in our database.
3. **IdP secrets and metadata XML never leave Secrets Manager / RDS for any third-party.** No telemetry, no analytics, no error-reporting payload includes them.
4. **`AdminUserGlobalSignOut` on member removal** is the GDPR-correct behavior: the user is denied access immediately, satisfying the right-to-restriction without waiting for tokens to expire.
5. **Tenant-scoped audit log access** — a tenant admin sees only their tenant's events. Cross-tenant audit access (platform admin only) is deliberately limited and itself audited.
6. **Region pinning at tenant creation.** When an organization tenant is created, its `region` is set; all resources owned by that tenant inherit it. Cross-region IdP federation is *technically* possible but disallowed by default — an EU tenant's authentication flow stays in eu-central-1.
7. **Subprocessor list is surfaced to tenant admins** in `Settings → Compliance → Subprocessors`. Includes AWS (named services), the tenant's own IdP (transparent to them, but listed), and SES for email. Updates require admin notification (Phase 2 — for MVP, the list is static).
8. **DPA template** lives in `doc/01-business/legal/`. Tenant-admins can download a pre-filled DPA naming themselves as controller, Trellis as processor. Phase 2.
9. **Right to be forgotten cascade** (Phase 3) deletes: User row, all owned Entities (and their PostSubject rows where this user's tenant), all Posts authored, all media uploaded, audit log entries pertaining to the user (anonymized rather than deleted to preserve regulatory audit integrity).

### Why this matters for the customer's IT/legal team

When a mid-to-large tenant's IT team evaluates Trellis, the questions they will ask:

- "Where does our data go?" — region-aware placement, EU stays in EU.
- "Who at Trellis can see our data?" — IAM-scoped access, audit-logged.
- "What happens when we offboard?" — disconnect IdP, suspend tenant, delete tenant (Phase 3) — every step is documented.
- "Do you have a DPA?" — yes, downloadable.
- "Can you produce an audit log on demand?" — yes, exportable.
- "Can you delete a single user's data?" — yes (mechanical hooks at MVP, full UI Phase 2).
- "What's your subprocessor list?" — visible in their settings, in writing.

Each "yes" comes from a piece of this design folder. None of them require the tenant to upgrade to a paid tier (per principle P1).

### What's deliberately deferred (and why it's acceptable for MVP)

- **Full DPIA document.** Not a technical artifact; can be written from this design when the first enterprise customer requests it. Trellis's processing is not high-risk per Art. 35 (no large-scale special-category data, no profiling for legal effect). Phase 2.
- **SCIM-driven proactive deprovisioning.** Right-to-erasure is satisfied by manual deprovisioning in MVP (admin clicks Remove → user is signed out within seconds). SCIM speeds it up to "the moment IdP-side disable happens" but doesn't change correctness. Phase 2.
- **Customer-controlled encryption keys (BYOK).** AWS-managed encryption is GDPR-compliant out of the box. BYOK is an enterprise-tier-feature ask, Phase 3+.
- **Audit log retention beyond 30 days.** GDPR doesn't mandate a specific retention; 30 days covers incident-response horizon. Longer retention available on request, Phase 2.
