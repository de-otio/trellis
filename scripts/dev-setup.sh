#!/usr/bin/env bash
# One-time local dev environment setup
set -euo pipefail

echo "==> Starting local services..."
docker compose up -d

echo "==> Waiting for postgres..."
until docker compose exec postgres pg_isready -U trellis; do sleep 1; done

echo "==> Creating local DynamoDB table..."
aws dynamodb create-table \
  --table-name dev-trellis \
  --attribute-definitions \
    AttributeName=pk,AttributeType=S \
    AttributeName=sk,AttributeType=S \
    AttributeName=gsi1pk,AttributeType=S \
    AttributeName=gsi1sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
  --global-secondary-indexes '[
    {"IndexName":"gsi1","KeySchema":[{"AttributeName":"gsi1pk","KeyType":"HASH"},{"AttributeName":"gsi1sk","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}
  ]' \
  --billing-mode PAY_PER_REQUEST \
  --endpoint-url http://localhost:8000 \
  --region us-east-1 2>/dev/null || echo "  (table already exists)"

echo "==> Creating local SQS queues..."
for QUEUE in delete-account media-processing media-reconciliation link-check followers-events federation-outbox; do
  aws sqs create-queue \
    --queue-name "dev-${QUEUE}" \
    --endpoint-url http://localhost:4566 \
    --region us-east-1 2>/dev/null || true
done

echo "==> Running migrations..."
DATABASE_URL="postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev" \
DIRECT_DATABASE_URL="postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev" \
  npm run prisma:migrate:dev -- --name init

echo "==> Seeding feature toggles..."
DATABASE_URL="postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev" \
DIRECT_DATABASE_URL="postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev" \
  npm run seed:feature-toggles

echo "==> Done! Start the API with: npm run dev"
