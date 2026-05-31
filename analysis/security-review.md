# Security Review — Trellis

**Date**: 2026-03-18
**Scope**: Full codebase — API auth/sessions, input validation, infrastructure, CI/CD
**Branch**: `dev`

---

## Executive Summary

The codebase demonstrates strong security fundamentals: parameterized queries, AES-256-GCM session encryption, Zod input validation, CSRF protection with constant-time comparison, and magic-number file upload validation. However, several issues were identified across authentication, infrastructure IAM, and deployment configuration that should be addressed before production hardening.

**Findings by severity:**

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High     | 8 |
| Medium   | 14 |
| Low      | 7 |

---

## Critical Findings

### C-1: Magic link tokens stored unencrypted in DynamoDB

**File**: `apps/api/src/lambda/create-auth-challenge.ts` (lines 16-26)

The magic link token is stored in plaintext in DynamoDB. If an attacker gains read access to DynamoDB (via compromised IAM role, leaked credentials, or insider threat), they can impersonate any user with a pending magic link.

**Fix**: Hash tokens with SHA-256 before storage. On verification, hash the submitted token and compare against the stored hash:

```typescript
import { createHash } from "crypto";
const tokenHash = createHash("sha256").update(token).digest("hex");
// Store tokenHash instead of token
// In verify-auth-challenge.ts, hash the answer before comparison
```

### C-2: SES IAM policies use wildcard resources

**Files**: `infra/lib/stacks/api-stack.ts` (lines 88-91), `infra/lib/stacks/auth-stack.ts` (line 144)

SES permissions grant `SendEmail` and `SendRawEmail` on `resources: ["*"]`, relying solely on IAM conditions (`ses:FromAddress`) for restriction. IAM conditions can be bypassed in certain scenarios and this violates least-privilege.

**Fix**: Scope to the verified SES identity ARN:
```typescript
resources: [`arn:aws:ses:${region}:${account}:identity/${config.domain.hostedZoneName}`]
```

---

## High Findings

### H-1: No CloudFront WAF protection

**File**: `infra/lib/stacks/cdn-stack.ts` (lines 138-139)

A TODO comment acknowledges that WAF for CloudFront (which requires `CLOUDFRONT` scope in us-east-1) is not implemented. The internet-facing CDN has no WAF protection against common web exploits, bots, or DDoS.

**Fix**: Create a `WafStack` deployed to us-east-1 with managed rule groups (AWSManagedRulesCommonRuleSet, AWSManagedRulesBotControlRuleSet) and associate it with the CloudFront distribution.

### H-2: Session secret length not validated

**File**: `apps/api/src/lib/session-manager.ts` (lines 203-206)

The session secret is validated as non-empty but has no minimum length requirement. A 1-character secret would pass validation despite being trivially brutable, even with PBKDF2 stretching.

**Fix**: Enforce minimum 32 characters at both the session manager level and at app startup in `server.ts`.

### H-3: No startup validation of required secrets

**File**: `apps/api/src/env.ts`

`SESSION_SECRET`, `COGNITO_USER_POOL_ID`, and `COGNITO_APP_CLIENT_ID` are required but only fail at first use rather than at startup. This delays failure detection and can cause cryptic errors.

**Fix**: Add a `validateEnv()` function called from `server.ts` startup that validates all required secrets are present and meet minimum requirements.

### H-4: JWT verifier caches JWKS without refresh

**File**: `apps/api/src/lib/auth/cognito-jwt.ts` (lines 12-26)

The Cognito JWT verifier is created once and cached. If Cognito rotates signing keys, the cached JWKS becomes stale and all JWT verification fails until the process restarts.

**Fix**: Implement periodic JWKS refresh (e.g., every 24 hours) or recreate the verifier on verification failure with a retry.

### H-5: X-Ray sidecar uses `latest` tag

**File**: `infra/lib/stacks/api-stack.ts` (line 199)

The X-Ray daemon container uses `public.ecr.aws/xray/aws-xray-daemon:latest`. A breaking change in the upstream image could silently deploy.

**Fix**: Pin to a specific version tag (e.g., `3.3.3`).

### H-6: Wildcard IAM policies on multiple stacks

**Files**:
- `infra/lib/stacks/agents-stack.ts` (lines 54-57, 72-75) — `ecs:DescribeServices` and `ce:GetCostAndUsage` on `*`
- `infra/lib/stacks/monitoring-stack.ts` (line 111) — Budget restriction policy on `*`

While some of these APIs don't support resource scoping, each should be documented with the specific justification and revisited quarterly as AWS adds resource-level support.

### H-7: ECR tag mutability enabled

**File**: `infra/lib/stacks/storage-stack.ts` (line 36)

`imageTagMutability: MUTABLE` allows overwriting existing image tags. An attacker with ECR push access could replace a known-good image with malicious code.

**Fix**: Set to `ecr.TagMutability.IMMUTABLE` for production.

### H-8: Broad Bedrock AgentCore assume-role wildcard

**File**: `infra/lib/stacks/agents-stack.ts` (line 119)

The source ARN condition uses `arn:aws:bedrock-agentcore:${region}:${account}:*`, allowing any Bedrock AgentCore resource in the account to assume the role.

**Fix**: Scope to the specific runtime ARN.

---

## Medium Findings

### M-1: CORS domain matching uses `includes()` — subdomain spoofable

**File**: `apps/api/src/lib/cors-handler.ts` (lines 94-102)

The hardcoded domain check uses `origin.includes("rkm1.de")`, which would match `evil-rkm1.de` or `rkm1.de.attacker.com`.

**Fix**: Use strict suffix matching: `domain === origin || origin.endsWith('.' + domain)` after stripping the protocol.

### M-2: Hardcoded PBKDF2 salt for session encryption

**File**: `apps/api/src/lib/session-manager.ts` (lines 84-85)

A static salt `"trellis-session-salt-v1"` is used by default. If the derivation process is discovered, all sessions encrypted with the same secret share an identical derived key.

**Fix**: Either mandate `SESSION_SALT` as a required environment variable with a random value, or use a per-encryption random salt stored alongside the ciphertext.

### M-3: MFA optional in Cognito for production

**File**: `infra/lib/stacks/auth-stack.ts` (line 220)

`mfa: cognito.Mfa.OPTIONAL` — MFA should be required for production, especially for admin accounts.

**Fix**: Set `mfa: cognito.Mfa.REQUIRED` in prod config, or at minimum require MFA for admin roles.

### M-4: RDS Multi-AZ disabled in production

**File**: `infra/lib/config/prod.ts`

No automatic failover during an AZ outage. RTO/RPO are undefined for the production database.

**Fix**: Enable `multiAz: true` in prod config.

### M-5: No rate limiting on magic link generation

**File**: `apps/api/src/lambda/create-auth-challenge.ts`

An attacker can trigger unlimited magic link emails for any email address, enabling email bombing and brute-force attacks.

**Fix**: Add DynamoDB-based rate limiting (e.g., max 5 attempts per email per 15 minutes).

### M-6: Rate limiting fails open

**File**: `apps/api/src/lib/middleware.ts` (lines 243-251)

If the KV-backed rate limiter errors, requests are allowed through. For critical endpoints (admin, auth), this should fail closed.

**Fix**: Fail closed for admin/auth routes; fail open for general routes with incident logging.

### M-7: DynamoDB resource ARNs use `*:*` for region/account

**File**: `infra/lib/stacks/auth-stack.ts` (lines 46, 64, 140, 177)

Lambda DynamoDB policies use `arn:aws:dynamodb:*:*:table/...` instead of scoping to the specific region and account.

**Fix**: Use `${this.region}:${this.account}` in the ARN.

### M-8: S3 media bucket versioning disabled

**File**: `infra/lib/stacks/cdn-stack.ts` (line 36)

User-uploaded media cannot be recovered if accidentally deleted or overwritten.

**Fix**: Enable `versioned: true` with lifecycle rules to expire old versions after 30 days.

### M-9: Deploy script lacks stage validation

**File**: `scripts/deploy.sh` (lines 5-8)

No validation on the `STAGE` parameter. An invalid stage silently falls through to CDK with defaults.

**Fix**: `[[ "$STAGE" =~ ^(dev|prod)$ ]] || { echo "Invalid stage"; exit 1; }`

### M-10: Test credentials in CI workflow

**File**: `.github/workflows/deploy.yml` (lines 21, 48, 66)

Hardcoded test credentials (`trellis_test`, `test-secret-32-bytes-minimum-here`) appear in the workflow file. While these are for testing only, they establish bad patterns.

**Fix**: Use GitHub Actions secrets even for test credentials.

### M-11: Excessive console.log in media routes

**File**: `apps/api/src/lib/routes/media.ts` (lines 179-515)

Production logging exposes file access patterns, object-storage key structures, and cache behavior. (The media pipeline now uses S3 as the primary store; legacy R2 bucket bindings may still appear in `media.ts`.)

**Fix**: Replace `console.log` with structured Logger at DEBUG level.

### M-12: CSRF token never expires independently of session

**File**: `apps/api/src/lib/csrf.ts` (lines 64-67)

The CSRF token lives as long as the session (up to 90 days) without rotation. This increases the window for token theft.

**Fix**: Rotate CSRF tokens periodically (e.g., every 24 hours) or on privilege escalation.

### M-13: JWT hardcoded 1-hour expiration ignores actual `exp` claim

**File**: `apps/api/src/lib/session-manager.ts` (line 232)

When creating a session from a Cognito JWT, the expiration is hardcoded to 1 hour regardless of the token's actual `exp` claim.

**Fix**: Use `Math.min(hardcodedMax, claims.exp * 1000)` to respect the shorter of the two.

### M-14: Pre-token-generation Lambda doesn't check user suspension status

**File**: `apps/api/src/lambda/pre-token-generation.ts` (lines 30-67)

Claims are cached for 1 hour. A suspended user continues to receive valid tokens until the cache expires.

**Fix**: Check `user.status` and `user.suspendedUntil` on every token generation, or reduce cache TTL to 5 minutes.

---

## Low Findings

### L-1: GitHub Actions role assumption without IP restrictions

**File**: `.github/workflows/deploy.yml` (lines 33-36)

Any GitHub Actions workflow in any branch can assume the deploy role. Add IP conditions or branch restrictions to the IAM trust policy.

### L-2: ECR scan-on-push without deployment gating

**File**: `infra/lib/stacks/storage-stack.ts` (line 35)

Vulnerability scans run but don't block deployment of images with CRITICAL findings.

### L-3: RDS backup retention only 7 days in prod

**File**: `infra/lib/config/prod.ts`

May be insufficient for compliance. Consider 30+ days.

### L-4: Route 53 hosted zone IDs in source code

**File**: `infra/lib/config/dev.ts`, `infra/lib/config/prod.ts`

Not secrets, but leak AWS infrastructure details. Consider SSM parameters.

### L-5: Cookie clearing sends 6 Set-Cookie headers

**File**: `apps/api/src/lib/session-manager.ts` (lines 556-603)

Overly aggressive clearing of cookie variations. Consolidate to 2-3 variations.

### L-6: CSP allows `unsafe-inline` for styles

**File**: `apps/api/src/lib/security-headers.ts` (line 29)

Enables CSS injection vectors. Move to nonce-based or hash-based style loading.

### L-7: DynamoDB point-in-time recovery enabled but untested

**File**: `infra/lib/constructs/single-table.ts` (line 27)

Recovery is enabled (good) but recovery procedures are not documented or tested.

---

## Secure Patterns Observed

The codebase gets many things right:

- **Parameterized queries** — All raw SQL uses Prisma template literal syntax; no string concatenation
- **AES-256-GCM session encryption** — PBKDF2 key derivation with 100k iterations, random IV per encryption
- **Zod validation** — Consistent schema validation at handler boundaries
- **CSRF with constant-time comparison** — Proper double-submit cookie pattern
- **Magic-number file validation** — Prevents MIME type spoofing for uploads
- **Content-addressed storage** — SHA-256 hashing for media deduplication
- **Error sanitization** — Strips connection strings, file paths, and stack traces from responses
- **HttpOnly + Secure cookies** — Session cookies properly configured
- **Security headers** — CSP, HSTS with preload, X-Frame-Options, X-Content-Type-Options
- **DynamoDB encryption at rest** — Enabled on single table
- **S3 encryption** — Server-side encryption enabled
- **RDS encryption** — Storage encryption enabled
- **ECS in private subnets** — API containers not directly internet-accessible

---

## Remediation Priorities

### Immediate (before production launch)

1. **C-1**: Hash magic link tokens before DynamoDB storage
2. **C-2**: Scope SES IAM policies to specific identity ARNs
3. **H-1**: Deploy CloudFront WAF
4. **H-2**: Enforce session secret minimum length
5. **H-3**: Add startup environment validation
6. **M-1**: Fix CORS domain matching
7. **H-7**: Set ECR tag immutability

### Short-term (next 2 sprints)

8. **H-4**: Implement JWKS refresh
9. **M-3**: Require MFA in production
10. **M-4**: Enable RDS Multi-AZ in prod
11. **M-5**: Rate-limit magic link generation
12. **M-6**: Fail-closed rate limiting for admin routes
13. **M-2**: Randomize PBKDF2 salt

### Medium-term (quarterly review)

14. **H-6**: Audit wildcard IAM policies as AWS adds resource scoping
15. **M-14**: Reduce pre-token-generation cache TTL
16. **M-12**: Implement CSRF token rotation
17. **L-2**: Gate deployments on ECR scan findings
18. **L-3**: Increase RDS backup retention
