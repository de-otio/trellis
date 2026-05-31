# Magic Link Abuse Protection Analysis

**Date:** 2026-03-22
**Status:** Partially Implemented (R1, R3 done; R2, R4, R5, R6 pending)

## Overview

This document analyzes how the Trellis magic link authentication flow is protected against abuse (bot-driven enumeration, credential stuffing, email bombing) and identifies gaps in the current defenses.

## Current Protections

### Layer 1: Cognito Lambda Rate Limiting

**File:** `apps/api/src/lambda/create-auth-challenge.ts`

- 5 magic link requests per email per 15-minute window
- Tracked via DynamoDB counters with TTL
- Returns `RATE_LIMIT_EXCEEDED` when threshold is hit

**Strengths:**
- Per-email granularity prevents targeted email bombing
- DynamoDB-backed so it works across Lambda invocations

**Weaknesses:**
- Does not limit total requests across all emails from a single source
- An attacker can rotate across many email addresses to stay under per-email limits

### Layer 2: AWS WAF on ALB

**File:** `infra/lib/stacks/network-stack.ts` (lines ~260-309)

- IP-based rate limit: 2,000 requests per IP per 5-minute window
- AWS Managed Common Rule Set (`AWSManagedRulesCommonRuleSet`)

**Strengths:**
- Blocks high-volume IP-based attacks before they reach the application
- Common Rule Set catches known malicious patterns (SQL injection, XSS, etc.)

**Weaknesses:**
- IP rate limit is generous (2,000/5min) and may not catch low-and-slow attacks
- No bot detection or fingerprinting
- No CAPTCHA challenge for suspicious requests
- Only attached to the ALB, not CloudFront

### Layer 3: Application-Level Rate Limiting

**File:** `apps/api/src/lib/rate-limit.ts`

- In-memory rate limiter per API instance
- Not shared across ECS tasks (resets on restart/deploy)

**Strengths:**
- Provides a basic safety net for API routes

**Weaknesses:**
- Not distributed; ineffective with multiple ECS tasks
- Does not apply to the Cognito auth flow (magic links bypass the API)

### Layer 4: reCAPTCHA

**File:** `apps/api/src/lib/recaptcha.ts`

- Google reCAPTCHA v2 (checkbox) and v3 (score-based, threshold 0.5) support exists
- Site key served at `/auth/recaptcha-site-key`

**Strengths:**
- Infrastructure is in place

**Weaknesses:**
- Client-initiated only; not enforced server-side on the auth path
- Cognito `InitiateAuth` calls go directly to Cognito, bypassing any API-level reCAPTCHA check

### Token Security (Not Abuse Prevention, but Relevant)

- Tokens generated with `randomBytes(32).toString("base64url")`
- SHA-256 hashed before storage in DynamoDB
- 5-minute TTL
- Verified with `timingSafeEqual()` to prevent timing attacks
- Deleted on successful use (single-use)

## Gaps

| Gap | Risk | Severity |
|-----|------|----------|
| No AWS WAF Bot Control | Automated scripts can request magic links at scale | High |
| No WAF CAPTCHA action | No interactive challenge for suspicious traffic | High |
| No CloudFront WAF | Edge traffic is unfiltered before reaching ALB | Medium |
| reCAPTCHA not enforced on auth flow | Bots can call Cognito `InitiateAuth` without solving a challenge | High |
| In-memory rate limiter not distributed | Rate limits reset per-task and are not shared across ECS fleet | Medium |
| No cross-email rate limit per IP | Attacker can rotate emails to bypass per-email limits | Medium |

## Recommendations

### R1: Add AWS WAF Bot Control (High Priority) — IMPLEMENTED

Added `AWSManagedRulesBotControlRuleSet` to the ALB WebACL via `WafConfig` in `StageConfig`.
Enabled in prod only (`botControl: true`, `botControlInspectionLevel: "TARGETED"`).
Dev uses base defaults (`botControl: false`). IP rate limit raised to 10,000/5min in prod.

Previously proposed CDK snippet for reference:

```typescript
{
  name: "BotControl",
  priority: 0,
  statement: {
    managedRuleGroupStatement: {
      vendorName: "AWS",
      name: "AWSManagedRulesBotControlRuleSet",
      managedRuleGroupConfigs: [
        { awsManagedRulesBotControlRuleSet: { inspectionLevel: "COMMON" } },
      ],
    },
  },
  overrideAction: { none: {} },
  visibilityConfig: {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: `trellis-${stage}-bot-control`,
  },
}
```

**Cost:** ~$10/month base + $1 per million requests at COMMON level. TARGETED level adds browser fingerprinting at higher cost.

### R2: Add WAF CAPTCHA Rule for Auth Endpoints (High Priority)

Add a WAF rule with a `captcha` action scoped to auth-related URI paths. This forces a browser-based CAPTCHA challenge before the request reaches Cognito or the API.

```typescript
{
  name: "AuthCaptcha",
  priority: 1,
  statement: {
    byteMatchStatement: {
      searchString: "/auth/",
      fieldToMatch: { uriPath: {} },
      positionalConstraint: "STARTS_WITH",
      textTransformations: [{ priority: 0, type: "LOWERCASE" }],
    },
  },
  action: {
    captcha: {
      customRequestHandling: undefined,
    },
  },
  visibilityConfig: {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: `trellis-${stage}-auth-captcha`,
  },
}
```

**Note:** WAF CAPTCHA requires the client to support the AWS WAF JS SDK integration. Evaluate whether the Flutter web client and mobile clients can handle the CAPTCHA token flow. For mobile-only flows, R3 may be more practical.

### R3: Enforce reCAPTCHA in the Cognito Challenge Flow (High Priority) — IMPLEMENTED

reCAPTCHA token is passed via `clientMetadata` during `InitiateAuth` and verified in
`createAuthChallenge` Lambda before generating the magic link. Enforcement is controlled by
the `RECAPTCHA_SECRET_KEY` env var (set via SSM in auth-stack.ts). When the secret is not
configured (dev), verification is skipped.

Previously proposed code pattern for reference:

```typescript
// In create-auth-challenge.ts, before generating the token:
const recaptchaToken = event.request.clientMetadata?.recaptchaToken;
if (!recaptchaToken) {
  throw new Error("RECAPTCHA_REQUIRED");
}
const isHuman = await verifyRecaptcha(recaptchaToken, process.env.RECAPTCHA_SECRET_KEY!);
if (!isHuman) {
  throw new Error("RECAPTCHA_FAILED");
}
```

**Advantages:** Works for both web and mobile clients. Doesn't require WAF JS SDK integration.

### R4: Attach a WebACL to CloudFront (Medium Priority)

Create a `CLOUDFRONT`-scoped WebACL in `cdn-stack.ts` with at minimum the rate limiting and common rules already on the ALB. This filters malicious traffic at the edge before it reaches the origin.

### R5: Add Cross-Email IP Rate Limiting (Medium Priority)

In the `createAuthChallenge` Lambda, add a second DynamoDB counter keyed by source IP (from `event.request.userAttributes` or forwarded headers). Limit to e.g. 20 magic link requests per IP per 15 minutes regardless of email address.

### R6: Migrate Application Rate Limiter to DynamoDB (Low Priority)

Replace the in-memory rate limiter in `rate-limit.ts` with DynamoDB-backed counters (same pattern as the Lambda rate limiter) so limits are shared across ECS tasks.

## Shared-IP False Positive Risk

The current WAF rate limit of 2,000 requests per IP per 5 minutes can block legitimate users
who share a public IP behind NAT (e.g. at an event, conference, or office).

### Estimated request volume per active user

| Activity | Requests/min |
|---|---|
| App open (feed, profile, config) | ~5-10 (burst) |
| Browsing/scrolling | ~3-6 |
| Posting, commenting, liking | ~1-2 per action |

**~10-15 requests/min per actively browsing user.**

### Shared NAT threshold

| Concurrent active users | Requests / 5 min (est.) | Hits 2,000 limit? |
|---|---|---|
| 20 | ~1,000-1,500 | No |
| 30 | ~1,500-2,250 | Borderline |
| 40+ | ~2,000-3,000 | **Yes — all users behind that IP blocked** |

When the WAF blocks an IP, every user behind that NAT is blocked for the remainder of the
evaluation window. There is no gradual degradation — it is a cliff.

**Conclusion:** The IP rate limit should be raised significantly and should not be the primary
abuse defense. Use Bot Control fingerprinting and auth-scoped CAPTCHA instead.

## Recommended Target Architecture

The long-term solution moves away from IP-only rate limiting toward signal-rich client
fingerprinting combined with scoped CAPTCHA challenges.

### Design principles

1. No single layer needs to be aggressive enough to cause false positives.
2. The IP rate limit is a volumetric safety net, not the primary defense.
3. Interactive challenges are scoped to the one action that has abuse potential (magic link request).
4. All users behind shared NAT pass through cleanly under normal usage.

### Layers

| Layer | Component | Purpose | Blocks |
|---|---|---|---|
| 1 | WAF Bot Control (Targeted) | Browser fingerprinting + JS challenges per client, independent of IP | Automated scripts, headless browsers |
| 2 | reCAPTCHA in Cognito Lambda | Interactive challenge on magic link request only | Sophisticated bots passing Layer 1 |
| 3 | Per-email + per-IP rate limiting (Lambda) | DynamoDB counters: 5/email/15min, 20/IP/15min | Targeted email bombing, distributed rotation |
| 4 | WAF global IP rate limit (high threshold) | Safety net: 10,000/5min per IP | Volumetric DDoS only |

### Threat coverage

| Threat | Blocked by |
|---|---|
| Automated bot scripts | Bot Control (fingerprinting) |
| Sophisticated bots passing JS challenges | reCAPTCHA on auth path |
| Targeted email bombing | Per-email Lambda rate limit |
| Distributed attack rotating emails | Per-IP Lambda rate limit + reCAPTCHA |
| Volumetric DDoS | WAF global rate limit (high threshold) |
| 100 real users at a meetup | Nothing — all layers pass them through |

### Per-environment configuration

WAF Bot Control costs ~$10/month base + $10/million requests at Targeted level. To avoid
this cost in dev/staging, the WAF config is controlled via `StageConfig`.

Add a `waf` group to `StageConfig` in `infra/lib/config/index.ts`:

```typescript
export interface WafConfig {
  /** IP-based rate limit per 5-minute window (WAF safety net) */
  ipRateLimit: number;
  /** Enable AWS Managed Bot Control rule group */
  botControl: boolean;
  /** Bot Control inspection level: "COMMON" (IP reputation) or "TARGETED" (JS fingerprinting) */
  botControlInspectionLevel: "COMMON" | "TARGETED";
}
```

Base defaults (applies to dev):

```typescript
waf: {
  ipRateLimit: 2000,
  botControl: false,
  botControlInspectionLevel: "COMMON",
},
```

Prod overrides in `infra/lib/config/prod.ts`:

```typescript
waf: {
  ipRateLimit: 10000,
  botControl: true,
  botControlInspectionLevel: "TARGETED",
},
```

Then in `network-stack.ts`, conditionally add the Bot Control rule:

```typescript
const rules: wafv2.CfnWebACL.RuleProperty[] = [
  {
    name: "RateLimit",
    priority: 1,
    action: { block: {} },
    statement: {
      rateBasedStatement: {
        limit: config.waf.ipRateLimit,
        aggregateKeyType: "IP",
      },
    },
    visibilityConfig: { /* ... */ },
  },
  {
    name: "AWSManagedRulesCommonRuleSet",
    priority: 2,
    overrideAction: { none: {} },
    statement: {
      managedRuleGroupStatement: {
        vendorName: "AWS",
        name: "AWSManagedRulesCommonRuleSet",
      },
    },
    visibilityConfig: { /* ... */ },
  },
];

if (config.waf.botControl) {
  rules.push({
    name: "BotControl",
    priority: 0,
    overrideAction: { none: {} },
    statement: {
      managedRuleGroupStatement: {
        vendorName: "AWS",
        name: "AWSManagedRulesBotControlRuleSet",
        managedRuleGroupConfigs: [
          {
            awsManagedRulesBotControlRuleSet: {
              inspectionLevel: config.waf.botControlInspectionLevel,
            },
          },
        ],
      },
    },
    visibilityConfig: {
      sampledRequestsEnabled: true,
      cloudWatchMetricsEnabled: true,
      metricName: `trellis-${stage}-bot-control`,
    },
  });
}
```

### Cost summary

| Component | Dev | Prod |
|---|---|---|
| WAF base | $5/month (WebACL) | $5/month |
| Bot Control (Targeted) | $0 (disabled) | ~$10/month + $10/M requests |
| Common Rule Set | Included | Included |
| reCAPTCHA (Google) | Free tier | Free tier (up to 1M/month) |
| DynamoDB rate-limit counters | Negligible (TTL cleanup) | Negligible |

## Implementation Priority

1. ~~**R3** — Enforce reCAPTCHA in Cognito Lambda~~ **DONE**
2. ~~**R1** — Add WAF Bot Control via `WafConfig`~~ **DONE** (prod-only, Targeted level)
3. ~~**Raise IP rate limit**~~ **DONE** (10,000/5min in prod)
4. **R5** — Cross-email IP rate limiting in Lambda (Cognito doesn't expose client IP; must use WAF)
5. **R4** — CloudFront WAF
6. **R2** — WAF CAPTCHA (requires client-side integration work)
7. **R6** — Distributed rate limiter (lower urgency, existing Lambda rate limiter covers auth)
