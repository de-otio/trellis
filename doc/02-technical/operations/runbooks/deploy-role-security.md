# Deploy Role Branch Restriction

## Overview

The GitHub Actions deploy role should be restricted to only allow deployments from specific branches. This prevents unauthorized branches from assuming the deploy role and making changes to AWS infrastructure.

This is a **manual AWS Console/CLI change**, not managed by CDK.

## IAM Trust Policy Change

Update the IAM role's trust policy to restrict the `token.actions.githubusercontent.com:sub` condition to specific branches.

### Current Trust Policy (unrestricted)

The existing trust policy likely allows any branch to assume the role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```

### Updated Trust Policy (branch-restricted)

Add a `StringLike` condition on the `sub` claim to restrict to `dev` and `main` branches only:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": [
            "repo:OWNER/trellis:ref:refs/heads/dev",
            "repo:OWNER/trellis:ref:refs/heads/main",
            "repo:OWNER/trellis:environment:dev",
            "repo:OWNER/trellis:environment:prod"
          ]
        }
      }
    }
  ]
}
```

Replace `ACCOUNT_ID` with the AWS account ID and `OWNER` with the GitHub organization or user.

## How to Apply

### Via AWS CLI

```bash
aws iam update-assume-role-policy \
  --role-name trellis-github-deploy-role \
  --policy-document file://trust-policy.json
```

### Via AWS Console

1. Go to IAM > Roles > `trellis-github-deploy-role`
2. Click the "Trust relationships" tab
3. Click "Edit trust policy"
4. Add the `StringLike` condition block shown above
5. Click "Update policy"

## Verification

After applying, test that:

1. Deployments from `dev` and `main` branches still succeed
2. Deployments from feature branches are denied with an `AccessDenied` error
3. Manual `workflow_dispatch` triggers from allowed branches still work

## Notes

- This change is intentionally not managed by CDK to avoid circular dependencies (CDK deploy needs the role, but the role would be defined by CDK)
- The `environment:` subject claims are included to support GitHub Actions environment protection rules
- If new long-lived branches need deploy access, update the trust policy accordingly
