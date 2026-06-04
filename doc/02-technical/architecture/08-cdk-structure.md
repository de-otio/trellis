# CDK Project Structure

## Architectural Constraints

Two rules govern every CDK stack in this project:

### 1. Stateful stacks are separate from stateless stacks

| Stateful (RETAIN policy, deletion-protected in prod) | Stateless (recreatable freely) |
|---|---|
| `Trellis-{stage}-Network` — VPC, subnets, NAT, security groups | `Trellis-{stage}-Api` — ECS Fargate + ALB |
| `Trellis-{stage}-Data` — RDS + DynamoDB | `Trellis-{stage}-Workers` — Lambda + SQS + EventBridge |
| `Trellis-{stage}-Storage` — S3 buckets + ECR | `Trellis-{stage}-Cdn` — CloudFront |
| `Trellis-{stage}-Auth` — Cognito user pool | `Trellis-{stage}-Monitoring` — alarms, dashboards, budgets |
| | `Trellis-{stage}-Agents` — AgentCore diagnostics (conditional) |

Stateful stacks use `removalPolicy: RETAIN` and `terminationProtection: true` in prod. Never add a Lambda function or ECS service to a stateful stack.

### 2. No CDK cross-stack references — SSM Parameter Store only

**Never** use `otherStack.someResource.someProperty` across stack boundaries. CDK implements these as CloudFormation Exports, which creates tight coupling and causes "Export cannot be deleted as it is in use" errors when you try to modify or delete stacks.

Instead:
- Each stack **writes** resource IDs/ARNs/URLs to SSM when it creates them
- Downstream stacks **read** from SSM using `ssm.StringParameter.valueFromLookup()`
- All SSM parameters follow: `/trellis/{stage}/{resource-name}`

This means every stack can be deployed and destroyed independently.

```typescript
// Correct — read from SSM
const vpcId = ssm.StringParameter.valueFromLookup(this, `/trellis/${stage}/vpc-id`);
const vpc = ec2.Vpc.fromLookup(this, "Vpc", { vpcId });

// Wrong — cross-stack object reference (creates CFN Export)
const vpc = networkStack.vpc;
```

---

## Why CDK (TypeScript)

- **Same language** as the application — no context-switching between HCL and TypeScript
- **Type safety** — IDE autocomplete, compile-time errors for misconfigured resources
- **AI-friendly** — AI assistants understand TypeScript far better than HCL
- **Composable** — reusable constructs, loops, conditionals — real programming
- **First-class AWS support** — no provider lag; CDK updates with AWS releases

## Monorepo Layout

```
trellis/                            # Repo root
├── apps/
│   ├── api/                        # API application code
│   │   ├── src/
│   │   │   ├── server.ts           # Node.js HTTP server entry point
│   │   │   ├── router.ts           # Route registry
│   │   │   ├── lib/                # Business logic
│   │   │   └── workers/            # Lambda worker handler entry points
│   │   ├── Dockerfile              # Multi-stage production build
│   │   ├── test/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── flutter/                    # Flutter frontend
│       └── ...
├── infra/                          # CDK infrastructure
│   ├── bin/
│   │   └── app.ts                  # CDK app entry point
│   ├── lib/
│   │   ├── stacks/
│   │   │   ├── network-stack.ts    # VPC, subnets, security groups, NAT
│   │   │   ├── database-stack.ts   # RDS PostgreSQL + DynamoDB
│   │   │   ├── auth-stack.ts       # Cognito user pool, triggers
│   │   │   ├── storage-stack.ts    # S3 buckets, ECR repository
│   │   │   ├── api-stack.ts        # ECS cluster, Fargate service, ALB
│   │   │   ├── workers-stack.ts    # Lambda workers, SQS queues, EventBridge
│   │   │   ├── cdn-stack.ts        # CloudFront distribution, OAC
│   │   │   ├── monitoring-stack.ts # CloudWatch dashboards, alarms, budgets
│   │   │   ├── agents-stack.ts    # AgentCore diagnostics (conditional)
│   │   │   └── dns-stack.ts        # Route 53 (optional)
│   │   └── constructs/
│   │       ├── guarded-lambda.ts   # Lambda with cost guardrails baked in
│   │       ├── queue-with-dlq.ts   # SQS + DLQ + alarm pattern
│   │       └── single-table.ts     # DynamoDB single-table construct
│   ├── package.json
│   ├── cdk.json
│   └── tsconfig.json
├── extensions/
│   └── dogs/                       # Dog extension (first domain extension)
│       ├── src/                    # Routes, metadata schema, strategies, hooks
│       └── test/                   # Extension-specific tests
├── packages/
│   ├── extension-api/              # Shared extension interface types (TrellisExtension, etc.)
│   ├── crypto/                     # Shared crypto utilities
│   └── shared/                     # Shared types, constants
├── prisma/
│   └── schema.prisma               # Database schema
├── package.json                    # Workspace root
└── tsconfig.base.json
```

## Stack Dependencies

```
NetworkStack        ← no dependencies
    ↓
DatabaseStack       ← NetworkStack (VPC, subnets, security groups)
AuthStack           ← no dependencies
StorageStack        ← no dependencies
    ↓
ApiStack            ← DatabaseStack, AuthStack, StorageStack, NetworkStack
WorkersStack        ← DatabaseStack, StorageStack, NetworkStack
AgentsStack         ← MonitoringStack, NetworkStack, DatabaseStack, StorageStack, AuthStack (conditional)
    ↓
CdnStack            ← ApiStack (ALB), StorageStack (S3)
MonitoringStack     ← ApiStack, WorkersStack, DatabaseStack (metrics sources)
DnsStack            ← CdnStack (distribution domain)
```

All dependencies are resolved at deploy time by reading from SSM — not via CDK cross-stack object references.

## Key Constructs

### GuardedLambda

A custom construct that wraps `lambda.Function` with cost guardrails. Used for all worker Lambdas, cron Lambdas, and Cognito triggers:

```typescript
export class GuardedLambda extends Construct {
  public readonly fn: lambda.Function;

  constructor(scope: Construct, id: string, props: GuardedLambdaProps) {
    super(scope, id);

    this.fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: props.memorySize ?? 256,
      timeout: props.timeout ?? Duration.seconds(30),
      reservedConcurrentExecutions: props.maxConcurrency ?? 5,  // ALWAYS set
      environment: props.environment,
      vpc: props.vpc,                    // Only set for workers needing RDS
      tracing: lambda.Tracing.ACTIVE,    // X-Ray
      ...props.functionProps,
    });

    // Duration alarm — catch stuck functions
    new Alarm(this, 'DurationAlarm', {
      metric: this.fn.metricDuration({ statistic: 'p99' }),
      threshold: (props.timeout?.toMilliseconds() ?? 30000) * 0.8,
      evaluationPeriods: 3,
    });

    // Error rate alarm
    new Alarm(this, 'ErrorAlarm', {
      metric: this.fn.metricErrors(),
      threshold: props.errorThreshold ?? 10,
      evaluationPeriods: 2,
    });

    // Throttle alarm — hitting concurrency limits
    new Alarm(this, 'ThrottleAlarm', {
      metric: this.fn.metricThrottles(),
      threshold: 5,
      evaluationPeriods: 1,
    });
  }
}
```

### QueueWithDlq

```typescript
export class QueueWithDlq extends Construct {
  public readonly queue: sqs.Queue;
  public readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: QueueWithDlqProps) {
    super(scope, id);

    this.dlq = new sqs.Queue(this, 'Dlq', {
      retentionPeriod: Duration.days(14),
    });

    this.queue = new sqs.Queue(this, 'Queue', {
      visibilityTimeout: props.visibilityTimeout ?? Duration.seconds(30),
      retentionPeriod: props.retentionPeriod ?? Duration.days(3),
      deadLetterQueue: {
        queue: this.dlq,
        maxReceiveCount: props.maxReceiveCount ?? 3,
      },
    });

    // DLQ alarm
    new Alarm(this, 'DlqAlarm', {
      metric: this.dlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }
}
```

## Environment Stages

```typescript
// bin/app.ts
const app = new cdk.App();
const stage = app.node.tryGetContext('stage') ?? 'dev';

// Stack instantiation per stage
const network = new NetworkStack(app, `Trellis-${stage}-Network`, { stage });
const database = new DatabaseStack(app, `Trellis-${stage}-Data`, { stage });
// ... etc
```

Two stages: `dev` and `prod`. Same stacks, different parameters (instance sizes, concurrency limits, domain names).

## Deployment

```bash
# Deploy all stacks
cd infra && npx cdk deploy --all --context stage=dev

# Deploy specific stack
npx cdk deploy Trellis-dev-Api --context stage=dev

# Diff before deploying
npx cdk diff --all --context stage=dev

# Synthesize CloudFormation (for review)
npx cdk synth --all --context stage=dev
```

### CI/CD

GitHub Actions workflow:

```yaml
deploy:
  steps:
    - npm ci
    - npm run build
    - npm run test

    # Build and push container image
    - aws ecr get-login-password | docker login --username AWS --password-stdin $ECR_URI
    - docker build -t $ECR_URI:$GITHUB_SHA -f apps/api/Dockerfile .
    - docker push $ECR_URI:$GITHUB_SHA

    # Deploy infrastructure (includes Fargate service update)
    - cd infra && npx cdk deploy --all --require-approval never --context stage=dev

    # Run database migrations as one-off Fargate task
    - aws ecs run-task --cluster $CLUSTER --task-definition $MIGRATION_TASK_DEF --launch-type FARGATE
      --network-configuration "$NETWORK_CONFIG"
      --overrides '{"containerOverrides":[{"name":"migrate","command":["npx","prisma","migrate","deploy"]}]}'

    # Wait for service to stabilize
    - aws ecs wait services-stable --cluster $CLUSTER --services $SERVICE

    # Deploy Flutter web
    - cd apps/flutter && flutter build web
    - aws s3 sync build/web s3://trellis-web --delete
    - aws cloudfront create-invalidation --distribution-id $DIST_ID --paths "/*"
```
