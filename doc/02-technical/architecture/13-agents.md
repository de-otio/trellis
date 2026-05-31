# AI Diagnostics Agent (AgentCore)

## Purpose

CloudWatch alarms detect problems (error rates, DLQ depth, unhealthy tasks). When an alarm fires, the diagnostics agent investigates: correlates the alarm with recent deployments, checks related services, and sends an actionable diagnosis to the developer via SNS.

AI is used **only for diagnosis**, not detection. Detection is handled by standard CloudWatch alarms at $0 cost.

## Architecture

```
CloudWatch Alarm
      │
      ▼
SNS Alert Topic ──► Email (primary alerting path)
      │
      ▼ (filtered: excludes source="agent")
Diagnostics Proxy Lambda
      │
      ├─ DynamoDB: per-alarm cooldown (5 min)
      ├─ DynamoDB: daily invocation counter (max 50)
      │
      ▼
AgentCore Runtime (Diagnostics Agent)
      │
      ├─ AgentCore Gateway (MCP tools)
      │   ├─ search_logs      (CloudWatch Logs Insights)
      │   ├─ get_errors        (hardcoded ERROR filter)
      │   ├─ describe_services (ECS service status)
      │   ├─ check_health      (API health endpoint)
      │   ├─ get_queue_status  (SQS depths + DLQs)
      │   ├─ get_cost_report   (Cost Explorer)
      │   ├─ get_feature_flags (DynamoDB feature toggles)
      │   └─ send_alert        (SNS with source="agent")
      │
      ├─ AgentCore Memory (incident history, deployment records)
      ├─ AgentCore Policy (Cedar: permit/deny per tool)
      └─ Bedrock Foundation Model (configurable, default Claude Sonnet)
```

## Anti-Flapping

A flapping alarm (rapidly alternating between OK and ALARM) could trigger excessive AI invocations. Five layers of protection:

| Protection | Mechanism | Effect |
|-----------|-----------|--------|
| ALARM-only filter | Proxy code | Ignores OK and INSUFFICIENT_DATA transitions |
| Per-alarm cooldown | DynamoDB conditional put (5-min TTL) | Same alarm triggers once per 5 minutes max |
| Low concurrency | `reservedConcurrentExecutions: 2` | Limits parallel invocations |
| Daily cap | DynamoDB atomic counter (default 50) | Hard stop regardless of alarm volume |
| SNS source filter | Subscription filter policy | Agent alerts (`source="agent"`) cannot re-trigger diagnostics |

## Loop Prevention

The `send_alert` tool publishes to the same SNS topic that triggers the diagnostics proxy. To prevent `alarm → diagnosis → alert → diagnosis → ...` loops:

1. Every SNS message from `send_alert` includes `MessageAttributes: { source: "agent" }`
2. The diagnostics proxy's SNS subscription has a filter: `source` denylist `["agent"]`
3. SNS delivers messages missing the `source` attribute (CloudWatch alarms) but blocks messages with `source="agent"`

## Cost Model

| Scenario | Alarms/Day | AI Invocations | Est. Daily Cost |
|----------|-----------|---------------|----------------|
| Quiet (stable) | 0 | 0 | $0 |
| Normal (occasional) | 2–3 | 2–3 | ~$0.15–$0.30 |
| Incident | 10–20 | 10–20 | ~$1–$2 |
| Worst case (cap hit) | 50+ | 50 | ~$5 |

Monthly budget alarm at `dailyCostLimitUsd * 30` (MONTHLY granularity, Bedrock service filter).

## CDK Stack

`Trellis-{stage}-Agents` — deployed in Phase 4, conditional on `config.agents.enabled`.

### Resources Created

| Resource | Type | Purpose |
|----------|------|---------|
| 5 IAM Roles | `iam.Role` | Runtime, Gateway, Tool Lambda (read-only), Alert Tool (SNS), Diagnostics Proxy (DynamoDB + invoke) |
| 8 Tool Lambdas | `lambda.Function` | Infrastructure read tools + send_alert |
| 1 Diagnostics Proxy | `lambda.Function` | SNS → cooldown → daily cap → invoke agent |
| AgentCore Memory | `AWS::BedrockAgentCore::Memory` | STM + LTM for incident correlation |
| AgentCore Gateway | `AWS::BedrockAgentCore::Gateway` | MCP tool registry |
| 8 Gateway Targets | `AWS::BedrockAgentCore::GatewayTarget` | Lambda tool registrations |
| AgentCore Policy | `AWS::BedrockAgentCore::Policy` | Cedar permit rules for all 8 tools |
| AgentCore Runtime | `AWS::BedrockAgentCore::Runtime` | Diagnostics agent container |
| Monthly Budget | `AWS::Budgets::Budget` | Bedrock cost alarm |
| Log Group | `logs.LogGroup` | `/trellis/{stage}/agents` |

### SSM Parameters Published

| Key | Value |
|-----|-------|
| `/trellis/{stage}/agent-memory-id` | AgentCore Memory ID |
| `/trellis/{stage}/agent-gateway-id` | AgentCore Gateway ID |
| `/trellis/{stage}/diagnostics-runtime-id` | AgentCore Runtime ID |
| `/trellis/{stage}/diagnostics-proxy-arn` | Proxy Lambda ARN |
| `/trellis/{stage}/agent-ecr-repo-uri` | Agent ECR repo (in StorageStack) |

### Configuration

```typescript
// infra/lib/config/index.ts
interface AgentsConfig {
  enabled: boolean;                  // false in prod until validated in dev
  foundationModelId: string;         // "anthropic.claude-sonnet-4-6-20250514"
  memoryRetentionDays: number;       // 7 (dev) / 90 (prod)
  maxToolCallsPerInvocation: number; // 10
  maxDailyInvocations: number;       // 50
  dailyCostLimitUsd: number;         // 5 (dev) / 10 (prod)
}
```

## Tool Lambdas

All tools are in `apps/api/src/lambda/tools/`. Built with esbuild (`npm run build:lambda-tools`).

| Tool | SDK | Access | Notes |
|------|-----|--------|-------|
| `search-logs` | CloudWatch Logs | Read | Hardcoded log group, enforced `\| limit`, max 120 min |
| `get-errors` | CloudWatch Logs | Read | Hardcoded ERROR filter query |
| `describe-services` | ECS | Read | Cluster/service names derived from STAGE |
| `check-health` | HTTP fetch | Read | Calls API health endpoint |
| `get-queue-status` | SQS | Read | All 5 queues + DLQs |
| `get-cost-report` | Cost Explorer | Read | Max 30 days, grouped by service |
| `get-feature-flags` | DynamoDB | Read | Scans for `feature-toggle:*` keys |
| `send-alert` | SNS | Write | Sets `source="agent"` attribute (CRITICAL for loop prevention) |

## IAM Security

- **Tool Lambda role**: Read-only. No `sns:Publish`, no `dynamodb:PutItem`, no `lambda:InvokeFunction`, no `cloudwatch:PutMetricData`.
- **Alert Tool role**: Only `sns:Publish` to the alert topic. Separate from the read-only role.
- **Diagnostics Proxy role**: DynamoDB write (cooldown/counter) + AgentCore invoke. No other permissions.
- **Runtime role**: Bedrock model invocation scoped to `config.agents.foundationModelId` (not wildcard). ECR pull scoped to agent repo.
- **Gateway role**: Policy engine access + Lambda invoke scoped to `trellis-{stage}-tool-*`.
