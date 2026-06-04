# GitHub Deploy IAM Role

## Overview

The `trellis-dev-github-deploy` (and `trellis-prod-github-deploy`) IAM role is assumed by GitHub Actions workflows via OIDC. It is **intentionally created and managed via the AWS CLI**, not through CDK/IaC, to avoid a bootstrapping problem: the role must exist before any CDK stack can be deployed.

The role is tagged `ManagedBy=cli` to make this explicit in the AWS console.

## Trust Policy

```json
{
  "Effect": "Allow",
  "Principal": {
    "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
  },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
    },
    "StringLike": {
      "token.actions.githubusercontent.com:sub": "repo:deotio/trellis:*"
    }
  }
}
```

## Required Inline Policies

### CdkAssumeRoles
Allows CDK CLI to assume its bootstrap roles to deploy stacks.

```json
{
  "Action": "sts:AssumeRole",
  "Resource": [
    "arn:aws:iam::<ACCOUNT_ID>:role/cdk-hnb659fds-deploy-role-<ACCOUNT_ID>-<REGION>",
    "arn:aws:iam::<ACCOUNT_ID>:role/cdk-hnb659fds-file-publishing-role-<ACCOUNT_ID>-<REGION>",
    "arn:aws:iam::<ACCOUNT_ID>:role/cdk-hnb659fds-image-publishing-role-<ACCOUNT_ID>-<REGION>",
    "arn:aws:iam::<ACCOUNT_ID>:role/cdk-hnb659fds-lookup-role-<ACCOUNT_ID>-<REGION>",
    "arn:aws:iam::<ACCOUNT_ID>:role/cdk-hnb659fds-cfn-exec-role-<ACCOUNT_ID>-<REGION>"
  ]
}
```

### EcrAccess
Allows building and pushing Docker images to ECR.

Actions: `ecr:GetAuthorizationToken` (on `*`), plus `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage`, `ecr:PutImage`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:DescribeImages`, `ecr:DescribeImageScanFindings`, `ecr:StartImageScan` on `arn:aws:ecr:<REGION>:<ACCOUNT_ID>:repository/trellis-*`.

### EcsAccess
Allows running one-off migration tasks and describing services during post-deploy stability checks.

Actions: `ecs:RunTask`, `ecs:DescribeTasks`, `ecs:DescribeServices`, `ecs:UpdateService`, `ecs:DescribeTaskDefinition`, `ecs:ListTasks` on `trellis-<STAGE>` cluster/services/tasks/task-definitions. Also `iam:PassRole` for `trellis-<STAGE>-*` roles to ECS tasks.

### LambdaInvoke
Allows invoking Lambda functions during tests.

Actions: `lambda:InvokeFunction` on `arn:aws:lambda:<REGION>:<ACCOUNT_ID>:function:trellis-<STAGE>-*`.

### SsmS3CloudFront
Allows reading/writing SSM parameters (image tags, config), deploying Flutter web to S3, and invalidating CloudFront.

Actions: `ssm:GetParameter`, `ssm:GetParameters`, `ssm:PutParameter` on `/trellis/<STAGE>/*`; `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` on `trellis-<STAGE>-*`; `cloudfront:CreateInvalidation` on `*`.

### CognitoE2E
Allows E2E tests to create and tear down test users in Cognito, and to authenticate via the Cognito API.

Actions required:
- `cognito-idp:AdminCreateUser`
- `cognito-idp:AdminDeleteUser`
- `cognito-idp:AdminSetUserPassword`

Resource: `arn:aws:cognito-idp:<REGION>:<ACCOUNT_ID>:userpool/<USER_POOL_ID>`

> **Note:** `InitiateAuthCommand` and `RespondToAuthChallengeCommand` are unauthenticated Cognito API calls (public client auth flow) — they do not require IAM permissions on the role.
>
> **Note:** The user pool is configured for email alias. `AdminCreateUserCommand` must use a non-email `Username` (e.g. `e2e-<suite>-<timestamp>`), with email passed as a `UserAttribute`. Authentication flows can still use the email alias for `USERNAME`.

### SesMaildummy
Allows the maildummy integration test to send a test email via SES to verify the end-to-end email capture pipeline.

Actions: `ses:SendEmail`, `ses:SendRawEmail` on `arn:aws:ses:<REGION>:<ACCOUNT_ID>:identity/maildummy.<STAGE>.example.com`.

### DynamoE2E
Allows the login-flow post-deployment test to create and delete a test invitation code in DynamoDB (required by the PreSignUp Lambda).

Actions: `dynamodb:PutItem`, `dynamodb:DeleteItem`, `dynamodb:GetItem` on `arn:aws:dynamodb:<REGION>:<ACCOUNT_ID>:table/<STAGE>-trellis`.

## Adding the Missing CognitoE2E Policy

The `CognitoE2E` policy is currently missing from the role. To add it:

```bash
STAGE=dev
ACCOUNT_ID=$(aws sts get-caller-identity --profile dot-dev --query Account --output text)
REGION=eu-central-1
USER_POOL_ID=$(aws ssm get-parameter \
  --name "/trellis/${STAGE}/cognito-user-pool-id" \
  --profile dot-dev --query Parameter.Value --output text)

aws iam put-role-policy \
  --role-name "trellis-${STAGE}-github-deploy" \
  --policy-name CognitoE2E \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"CognitoE2EUserManagement\",
      \"Effect\": \"Allow\",
      \"Action\": [
        \"cognito-idp:AdminCreateUser\",
        \"cognito-idp:AdminDeleteUser\",
        \"cognito-idp:AdminSetUserPassword\"
      ],
      \"Resource\": \"arn:aws:cognito-idp:${REGION}:${ACCOUNT_ID}:userpool/${USER_POOL_ID}\"
    }]
  }" \
  --profile dot-dev

aws iam put-role-policy \
  --role-name "trellis-${STAGE}-github-deploy" \
  --policy-name SesMaildummy \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"SesMaildummySend\",
      \"Effect\": \"Allow\",
      \"Action\": [\"ses:SendEmail\", \"ses:SendRawEmail\"],
      \"Resource\": \"arn:aws:ses:${REGION}:${ACCOUNT_ID}:identity/maildummy.${STAGE}.example.com\"
    }]
  }" \
  --profile dot-dev

aws iam put-role-policy \
  --role-name "trellis-${STAGE}-github-deploy" \
  --policy-name DynamoE2E \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"DynamoE2ETestData\",
      \"Effect\": \"Allow\",
      \"Action\": [\"dynamodb:PutItem\", \"dynamodb:DeleteItem\", \"dynamodb:GetItem\"],
      \"Resource\": \"arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${STAGE}-trellis\"
    }]
  }" \
  --profile dot-dev
```
