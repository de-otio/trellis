# IPv4 Cost Reduction Options

## Current Public IPv4 Inventory

| Resource | IPs | Cost/day | Source |
|----------|-----|----------|--------|
| ALB (1 per AZ × 2 AZs) | 2 | $0.24 | `api-stack.ts` — internet-facing ALB in public subnets |
| NAT instance (EIP) | 1 | $0.12 | `network-stack.ts` — t4g.nano in public subnet |
| **Total** | **3** | **$0.36** | **~$10.80/month** |

AWS charges $0.005/hr per public IPv4 address ($3.60/month each).

---

## Option 1: CloudFront VPC Origin — Make ALB Internal

**Saves: $0.24/day ($7.20/month) — eliminates 2 of 3 IPs**

CloudFront VPC Origins (GA Dec 2024) let CloudFront connect directly to an
internal ALB over the AWS private network. The project already routes all
traffic through CloudFront (`cdn-stack.ts` lines 134-141), so the ALB does not
need to be internet-facing.

### Changes required

- `network-stack.ts`: ALB no longer needs public subnets (but public subnets
  stay for NAT instance)
- `api-stack.ts`:
  - Change ALB to `internetFacing: false`, move to private subnets
  - Remove the HTTP→HTTPS redirect listener (CloudFront handles TLS)
  - Remove or update the Route 53 A record for `api.example.com` (CloudFront
    is the only entry point)
  - ALB security group: restrict ingress to CloudFront managed prefix list
    (`com.amazonaws.global.cloudfront.origin-facing`) instead of `anyIpv4()`
- `cdn-stack.ts`:
  - Change `/api/*` origin from `HttpOrigin(apiDomain)` to a VPC origin
    pointing at the internal ALB
  - Create `cloudfront.CfnVpcOrigin` referencing ALB ARN, private subnets, and
    a security group

### Risk

Low. CloudFront already fronts the ALB. The ALB WAF stays in place. The only
behavioral change is that the ALB is no longer directly reachable from the
internet, which is a security improvement.

### Consideration

`api.example.com` currently resolves directly to the ALB. If anything bypasses
CloudFront to hit the API directly (health checks in deploy scripts, ECS exec
debugging, internal tools), those paths would break. Audit `scripts/deploy.sh`
smoke tests and any direct API references.

---

## Option 2: Dualstack ALB Without Public IPv4

**Saves: $0.24/day ($7.20/month) — eliminates 2 of 3 IPs**

ALB supports `IpAddressType.DUAL_STACK_WITHOUT_PUBLIC_IPV4`, which assigns only
IPv6 addresses (no public IPv4). CloudFront connects to the ALB over IPv6.

### Changes required

- `api-stack.ts`: Set `ipAddressType: elbv2.IpAddressType.DUAL_STACK_WITHOUT_PUBLIC_IPV4`
- `network-stack.ts`: Enable IPv6 on the VPC (`assignIpv6AddressOnCreation` for
  public subnets)
- `api-stack.ts`: Update Route 53 to AAAA record only (or remove if CloudFront
  is the sole entry point)
- ALB security group: Add `anyIpv6()` ingress rules alongside existing IPv4 rules

### Risk

Medium. Direct IPv4 access to `api.example.com` stops working. This is fine if
CloudFront is the only client, but breaks any IPv4-only tools or scripts that
hit the ALB directly. Also requires VPC IPv6 enablement which touches multiple
stacks.

### Why Option 1 is likely better

Option 1 (VPC Origin) achieves the same savings with less VPC-level change and
the added security benefit of making the ALB unreachable from the internet
entirely. Option 2 still leaves the ALB internet-facing (just IPv6-only).

---

## Option 3: Replace NAT Instance with Egress-Only IGW + NAT64

**Saves: $0.12/day ($3.60/month) — eliminates the last IP**

Enable IPv6 on the VPC, use an egress-only internet gateway (free) for IPv6
egress, and DNS64/NAT64 to translate IPv4 destinations.

### Changes required

- `network-stack.ts`:
  - Add IPv6 CIDR to VPC
  - Enable IPv6 on private subnets
  - Add egress-only internet gateway
  - Enable DNS64 on private subnets
  - Add NAT64 (NAT Gateway with `connectivityType: PUBLIC` in IPv6 mode)
- All security groups: Add IPv6 rules

### Risk

High. NAT64 still requires a NAT Gateway ($0.045/hr = $1.08/day = **more
expensive** than the current NAT instance). AWS does not offer a free NAT64
path. The DNS64/NAT64 combo also adds complexity and latency for IPv4-only
destinations (OpenAI API, Google Safe Browsing).

### Verdict: Not cost-effective

NAT64 requires a NAT Gateway which costs **9x more** than the current NAT
instance. This option only makes sense if all external dependencies support
IPv6 (they don't — OpenAI's API is IPv4-only as of 2025).

---

## Option 4: Eliminate NAT Instance with VPC Endpoints

**Saves: $0.12/day — but costs more in VPC endpoint fees**

Replace the NAT instance with PrivateLink interface endpoints for each AWS
service the Fargate tasks and VPC Lambdas need to reach.

### Required endpoints

| Service | Type | Cost/hr (2 AZs) |
|---------|------|------------------|
| ECR API (`ecr.api`) | Interface | $0.02 |
| ECR Docker (`ecr.dkr`) | Interface | $0.02 |
| CloudWatch Logs | Interface | $0.02 |
| SSM | Interface | $0.02 |
| Secrets Manager | Interface | $0.02 |
| SQS | Interface | $0.02 |
| STS | Interface | $0.02 |
| X-Ray | Interface | $0.02 |
| SES | Interface | $0.02 |
| S3 (gateway) | Gateway | Free (already deployed) |
| DynamoDB (gateway) | Gateway | Free (already deployed) |

**Interface endpoint cost: 9 × $0.02/hr = $0.18/hr = $4.32/day**

### Verdict: Much more expensive

VPC endpoints would cost $4.32/day vs. the current NAT instance at $0.12/day
(36x more expensive). Only makes sense if you also need to eliminate internet
egress for compliance reasons.

### Partial approach

You could add only the gateway endpoints (already done — S3 and DynamoDB are
free) and keep the NAT instance for everything else. This is already the
current setup.

---

## Option 5: Move External API Calls Out of VPC

**Saves: $0.12/day ($3.60/month) — eliminates the last IP, IF combined with VPC endpoints or other changes**

Move OpenAI and Google Safe Browsing calls to non-VPC Lambda functions (which
get free internet access). Then the only reason for the NAT instance is AWS
service access from Fargate.

This alone doesn't save anything — Fargate still needs the NAT instance for ECR
image pulls, CloudWatch Logs, SSM, and Secrets Manager. You'd need to pair it
with VPC endpoints (Option 4), which is too expensive.

### Verdict: Only useful as part of a larger change

---

## Recommendation

| Option | Saves/month | Effort | Risk |
|--------|-------------|--------|------|
| **1. CloudFront VPC Origin (internal ALB)** | **$7.20** | Medium | Low |
| 2. Dualstack ALB without IPv4 | $7.20 | Medium | Medium |
| 3. NAT64 | -$28.80 (costs more) | High | High |
| 4. VPC endpoints (replace NAT) | -$126.00 (costs more) | Medium | Low |
| 5. Move API calls out of VPC | $0 alone | Low | Low |

**Do Option 1.** It saves 67% of the IPv4 cost ($7.20/month), improves security
by making the ALB unreachable from the public internet, and is a
straightforward change given CloudFront already fronts all traffic.

**Keep the NAT instance.** At $3.60/month, the t4g.nano NAT instance is the
cheapest possible egress path. Every alternative (NAT Gateway, VPC endpoints,
NAT64) costs significantly more. The NAT instance is already well-monitored
with CloudWatch alarms.

**Net result: $0.24/day → $0.12/day (save $7.20/month, or ~$86/year).**

---

## Implementation (Option 1)

Option 1 has been implemented as a config toggle: `network.albInternetFacing`.

### Files changed

| File | Change |
|------|--------|
| `infra/lib/config/index.ts` | Added `albInternetFacing` to `NetworkConfig` (default: `false`) |
| `infra/lib/config/dev.ts` | Set `albInternetFacing: false` |
| `infra/lib/config/prod.ts` | Set `albInternetFacing: true` (flip after validating in dev) |
| `infra/lib/stacks/network-stack.ts` | ALB SG: `anyIpv4()` when internet-facing, CloudFront managed prefix list when internal |
| `infra/lib/stacks/api-stack.ts` | ALB in public/private subnets based on toggle; Route 53 A record only when internet-facing; publishes ALB ARN to SSM |
| `infra/lib/stacks/cdn-stack.ts` | Uses `HttpOrigin` or `VpcOrigin.withApplicationLoadBalancer` based on toggle; adds `api.{zone}` as CloudFront alternate domain when internal; creates Route 53 A + AAAA records for `api.{zone}` → CloudFront |

### Rollback

Flip `albInternetFacing: true` and deploy. All conditionals revert to the
original internet-facing behavior.

### Migration: switching from internet-facing to internal

The CdnStack reads `alb-arn` and `alb-sg-id` from SSM. On a fresh switch, the
`alb-arn` param may not exist yet (it's new). Deploy in two steps:

1. **Deploy 1 (seed SSM param):** Keep `albInternetFacing: true`, deploy
   ApiStack. This writes the new `alb-arn` SSM parameter with no behavior
   change.
2. **Deploy 2 (flip toggle):** Set `albInternetFacing: false`, deploy all
   stacks. NetworkStack restricts the ALB SG, ApiStack moves ALB to private
   subnets, CdnStack switches to VPC Origin.

For prod, validate in dev first, then repeat the same two-step process.

### Data processing cost

CloudFront VPC Origins charge $0.01/GB for data transferred to the origin.
Break-even vs. IPv4 savings is ~720 GB/month of API traffic (~90 req/sec
sustained at 3 KB avg response). At current scale this cost is negligible.

### What stays unchanged

- Public subnets remain (NAT instance needs them)
- ALB certificate, WAF, target groups, and health checks are unchanged
- The HTTP→HTTPS redirect listener stays (harmless on an internal ALB)
- ECS Exec debugging works (goes through SSM, not the ALB)
