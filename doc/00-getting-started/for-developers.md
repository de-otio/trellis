# Developer Guide

## Prerequisites

- Node.js 22+
- Docker + Docker Compose
- AWS CLI configured with dev account credentials
- Flutter SDK (for frontend work only)

## First-time setup

```bash
git clone <repo> && cd trellis
npm install
./scripts/dev-setup.sh   # starts local services, runs migrations, seeds data
```

## Daily workflow

```bash
docker compose up -d    # ensure local services are running
npm run dev             # start API in watch mode (port 3000)
```

## Local environment variables

Create `.env` in the repo root (gitignored):

```env
DATABASE_URL=postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev
DYNAMODB_ENDPOINT=http://localhost:8000
DYNAMODB_TABLE=dev-trellis
SQS_ENDPOINT=http://localhost:4566
S3_ENDPOINT=http://localhost:4566
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
STAGE=dev
NODE_ENV=development
SESSION_SECRET=local-dev-secret-32-bytes-minimum-here
```

## Running tests

```bash
npm test                              # all tests (requires Docker Compose)
npm test -- apps/api/test/foo.test.ts # single file
npm run test:coverage                 # with coverage report
```

⚠️ **Never run tests in the background** — each Vitest worker process can use 4GB+ RAM. Always foreground, Ctrl+C to stop.

## Database workflow

```bash
# After editing prisma/schema.prisma:
npm run prisma:migrate:dev -- --name describe-your-change
npm run prisma:generate
```

For zero-downtime schema changes, use expand-contract. See [migrations guide](../02-technical/development/migrations.md).

## Infrastructure (CDK)

```bash
cd infra && npm install
npm run infra:diff     # preview what would change
npm run infra:deploy   # deploy all stacks to dev
```

Bootstrap order (first time only):
`Monitoring → Network → Data / Storage / Auth → Api / Workers → Cdn`

All stacks communicate exclusively through SSM Parameter Store (`/trellis/{stage}/`). No CDK cross-stack references exist.

See [CDK structure](../02-technical/architecture/08-cdk-structure.md).

## Flutter

```bash
cd apps/flutter
flutter pub get
flutter run              # launch on connected device/simulator
flutter build web        # build for web
```

Auth uses AWS Amplify (`amplify_auth_cognito`). The `lib/amplifyconfiguration.dart` is gitignored — get it from a team member or generate it after deploying the Auth stack and copying the CDK outputs.
