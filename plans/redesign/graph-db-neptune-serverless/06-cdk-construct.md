# 06 — CDK construct design: `NeptuneServerlessConnection`

## CDK package

Neptune has an **alpha L2 construct library**:

```
@aws-cdk/aws-neptune-alpha
```

Status: experimental (APIs may change between CDK releases). It is the
appropriate tool — the L1 CloudFormation-level constructs require
significantly more boilerplate. Track the package's stability status;
once it stabilises to `stable` the import path will move to
`aws-cdk-lib/aws-neptune`.

## Construct design

`NeptuneServerlessConnection` implements `IGraphConnection` using the alpha
Neptune package. It provisions:

1. A `DatabaseCluster` with `InstanceType.SERVERLESS` and a configurable
   NCU range.
2. One reader instance in a second AZ (for HA) using the same serverless
   type, promotion tier 0.
3. An SSM parameter holding the cluster's `bolt://` endpoint URI.
4. IAM auth enabled; `grantConnect()` grants `neptune-db:*` to a grantee.
5. CloudWatch log export for audit logs.
6. A `SubnetGroup` using isolated (private, no NAT) subnets — same
   no-NAT posture as the self-hosted design.

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as neptune from '@aws-cdk/aws-neptune-alpha';
import { Construct } from 'constructs';
import type { IGraphConnection } from './graph-connection';

export interface NeptuneServerlessConnectionProps {
  readonly vpc: ec2.IVpc;
  readonly stage: 'dev' | 'prod';
  readonly appName: string;
  /** NCU range for writer and reader. Defaults: min 1, max 8. */
  readonly minCapacity?: number;
  readonly maxCapacity?: number;
  /** SGs allowed to reach the cluster on port 8182. */
  readonly clientSecurityGroups?: ec2.ISecurityGroup[];
  /** Retention for Neptune audit logs exported to CloudWatch. */
  readonly logRetention?: cdk.aws_logs.RetentionDays;
}

export class NeptuneServerlessConnection extends Construct
  implements IGraphConnection {

  readonly boltUriParameter: ssm.IStringParameter;
  readonly credentialsSecret = null; // IAM auth — no username/password

  private readonly cluster: neptune.DatabaseCluster;

  constructor(
    scope: Construct,
    id: string,
    props: NeptuneServerlessConnectionProps,
  ) {
    super(scope, id);

    const { vpc, stage, appName, minCapacity = 1, maxCapacity = 8 } = props;

    // Subnet group: isolated subnets (private, no NAT required)
    const subnetGroup = new neptune.SubnetGroup(this, 'SubnetGroup', {
      description: `${appName}-${stage} Neptune isolated subnets`,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      removalPolicy: stage === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // Cluster parameter group — enable audit logging
    const clusterParams = new neptune.ClusterParameterGroup(
      this,
      'ClusterParams',
      {
        description: `${appName}-${stage} cluster params`,
        parameters: { neptune_enable_audit_log: '1' },
      },
    );

    this.cluster = new neptune.DatabaseCluster(this, 'Cluster', {
      vpc,
      subnetGroup,
      clusterParameterGroup: clusterParams,
      instanceType: neptune.InstanceType.SERVERLESS,
      serverlessScalingConfiguration: { minCapacity, maxCapacity },
      // Two instances: writer (AZ-a) + tier-0 reader (AZ-b) for compute HA
      instances: 2,
      iamAuthentication: true,
      // Prod: retain storage on stack deletion; dev: destroy
      storageEncrypted: true,
      deletionProtection: stage === 'prod',
      // Continuous backup: 7 days (covers the PITR requirement the self-hosted design could not)
      backupRetention: cdk.Duration.days(stage === 'prod' ? 7 : 1),
      // Export audit logs to CloudWatch
      cloudwatchLogsExports: [neptune.LogType.AUDIT],
      cloudwatchLogsRetention: props.logRetention
        ?? (stage === 'prod'
          ? cdk.aws_logs.RetentionDays.ONE_MONTH
          : cdk.aws_logs.RetentionDays.ONE_WEEK),
    });

    // Allow client security groups on port 8182 (Bolt)
    for (const sg of props.clientSecurityGroups ?? []) {
      this.cluster.connections.allowDefaultPortFrom(sg);
    }

    // Publish bolt URI for consumers
    this.boltUriParameter = new ssm.StringParameter(this, 'BoltUri', {
      parameterName: `/${appName}/${stage}/neptune-bolt-uri`,
      stringValue: `bolt://${this.cluster.clusterEndpoint.hostname}:${this.cluster.clusterEndpoint.port}`,
      description: `Neptune cluster bolt URI for ${appName}-${stage}`,
    });

    // Prod: retain SSM parameter on stack deletion
    if (stage === 'prod') {
      (this.boltUriParameter.node.defaultChild as cdk.CfnResource)
        .applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    }
  }

  /** Grant an ECS task (or any grantable) Bolt access to this cluster. */
  grantConnect(grantee: iam.IGrantable): iam.Grant {
    return this.cluster.grantConnect(grantee);
  }
}
```

### What the consumer's stack changes to

```typescript
// Today (self-hosted):
const graph: IGraphConnection = new Neo4jGraphInstance(this, 'Graph', {
  stage: 'prod', appName: 'myapp', vpc,
  dataVolumeAz: 'eu-central-1a',
  clientSecurityGroups: [apiSg],
});

// Neptune Serverless — same variable type, same outputs:
const graph: IGraphConnection = new NeptuneServerlessConnection(this, 'Graph', {
  stage: 'prod', appName: 'myapp', vpc,
  minCapacity: 1, maxCapacity: 8,
  clientSecurityGroups: [apiSg],
});
graph.grantConnect(apiTask.taskDefinition.taskRole);

// Downstream consumers are unchanged — they still read:
graph.boltUriParameter   // same SSM param name
// No credentialsSecret to inject (it is null for Neptune)
```

The ECS task definition stops injecting a `NEO4J_PASSWORD` env var (there
isn't one), and the graph factory reads the bolt URI from the SSM param and
uses `neo4j.auth.none()` or the SigV4 token provider.

## `IGraphConnection` interface update

The current `IGraphConnection` interface (see [`05`](05-connection-protocol.md)) needs one additive change:

```typescript
export interface IGraphConnection {
  readonly boltUriParameter: ssm.IStringParameter;
  readonly credentialsSecret: secretsmanager.ISecret | null; // null for Neptune
  grantConnect?(grantee: iam.IGrantable): iam.Grant;         // optional; Neptune implements it
}
```

Existing `Neo4jGraphInstance` and `AuraGraphConnection` keep
`credentialsSecret` non-null and omit `grantConnect` (or make it a no-op).
No downstream consumer changes are required for those implementations.

## VPC endpoint requirements

Neptune is a fully managed service — it does not need SSM, Secrets Manager,
or Logs interface endpoints the way the self-hosted EC2 instance does. The
Neptune cluster itself sits in the isolated subnet and communicates with AWS
services over the Neptune control plane (not customer-controlled). This
eliminates the ~$21/month interface endpoint cost the self-hosted design carries.

The API service (in the same VPC) connects to Neptune via the cluster's
private DNS endpoint, which resolves within the VPC without internet egress.

## cdk-nag deviations

The two expected deviations to suppress (with explanations):

1. **`AwsSolutions-N3`** (Neptune cluster not in a Multi-AZ deployment for
   all instance types): not applicable to Serverless instances, which are
   managed by AWS across AZs inherently. Suppress with justification.
2. **Single-AZ subnet group in dev**: dev stage uses a disposable single-AZ
   posture. Suppress with `stage === 'dev'` condition.

## Auto-pause / scale-to-zero

Neptune Serverless does **not** support scale-to-zero. Minimum NCU is 1.0,
billed continuously. For dev/test environments that are idle most of the
day, consider:

- Scheduling a Lambda to call `StopDBCluster` outside business hours and
  `StartDBCluster` before first use. Neptune supports stop/start. A stopped
  cluster is billed for storage only (~$1/month), not compute.
- Wiring this to EventBridge Scheduler (M–F 08:00–20:00 CET, for example).

This is optional but worth a short operational note in the construct docs.

## Open questions

- **`@aws-cdk/aws-neptune-alpha` version pinning.** The package is
  experimental. Pin a specific version and include it in the monorepo's
  dependency audit. Monitor for breaking changes on CDK upgrades.
- **Reader instance promotion tier.** The CDK alpha package does not
  currently expose promotion tier configuration directly. Verify whether
  the default tier for the second instance is 0 or 2. If 2, the reader
  scales independently of the writer (lower HA readiness). May need to
  use an escape hatch (`CfnDbInstance.promotionTier`).
- **Engine version.** `datetime()` over stored properties needs engine
  ≥ 1.3.2.0 (audit [`10` F2](10-opencypher-audit.md)), but **AWS never kept
  `1.3.2.0` deployable** — a `cdk deploy` of it fails with *"Cannot find version
  1.3.2.0 for neptune."* The lowest **available** version meeting the floor is
  **`1.3.2.1`** (`EngineVersion.V1_3_2_1`), verified live in eu-central-1
  (2026-06-01). **Two gotchas, both only caught at deploy time** (not synth/diff):
  1. the engine version must actually be available (`aws neptune
  describe-db-engine-versions`); 2. the **cluster parameter group family must
  match the engine line** — engine `1.3.x` → `ParameterGroupFamily.NEPTUNE_1_3`
  (the alpha default `NEPTUNE_1` is rejected). Keep `engineVersion` and the
  parameter-group `family` in lockstep.
