/**
 * Standalone vitest globalSetup.
 *
 * Boots the real Trellis server with the dummy-target extensions against the
 * local docker-compose stack, with NO AWS account and NO consuming vertical.
 * See doc/02-technical/development/testing/standalone.md.
 *
 * Prerequisites (provided by `docker compose up` + the Stage-0 migrate):
 *   - Postgres on :5432 (migrated)
 *   - DynamoDB-local on :8000
 *   - LocalStack (S3/SQS) on :4566, Neo4j on :7687 (best-effort)
 */

import type { Server } from "node:http";
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { applyStandaloneEnv, STANDALONE_API_URL } from "./standalone-env.js";

let server: Server | undefined;

/** Create the single-table KV store in DynamoDB-local (pk/sk, idempotent). */
async function ensureDynamoTable(): Promise<void> {
  const table = process.env.DYNAMODB_TABLE || "test-trellis";
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION || "us-east-1",
    endpoint: process.env.DYNAMODB_ENDPOINT || "http://localhost:8000",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  try {
    await client.send(new DescribeTableCommand({ TableName: table }));
    return; // already exists
  } catch {
    // fall through to create
  }
  try {
    await client.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      }),
    );
  } catch (err: any) {
    if (err?.name !== "ResourceInUseException") throw err;
  } finally {
    client.destroy();
  }
}

/**
 * Seed the feature toggles the standalone suites depend on. Handlers gate on
 * these (default off), so the lane enables them explicitly. Mirrors what a
 * deployed environment seeds via `npm run seed:feature-toggles`.
 */
async function seedFeatureToggles(): Promise<void> {
  const enabled = [
    "entity_profiles_enabled",
    "global_public_posting_enabled",
  ];
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  try {
    // Seed GLOBAL toggles (tenant_id IS NULL). P1 replaced the `@unique` on
    // `key` with `@@unique([key, tenantId])`, and SQL treats `(key, NULL)` as
    // non-unique — so Prisma's compound `key_tenantId` where-input can't select
    // a global row. Upsert manually (findFirst → update/create), mirroring
    // `globalScopedFeatureToggleClient` in src/lib/feature-toggle-global-client.ts.
    for (const key of enabled) {
      const existing = await prisma.featureToggle.findFirst({
        where: { key, tenantId: null },
        select: { id: true },
      });
      if (existing) {
        await prisma.featureToggle.update({
          where: { id: existing.id },
          data: { enabled: true },
        });
      } else {
        await prisma.featureToggle.create({
          data: { key, enabled: true, changedBy: "standalone-setup", tenantId: null },
        });
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

/** Poll GET /health until it returns 200 or the deadline passes. */
async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${STANDALONE_API_URL}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return;
      lastErr = new Error(`health returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `[standalone] server did not become healthy at ${STANDALONE_API_URL}/health: ` +
      `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

export async function setup(): Promise<void> {
  applyStandaloneEnv();
  await ensureDynamoTable();

  // Import the boot harness AFTER env is applied so module-level reads see it.
  const { bootStandaloneServer } = await import(
    "../fixtures/example-extension/boot.js"
  );
  server = await bootStandaloneServer();

  await waitForHealth();
  await seedFeatureToggles();
  // eslint-disable-next-line no-console
  console.log(`[standalone] server healthy at ${STANDALONE_API_URL}`);
}

export async function teardown(): Promise<void> {
  if (server) {
    // Drop idle keep-alive sockets so close() resolves promptly (Node 18.2+),
    // otherwise vitest waits ~10s on open handles before force-exiting.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  // Release DB pools and the shared Neo4j driver so the process exits cleanly.
  try {
    const { sharedDatabaseConnectionManager } = await import(
      "../../src/lib/database-connection-manager.js"
    );
    await sharedDatabaseConnectionManager.shutdown();
  } catch {
    // best-effort
  }
  try {
    const { closeSharedGraphService } = await import(
      "../../src/lib/graph/index.js"
    );
    await closeSharedGraphService();
  } catch {
    // best-effort
  }

  // The booted server's AWS SDK clients (DynamoDB/S3/SQS) hold keep-alive
  // sockets with no public dispose hook, so vitest would otherwise wait ~10s
  // on open handles before force-exiting. Results are finalized by the time
  // teardown runs (verified: vitest sets process.exitCode before this hook),
  // so exiting here preserves the real pass/fail code — a failing run still
  // exits non-zero.
  process.exit(process.exitCode ?? 0);
}
