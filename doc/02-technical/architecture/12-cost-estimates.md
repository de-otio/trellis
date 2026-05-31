# Cost Estimates and Controls

## Monthly Cost Estimate

**Assumptions**: ~1,000 DAU, ~10,000 API requests/day, ~500 media uploads/month, ~5 GB stored. Region: `eu-central-1`. Prices as of March 2026.

### Itemized Breakdown

| Category | Service | Configuration | Monthly Cost |
|----------|---------|--------------|-------------|
| **Compute** | Fargate (API) | 0.25 vCPU, 0.5 GB, ARM64, Spot | ~$5.00 |
| | ALB | Minimum fixed cost + LCU | ~$16.00 |
| | Lambda (Workers) | ~50K invocations, 256-512 MB, avg 100-500ms | $0.30 |
| | Lambda (Crons) | ~13K invocations, 256 MB, avg 100ms | $0.05 |
| | Lambda (Cognito triggers) | ~5K invocations, 256 MB, avg 50ms | $0.01 |
| **Database** | RDS PostgreSQL | db.t4g.micro, single AZ | $12.00 |
| | RDS storage | 20 GB gp3 | $2.30 |
| | RDS backup | 7-day retention (free up to DB size) | $0.00 |
| **Storage & CDN** | S3 (media) | 5 GB stored, ~500 PUTs, ~50K GETs | $0.15 |
| | S3 (web app) | ~50 MB, ~10K GETs | $0.01 |
| | CloudFront | 10 GB transfer, 100K requests (free tier) | $0.00 |
| **Auth** | Cognito | < 50K MAU (free tier) | $0.00 |
| **Async & Caching** | SQS (6 queues + 6 DLQs) | ~100K messages/month | $0.00 |
| | DynamoDB (on-demand) | ~1M reads, ~340K writes | $0.68 |
| | EventBridge Scheduler | 4 rules | $0.00 |
| **Email** | SES | ~500 emails/month (free from AWS compute) | $0.00 |
| **Networking** | NAT Instance | t4g.nano (outbound internet from private subnet) | ~$3.00 |
| | S3 Gateway Endpoint | Free | $0.00 |
| | DynamoDB Gateway Endpoint | Free | $0.00 |
| **Monitoring** | CloudWatch Logs | ~1 GB ingested, 14-day retention | $0.50 |
| | CloudWatch Metrics | Custom metrics + Container Insights | $0.30 |
| | CloudWatch Alarms | ~20 alarms (10 free) | $1.00 |
| | X-Ray | ~30K traces (free tier: 100K) | $0.00 |
| **Container Registry** | ECR | ~1 GB stored (10 images × ~100 MB) | $0.10 |
| **External APIs** | OpenAI Moderation | Budget-capped at $10/month | $0–10.00 |
| | Google Safe Browsing | Budget-capped at $5/month | $0–5.00 |

### Total

| Category | Monthly Cost |
|----------|-------------|
| Compute (Fargate + Lambda + ALB) | $21.36 |
| Database (RDS) | $14.30 |
| Storage & CDN (S3 + CloudFront) | $0.16 |
| Auth (Cognito) | $0.00 |
| Async & Caching (SQS + DynamoDB) | $0.68 |
| Email (SES) | $0.00 |
| Networking (NAT Instance) | $3.00 |
| Monitoring | $1.80 |
| Container Registry (ECR) | $0.10 |
| External APIs | $0–15.00 |
| **Total** | **~$41–56/month** |

> No RDS Proxy needed — Fargate handles connection pooling natively. Saves $22/month vs a Lambda-based API.

## Scaling Projections

| Traffic Level | Fargate | Lambda | ALB | RDS | Total |
|---------------|---------|--------|-----|-----|-------|
| Pre-launch (10K req/day) | $5 | $0.36 | $16 | $14 | ~$41 |
| Early users (100K req/day) | $5 | $1 | $16 | $14 | ~$42 |
| Growing (1M req/day) | $15 (2 tasks) | $5 | $18 | $24 (t4g.small) | ~$68 |
| Scaling (10M req/day) | $40 (4 tasks, 0.5 vCPU) | $20 | $25 | $48 (t4g.medium) | ~$140 |

Costs scale sub-linearly with traffic. The ALB fixed cost ($16) dominates at low traffic but becomes negligible at scale.

### Free Tier Notes

For a **new AWS account**, the first-year cost could be as low as **~$25/month** (mainly ALB + NAT Instance):

| Service | Free tier |
|---------|-----------|
| Lambda | 1M requests/month (permanent) |
| DynamoDB | 25 GB + 25 WCU + 25 RCU (permanent) |
| S3 | 5 GB (12-month) |
| CloudFront | 1 TB transfer + 10M requests (12-month) |
| Cognito | 50K MAU (permanent) |
| SQS | 1M requests (permanent) |
| SES | 3,000 emails/month from AWS compute (permanent) |
| CloudWatch | 10 custom metrics, 10 alarms (permanent) |
| X-Ray | 100K traces (permanent) |
| RDS | 750 hours/month of db.t4g.micro (12-month) |

---

## Cost Protection Strategy

Costs are controlled by nine independent layers. No single layer is sufficient alone — the strategy relies on defense in depth.

### Layer 1: AWS Budget Alarms + Enforcement

AWS Budget alarms trigger at 50%, 80%, and 100% of the monthly budget ($75 dev, $150 prod). At 100% actual spend, an AWS Budget Action automatically attaches an IAM deny policy to the ECS task role, blocking `sqs:SendMessage`, `s3:PutObject`, `ses:SendEmail`, and `ses:SendRawEmail`. The API stays up for reads but stops generating new costs.

Recovery: detach the policy in AWS Console or wait for the next billing period.

### Layer 2: Fargate Auto-Scaling Hard Cap

The Fargate service is configured with `maxCapacity: 4`. At 0.25 vCPU / 0.5 GB Spot, 4 tasks ≈ $20/month compute. This is the physical compute ceiling.

### Layer 3: Lambda Reserved Concurrency Limits

Every Lambda function has `reservedConcurrentExecutions` set. Total reserved across all functions: ~55, well under the 100 account-wide limit. Recursive Lambda protection:
- Concurrency limit caps simultaneous executions
- SQS `maxReceiveCount: 3` routes to DLQ after 3 failures
- S3 event filters (`prefix: 'originals/'`) prevent derivative files from re-triggering the image processor

### Layer 4: ALB + CloudFront Rate Limiting

CloudFront absorbs cacheable traffic and provides DDoS protection via Shield Standard (free). Application-level rate limiting uses DynamoDB atomic counters with TTL for per-user and per-IP limits.

### Layer 5: SQS Safeguards

Every queue has:
- `maxReceiveCount: 3` — messages go to DLQ after 3 failures
- Message TTL of 1–7 days — prevents unbounded queue growth
- DLQ CloudWatch alarm — alerts when processing is failing persistently

### Layer 6: OpenAI Request Budget

`OpenAiBudget` (`apps/api/src/lib/openai-budget.ts`) uses atomic DynamoDB counters to track OpenAI moderation calls per hour and per day. When the budget is exceeded, moderation is skipped and the post is flagged for deferred review. A CloudWatch alarm fires on the custom metric `Trellis/CostProtection/OpenAiBudgetExceeded`.

| Environment | Hourly limit | Daily limit | Max daily cost |
|-------------|-------------|-------------|----------------|
| dev         | 200         | 1,000       | ~$1            |
| prod        | 1,000       | 10,000      | ~$10           |

Fail-open: DynamoDB errors allow the call through. Kill switch: `OPENAI_BUDGET_ENABLED=false`.

### Layer 7: Cost Accumulator + Per-Service Controls

`CostAccumulator` (`apps/api/src/lib/cost-accumulator.ts`) tracks counts of expensive operations (OpenAI, SQS, S3, SES, DynamoDB) in-memory and flushes to DynamoDB every 10 seconds. The admin endpoint `GET /api/admin/costs` (SUPER_ADMIN only) exposes real-time estimated spend by service.

Additional per-service controls:
- **OpenAI Moderation**: results cached by content hash for 24 hours, 2-second timeout (fail-open)
- **Google Safe Browsing**: results cached for 24 hours, batched up to 500 URLs per API call
- **SES**: rate-limited to 1 email/second

### Layer 8: AWS Service Quotas (Account-Level Caps)

Quota reduction requests act as a hard backstop:

| Service | Default | Requested |
|---------|---------|-----------|
| Lambda concurrent executions | 1,000 | 100 |
| Fargate tasks per service | 5,000 | 10 |
| SQS messages per queue | Unlimited | 100,000 |

### Layer 9: DynamoDB Throughput Alarms

DynamoDB on-demand has no inherent upper limit. Two CloudWatch alarms provide early warning:
- **Write spike**: fires if consumed WCU exceeds 200/minute sustained over 2 consecutive minutes
- **Read spike**: fires if consumed RCU exceeds 500/minute sustained over 2 consecutive minutes

Both alarms notify via the monitoring SNS topic.

### Emergency Response

If costs spike despite all guardrails:

1. **Scale Fargate to zero**: `aws ecs update-service --desired-count 0`
2. **Silence Lambda**: `aws lambda put-function-concurrency --reserved-concurrent-executions 0`
3. **Investigate**: CloudWatch Logs, Cost Explorer, DynamoDB metrics
4. **Fix root cause**
5. **Restore**: scale back up

### Cost Control Flow

```
  External Traffic
        │
   [CloudFront + Shield Standard]   ← DDoS protection (free)
        │
   [WAF Rate Limiting]              ← 2,000 req/5min per IP → 403
        │
   [ALB Health Checks]              ← Only route to healthy tasks
        │
   [Fargate maxCapacity: 4]         ← Layer 2: max 4 tasks
        │
   [App Rate Limiting (DynamoDB)]   ← Layer 4: per-user/IP limits
        │
   [OpenAI Request Budget]          ← Layer 6: hourly/daily caps → deferred moderation
        │
   [Cost Accumulator]               ← Layer 7: in-memory tracking → admin endpoint
        │
   [Lambda Concurrency Limits]      ← Layer 3: per-function caps
        │
   [SQS Max Receive + DLQ]          ← Layer 5: 3 retries then stop
        │
   [DynamoDB Throughput Alarms]     ← Layer 9: write + read spike alerts
        │
   [AWS Budget Enforcement]         ← Layer 1: IAM deny policy at 100% spend
        │
   [Service Quotas]                 ← Layer 8: account-level caps
```
