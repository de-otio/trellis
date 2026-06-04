# AWS MCP Servers — Investigation for Trellis

## What Are AWS MCP Servers?

AWS provides Model Context Protocol (MCP) servers that give AI assistants (Claude Code, Cursor, VS Code Copilot) direct access to AWS documentation, APIs, and operational tools. They come in two forms:

1. **Managed remote servers** — hosted by AWS, accessed over HTTPS, with IAM auth and CloudTrail audit logging
2. **Open-source local servers** — from `awslabs/mcp` on GitHub (Apache 2.0), run locally via `uvx`

## Recommended Servers for Trellis

Based on the project's AWS footprint (ECS Fargate, RDS PostgreSQL, DynamoDB, SQS, Cognito, S3, SES, CloudFront, CDK), these servers would provide the most value:

### Tier 1 — High Value, Low Risk (read-only / documentation)

| Server | Why It Helps | Risk |
|--------|-------------|------|
| **AWS Knowledge** (managed remote) | Real-time AWS docs, API refs, Well-Architected guidance. Replaces manual doc lookups for CDK, ECS, Cognito, etc. | None — read-only, no AWS credentials needed |
| **AWS IaC MCP Server** | CDK best practices, CloudFormation docs, security validation, deployment troubleshooting. Directly relevant to `infra/` stacks. | Read-only by default |
| **AWS Documentation** | Targeted API reference lookups for the 15+ AWS SDKs this project uses | None — read-only |

### Tier 2 — High Value, Moderate Risk (read + optional write)

| Server | Why It Helps | Risk |
|--------|-------------|------|
| **Amazon DynamoDB** | Design guidance + operations for the `{stage}-trellis` single-table. Useful for debugging cache issues. | Can write if `--allow-write` is passed |
| **Amazon ECS** | Inspect services, task definitions, deployments — replaces manual `scripts/ops/status.sh` during debugging | Can modify services if write-enabled |
| **Amazon CloudWatch** | Query logs, metrics, alarms — replaces `scripts/ops/logs.sh` and `scripts/ops/errors.sh` for richer analysis | Read-only useful enough |
| **Amazon SNS/SQS** | Inspect the 5 core queues + DLQs, check message counts, debug queue issues | Can send messages if write-enabled |

### Tier 3 — Useful for Specific Tasks

| Server | Why It Helps |
|--------|-------------|
| **AWS IAM** | Debug permission issues, review role policies for ECS tasks and Lambda functions |
| **AWS Pricing** | Estimate costs before infra changes (relevant given the budget config in StageConfig) |
| **AWS CloudTrail** | Investigate API activity for security or debugging |
| **AWS Diagram** | Generate architecture diagrams from actual infra |
| **Synthetic Data** | Generate test data for the Prisma models |

### Not Recommended

| Server | Why Not |
|--------|---------|
| **AWS CloudFormation** (direct resource management) | CDK should remain the single source of truth for infra |
| **AWS Lambda Tool** | Executing Lambdas via MCP bypasses normal deployment/testing flow |
| **Aurora PostgreSQL** | Uses RDS Data API, not compatible with Trellis's Prisma + pg driver setup |

## Security Architecture

### Authentication

**For managed remote servers (Knowledge, AWS MCP):**
- OAuth or SigV4 (IAM) authentication
- Uses existing IAM roles — no new credential systems
- All API calls logged to CloudTrail

**For local servers:**
- Uses `AWS_PROFILE` environment variable → your local AWS credentials
- Credentials stay local — never sent to the MCP server process
- The server runs as a subprocess of Claude Code

### Recommended Security Controls

1. **Use a dedicated IAM profile** — Create an `mcp-dev` profile with read-only policies. Never use prod credentials.

   ```
   # ~/.aws/config
   [profile trellis-mcp-dev]
   sso_session = your-sso
   sso_account_id = 123456789012
   sso_role_name = MCPReadOnly    # Custom role, read-only
   region = us-east-1
   ```

2. **Never pass `--allow-write` for data stores** — Keep DynamoDB, SQS, and ECS servers read-only in the MCP config.

3. **Scope IAM policies** — Example least-privilege policy for the MCP profile:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "ecs:Describe*", "ecs:List*",
           "dynamodb:Describe*", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan",
           "sqs:GetQueueAttributes", "sqs:ListQueues",
           "logs:GetLogEvents", "logs:FilterLogEvents", "logs:DescribeLogGroups",
           "cloudwatch:GetMetricData", "cloudwatch:DescribeAlarms",
           "cloudformation:Describe*", "cloudformation:List*",
           "ssm:GetParameter", "ssm:GetParametersByPath",
           "iam:Get*", "iam:List*"
         ],
         "Resource": "*",
         "Condition": {
           "StringEquals": { "aws:RequestedRegion": "us-east-1" }
         }
       }
     ]
   }
   ```

4. **Use `.mcp.json` in the project root** (already exists) — keeps config versioned and shared across the team.

5. **Never configure servers that access prod data** without explicit read-only constraints.

## Proposed Configuration

Add to `/Users/rmyers/repos/dot/trellis/.mcp.json`:

```json
{
  "mcpServers": {
    "doc-search": {
      "command": "node",
      "args": ["/Users/rmyers/.vscode/extensions/de-otio-org.mcp-doc-search-0.1.0/dist/mcp-server.js"],
      "env": {
        "DOC_SEARCH_WORKSPACE": "/Users/rmyers/repos/dot/trellis"
      }
    },
    "aws-knowledge": {
      "url": "https://knowledge-mcp.global.api.aws"
    },
    "aws-iac": {
      "command": "uvx",
      "args": ["awslabs.aws-iac-mcp-server@latest"],
      "env": {
        "AWS_PROFILE": "dot-mcp-dev",
        "AWS_REGION": "eu-central-1",
        "FASTMCP_LOG_LEVEL": "ERROR"
      }
    },
    "aws-dynamodb": {
      "command": "uvx",
      "args": ["awslabs.amazon-dynamodb-mcp-server@latest"],
      "env": {
        "AWS_PROFILE": "dot-mcp-dev",
        "AWS_REGION": "eu-central-1",
        "FASTMCP_LOG_LEVEL": "ERROR"
      }
    },
    "aws-ecs": {
      "command": "uvx",
      "args": ["awslabs.amazon-ecs-mcp-server@latest"],
      "env": {
        "AWS_PROFILE": "dot-mcp-dev",
        "AWS_REGION": "eu-central-1",
        "FASTMCP_LOG_LEVEL": "ERROR"
      }
    },
    "aws-cloudwatch": {
      "command": "uvx",
      "args": ["awslabs.amazon-cloudwatch-mcp-server@latest"],
      "env": {
        "AWS_PROFILE": "dot-mcp-dev",
        "AWS_REGION": "eu-central-1",
        "FASTMCP_LOG_LEVEL": "ERROR"
      }
    }
  }
}
```

## How This Speeds Development

| Workflow | Before | After |
|----------|--------|-------|
| "How does CDK ECS Fargate config work?" | Open browser, search AWS docs | Ask Claude — IaC server has CDK best practices built in |
| Debug failing ECS deployment | Run `scripts/ops/status.sh`, `scripts/ops/logs.sh`, manually parse output | Claude queries ECS + CloudWatch directly, correlates errors |
| DynamoDB single-table design question | Manual doc lookup, trial and error | DynamoDB server provides design guidance with project context |
| CDK security validation | Manual review, `cdk diff` | IaC server validates security patterns automatically |
| Check queue depth / DLQ messages | AWS Console or CLI | Claude inspects SQS directly during debugging |
| Cost estimation for infra change | AWS pricing calculator | Pricing server estimates inline |

## How This Supports Maintenance

1. **Incident response** — CloudWatch + ECS servers let Claude directly query logs and service status during incidents, reducing MTTR
2. **Infrastructure drift** — IaC server can validate CDK stacks against actual CloudFormation state
3. **Security audits** — IAM server can review role policies; Well-Architected guidance from Knowledge server
4. **Dependency updates** — Documentation server provides current API references when updating AWS SDK versions

## Prerequisites

```bash
# Install uv (Python package manager) — required for local MCP servers
curl -LsSf https://astral.sh/uv/install.sh | sh

# Verify uvx is available
uvx --version

# Configure the dedicated MCP IAM profile (adapt to your SSO/credential setup)
aws configure --profile trellis-mcp-dev
```

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| MCP server gets write access to prod | Dedicated read-only IAM profile; no `--allow-write` flags |
| Credentials leaked via MCP transport | Local servers use stdio (no network); managed servers use IAM/OAuth |
| Stale documentation from Knowledge server | Knowledge server pulls real-time docs; cross-check with `aws` CLI for critical decisions |
| Cost of API calls through MCP | Most read operations are free or negligible; CloudTrail logging enables cost monitoring |
| MCP servers are in Preview | Use for dev assistance only, not in CI/CD or automated pipelines |
| `uvx` supply chain risk | Pin versions in `.mcp.json` args (e.g., `awslabs.aws-iac-mcp-server@0.3.0` instead of `@latest`) |

## Recommendation

**Start with Tier 1** (Knowledge + IaC servers) — zero risk, immediate value for CDK work and AWS doc lookups. Add Tier 2 servers incrementally as the read-only IAM profile is set up and validated. Keep this config in `.mcp.json` so it's versioned with the project.
