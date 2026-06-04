# Deployment Guide

## Stack deploy order (first time)

When bootstrapping a new environment:

```
1. Trellis-{stage}-Monitoring   (creates SNS alert topic → SSM)
2. Trellis-{stage}-Network      (creates VPC/subnets/SGs → SSM)
3. Trellis-{stage}-Data         (creates RDS + DynamoDB → SSM)
4. Trellis-{stage}-Storage      (creates S3 + ECR → SSM)
5. Trellis-{stage}-Auth         (creates Cognito → SSM)
6. Trellis-{stage}-Api          (reads from SSM → deploys Fargate + ALB)
7. Trellis-{stage}-Workers      (reads from SSM → deploys Lambda + SQS)
8. Trellis-{stage}-Cdn          (reads from SSM → deploys CloudFront)
```

Subsequent deploys of stateless stacks (Api, Workers, Cdn) can run independently.

## Automated full deploy

```bash
./scripts/deploy.sh dev    # build image → CDK → migrate → smoke test
./scripts/deploy.sh prod   # same, requires prod AWS credentials
```

## CI/CD (GitHub Actions)

- **Push to `dev`**: runs `ci.yml` (test + build image), then `deploy.yml` (deploy to dev)
- **Manual `prod` deploy**: trigger `deploy.yml` with `stage: prod` (requires environment approval)

## CDK constraints

- **Stateful stacks** (Network, Data, Storage, Auth): hold durable data, deployed infrequently, always `RETAIN` policy
- **Stateless stacks** (Api, Workers, Cdn, Monitoring): hold compute only, can be torn down and redeployed freely
- **No cross-stack references**: every value flows through SSM at `/trellis/{stage}/`

## Image tagging

Docker images are tagged with the git SHA. The deploy script passes `--context imageTag=<sha>` to CDK, which registers a new ECS task definition. The old task definition remains for rollback.

## Flutter web

```bash
cd apps/flutter && flutter build web --release
WEB_BUCKET=$(aws ssm get-parameter --name /trellis/dev/web-bucket-name --query Parameter.Value --output text)
CF_ID=$(aws ssm get-parameter --name /trellis/dev/cloudfront-distribution-id --query Parameter.Value --output text)
aws s3 sync build/web "s3://${WEB_BUCKET}" --delete --cache-control "max-age=86400"
aws s3 cp "s3://${WEB_BUCKET}/index.html" "s3://${WEB_BUCKET}/index.html" \
  --metadata-directive REPLACE --cache-control "no-cache, no-store"
aws cloudfront create-invalidation --distribution-id "${CF_ID}" --paths "/*"
```

## Database migrations

Run automatically by `deploy.sh` as a one-off ECS task. See [migrations guide](../development/migrations.md).
