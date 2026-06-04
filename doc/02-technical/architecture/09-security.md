# Security Architecture

## Network Security

### VPC Layout

```
VPC: 10.0.0.0/16 (subnets in 2 AZs, deploy to 1 initially)

  Public Subnets
  ├── 10.0.1.0/24    ← ALB, NAT Instance
  └── 10.0.2.0/24    ← (reserved for 2nd AZ)

  Private Subnets
  ├── 10.0.10.0/24   ← Fargate tasks, Lambda workers (VPC)
  └── 10.0.11.0/24   ← (reserved for 2nd AZ)

  Isolated Subnets
  ├── 10.0.20.0/24   ← RDS (no internet access)
  └── 10.0.21.0/24   ← (reserved for 2nd AZ)
```

- **Fargate tasks** run in the private subnet — can reach RDS directly and internet via NAT Instance
- **Lambda workers** (VPC-attached) run in the private subnet — same access as Fargate
- **Lambda workers** (non-VPC) run outside the VPC — can reach DynamoDB, S3, SQS, SES, external APIs directly
- **RDS** runs in the isolated subnet — no internet access, only reachable from private subnet
- **NAT Instance** in the public subnet — outbound internet for Fargate and VPC Lambdas

### Security Groups

| Resource | Inbound | Outbound |
|----------|---------|----------|
| ALB | TCP 443 from 0.0.0.0/0 | TCP 3000 to Fargate SG |
| Fargate | TCP 3000 from ALB SG only | TCP 5432 to RDS SG, TCP 443 to internet |
| RDS | TCP 5432 from Fargate SG, TCP 5432 from Lambda SG | None |
| Lambda (VPC) | None (invoked by service) | TCP 5432 to RDS SG, TCP 443 to internet |
| NAT Instance | All from Fargate SG + Lambda SG | All to internet |

## IAM (Least Privilege)

### Fargate Task Roles

Key principle: **separate execution role (ECS agent) from task role (application code)**.

The task role grants:
- S3: GetObject, PutObject, DeleteObject (media bucket only)
- SQS: SendMessage (all 6 queues)
- DynamoDB: GetItem, PutItem, UpdateItem, DeleteItem, Query (single table + GSI)
- SES: SendEmail, SendRawEmail (restricted to `noreply@example.com`)
- SSM: GetParameter, GetParametersByPath (`/trellis/{stage}/*`)
- X-Ray: Write access (via managed policy)

### Lambda Worker Roles

Each worker gets a narrower role. For example, `mediaProcessingWorker`:
- S3: GetObject + PutObject (media bucket only)
- SQS: ReceiveMessage + DeleteMessage (media-processing queue only)
- DynamoDB: PutItem (to update processing status)

Non-VPC workers (linkCheckWorker, federationOutboxWorker) have no RDS access — they write results to DynamoDB or SQS, which the Fargate API reads.

## Secrets Management

### SSM Parameter Store (Primary)

The current project already uses AWS SSM for secrets. Continue this pattern:

```
/trellis/dev/database-url             → RDS connection string (SecureString)
/trellis/dev/cognito-user-pool-id     → Cognito pool ID (String)
/trellis/dev/openai-api-key           → OpenAI key (SecureString)
/trellis/dev/google-safe-browsing-key → Google API key (SecureString)
/trellis/dev/recaptcha-secret         → reCAPTCHA key (SecureString)
```

SSM is free for standard parameters. Use SecureString (KMS-encrypted) for sensitive values.

### Secrets Injection

**Fargate**: Secrets injected via `ecs.Secret.fromSsmParameter()` in the task definition. They appear as environment variables at task launch but are never stored in the task definition itself.

**Lambda**: Read from SSM at cold start, cached in memory for the lifetime of the execution environment.

### RDS Credentials

Use Secrets Manager (not SSM) for the RDS password — it supports automatic rotation:

```typescript
const dbCredentials = new secretsmanager.Secret(this, 'DbCredentials', {
  generateSecretString: {
    secretStringTemplate: JSON.stringify({ username: 'trellis' }),
    generateStringKey: 'password',
    excludePunctuation: true,
    passwordLength: 30,
  },
});
```

## API Security

### Authentication
- **User requests**: Cognito JWT validated by application middleware in the Fargate container (see [05-auth.md](05-auth.md))
- **ActivityPub**: HTTP Signatures validated by Fedify middleware (see [07-activitypub.md](07-activitypub.md))
- **Health check**: No auth (public)

### Authorization
- JWT claims include `custom:role` — handlers check role before proceeding
- Admin endpoints require `INTERNAL` or `SUPER_ADMIN` role
- Partner endpoints require `B2B_PARTNER` or `PARTNER_ADMIN` role

### Input Validation
- **Zod schemas** for all request bodies (carried from current codebase)
- **ALB payload limit**: Configurable (default 1 MB, can increase)
- **Parameter validation**: Path/query params validated in handler

### Rate Limiting
- **Application-level**: DynamoDB-backed per-user/IP rate limiting (see [11-dynamodb-single-table.md](11-dynamodb-single-table.md))
- **Federation**: Per-domain rate limiting for ActivityPub inbox (see [07-activitypub.md](07-activitypub.md))
- **CloudFront**: Shield Standard (free) absorbs volumetric DDoS

### Security Headers

Applied via CloudFront Response Headers Policy (at the edge, no application overhead):

```typescript
// CDK
const headersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
  securityHeadersBehavior: {
    strictTransportSecurity: {
      accessControlMaxAge: Duration.seconds(63072000),
      includeSubdomains: true,
      preload: true,
      override: true,
    },
    contentTypeOptions: { override: true },
    frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
    referrerPolicy: {
      referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
      override: true,
    },
    xssProtection: { protection: true, modeBlock: true, override: true },
  },
  customHeadersBehavior: {
    customHeaders: [
      { header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)', override: true },
    ],
  },
});
```

## Data Protection

### Encryption at Rest
- **RDS**: AES-256 (AWS managed key)
- **S3**: SSE-S3 (AES-256)
- **DynamoDB**: AES-256 (AWS managed key, free)
- **SSM SecureString**: AWS KMS encryption
- **ECR images**: AES-256

### Encryption in Transit
- **All connections**: TLS 1.2+ enforced
- **CloudFront → ALB**: HTTPS only
- **CloudFront → S3**: OAC (Origin Access Control) — see [04-storage-cdn.md](04-storage-cdn.md)
- **Fargate → RDS**: TLS (direct connection, no proxy)
- **Client → CloudFront**: TLS 1.3 with ACM certificate

### Data Residency
- All data stays in `eu-central-1` (Frankfurt) initially
- CN region: separate stack in `cn-north-1` with separate RDS, S3, etc. (future)

## Audit Logging

Port the existing `SecurityEvent` model. Events written to RDS with retention policies:

| Severity | Retention | Examples |
|----------|-----------|---------|
| CRITICAL | 365 days | Account deletion, role escalation |
| HIGH | 90 days | Failed logins, MFA bypass attempts |
| MEDIUM | 30 days | Password changes, session creation |
| LOW | 7 days | Successful logins, profile updates |

CloudWatch Logs provide infrastructure-level audit trail (ALB access logs, Fargate container logs, Lambda invocation logs).

## WAF (Future)

AWS WAF is not included initially ($5+/month). When needed:
- Attach to CloudFront distribution (or ALB)
- Managed rule groups: AWSManagedRulesCommonRuleSet, AWSManagedRulesKnownBadInputsRuleSet
- Rate-based rules for DDoS mitigation
- Geo-blocking if needed
