# Runbook: Rolling Back a Deploy

> **Status — target model, not runnable from this repo.** Trellis is not deployed
> standalone; the `infra/` CDK app and `scripts/ops/*` helpers referenced here are
> **not part of this repository** — they belong to the consuming application.
> Treat the commands below as the target operational shape.

## API rollback

The consuming application's rollback tooling registers a new ECS task definition
pointing to the previous image and waits for service stability — conventionally a
`scripts/ops/incident/rollback.sh` (interactive, lists recent ECR image tags, or
non-interactive with a target git SHA). No such script ships in this repo.

## CDK infrastructure rollback

CDK has no built-in rollback. In the consuming application's infrastructure
project, revert the infra code and redeploy the stateless stack:

```bash
git checkout <previous-commit> -- infra/lib/stacks/api-stack.ts
cd infra && npx cdk deploy "{app}-{stage}-Api" \
  --context stage=<stage> \
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
