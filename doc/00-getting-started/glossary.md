# Glossary

| Term | Meaning |
|------|---------|
| **Entity** | The core social object — a polymorphic record whose `entityType` field identifies which extension owns it (e.g. the entity type registered by a domain extension). Has an ActivityPub actor. |
| **Extension** | A pluggable module (`TrellisExtension`) that adds a domain-specific entity type, metadata schema, routes, feed/recommendation strategies, and lifecycle hooks. Lives in `extensions/{name}/`. |
| **ExtensionContext** | A scoped context passed to extensions — provides limited database access and config, never secrets or admin tables. |
| **Extension Registry** | Startup-validated list of loaded extensions (`apps/api/src/extensions.ts`). Rejects duplicate IDs, reserved names, and conflicting routes. |
| **Stage** | Deployment environment: `dev` or `prod` |
| **Single table** | The DynamoDB table (`{stage}-trellis`) storing all KV/cache data |
| **SSM** | AWS Systems Manager Parameter Store — used for all inter-stack config |
| **Stateful stack** | CDK stack containing durable data (Network, Data, Storage, Auth). Never auto-deleted. |
| **Stateless stack** | CDK stack containing compute only (Api, Workers, Cdn). Can be recreated freely. |
| **DLQ** | Dead-Letter Queue — receives SQS messages that failed 3 times |
| **OAC** | Origin Access Control — CloudFront mechanism to keep S3 buckets private |
| **Fedify** | The ActivityPub framework powering federation |
| **NAT Instance** | EC2 t4g.nano used as NAT (~$3/mo vs NAT Gateway ~$32/mo) |
| **Presigned URL** | Time-limited S3 URL for direct client uploads, bypassing the API |
| **Border Safety Mode** | AI-powered travel safety feature: profile risk assessment per destination, travel preparation workflow, and adversarial self-testing against government screening tools |
| **BudgetGuard** | Application-level spend tracker in DynamoDB to cap AI/email costs |
| **Cognito trigger** | Lambda function invoked by Cognito on auth events (pre-signup, post-confirmation, etc.) |
