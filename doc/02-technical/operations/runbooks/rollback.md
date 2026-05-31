# Runbook: Rolling Back a Deploy

## API rollback

```bash
# Interactive — lists recent ECR image tags and prompts
STAGE=dev ./scripts/ops/incident/rollback.sh

# Non-interactive — specify the git SHA to roll back to
STAGE=dev ./scripts/ops/incident/rollback.sh abc1234
```

The script registers a new ECS task definition pointing to the previous image and waits for service stability.

## CDK infrastructure rollback

CDK doesn't have a built-in rollback. Revert the infra code and redeploy:

```bash
git checkout <previous-commit> -- infra/lib/stacks/api-stack.ts
cd infra && npx cdk deploy "Trellis-dev-Api" \
  --context stage=dev \
  --context imageTag=<previous-sha>
```

**Never roll back stateful stacks** (Data, Storage, Auth, Network) without careful consideration — this can destroy data. See [disaster-recovery.md](./disaster-recovery.md) for stateful resource recovery procedures.

## Flutter web rollback

The web bucket has versioning enabled. To restore a previous deploy:

```bash
WEB_BUCKET=$(aws ssm get-parameter --name /trellis/dev/web-bucket-name --query Parameter.Value --output text)
CF_ID=$(aws ssm get-parameter --name /trellis/dev/cloudfront-distribution-id --query Parameter.Value --output text)

# List versions of index.html
aws s3api list-object-versions --bucket $WEB_BUCKET --prefix index.html \
  --query "Versions[*].{VersionId:VersionId,LastModified:LastModified}" --output table

# Restore specific version
aws s3api copy-object \
  --bucket $WEB_BUCKET \
  --copy-source "${WEB_BUCKET}/index.html?versionId=<VERSION_ID>" \
  --key index.html

aws cloudfront create-invalidation --distribution-id $CF_ID --paths "/*"
```
