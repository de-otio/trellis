# Local Development Setup

## Services

`docker compose up -d` starts:

| Service | Port | Purpose |
|---------|------|---------|
| PostgreSQL 16 | 5432 | Primary database |
| DynamoDB Local | 8000 | KV cache, rate limiting, feature flags |
| LocalStack | 4566 | S3, SQS, SES emulation |

## API dev server

```bash
npm run dev   # starts with tsx watch, auto-restarts on file changes
```

`http://localhost:3000` — health check at `GET /health`

## Database

```bash
npm run prisma:migrate:dev     # apply pending migrations
npm run prisma:generate        # regenerate client after schema change
npm run seed:feature-toggles   # seed feature toggle defaults
```

## Running tests

Tests require Docker Compose running. Vitest automatically uses local endpoints when `NODE_ENV=test`:

```bash
docker compose up -d
npm test                        # all tests
npm test -- path/to/file.test.ts  # single file
npm run test:watch              # watch mode
npm run test:coverage           # with coverage report
```

⚠️ Max 2 vitest worker threads — each can use 4GB+ RAM. Never run in background.

## Flutter

```bash
cd apps/flutter
flutter pub get
flutter run              # on connected device or simulator
flutter build web        # web build output in build/web/
```

`lib/amplifyconfiguration.dart` is gitignored. After deploying the Auth stack, get the Cognito user pool ID and app client ID from CDK outputs or SSM:

```bash
aws ssm get-parameter --name /trellis/dev/cognito-user-pool-id --query Parameter.Value --output text
aws ssm get-parameter --name /trellis/dev/cognito-app-client-id --query Parameter.Value --output text
```

## Local DynamoDB table

`./scripts/dev-setup.sh` creates `dev-trellis` in DynamoDB Local. To inspect:

```bash
aws dynamodb scan --table-name dev-trellis --endpoint-url http://localhost:8000
```
