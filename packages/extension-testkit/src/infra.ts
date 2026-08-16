/**
 * The local stack a standalone Trellis boot expects: a migrated Postgres, a
 * single-table DynamoDB, and the feature toggles core's handlers gate on.
 *
 * Each step is exported individually as well as being run by
 * `startStandaloneServer`, because a lane that manages its own database will
 * want the toggles but not the migrations, or the reverse.
 */

import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";

const execFileAsync = promisify(execFile);

/**
 * Create the single-table KV store in DynamoDB-local. Idempotent: an existing
 * table is left as it is, and a concurrent creator racing us is not an error.
 */
export async function ensureDynamoTable(options: {
  table: string;
  endpoint: string;
  region?: string;
}): Promise<void> {
  const client = new DynamoDBClient({
    region: options.region ?? process.env.AWS_REGION ?? "us-east-1",
    endpoint: options.endpoint,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  try {
    await client.send(new DescribeTableCommand({ TableName: options.table }));
    return;
  } catch {
    // Not there — fall through and create it.
  }
  try {
    await client.send(
      new CreateTableCommand({
        TableName: options.table,
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
  } catch (err) {
    // Two lanes starting together both miss on Describe and both Create.
    if ((err as { name?: string })?.name !== "ResourceInUseException") throw err;
  } finally {
    client.destroy();
  }
}

/**
 * Absolute path to the `prisma/` directory inside the installed
 * `@de-otio/trellis` tarball.
 *
 * Resolved via the package's own `package.json` rather than by importing
 * `@de-otio/trellis/prisma/schema.prisma`: core ships an `exports` map, and a
 * subpath it does not name is not resolvable at all. `./package.json` is named
 * (it is the one subpath every package should export), so this route survives
 * any narrowing of core's map.
 */
export function coreSchemaPath(): string {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("@de-otio/trellis/package.json");
  const schema = join(dirname(manifest), "prisma", "schema.prisma");
  if (!existsSync(schema)) {
    throw new Error(
      `[testkit] @de-otio/trellis is installed at ${dirname(manifest)} but ships ` +
        `no prisma/schema.prisma. Core's tarball builds that directory in its ` +
        `\`prepack\` script, so an install from a git checkout or a workspace ` +
        `link will not have it — point applyCoreMigrations() at the checkout's ` +
        `prisma/ directory with the \`schemaPath\` option.`,
    );
  }
  return schema;
}

/**
 * Bring the database up to core's current schema by running
 * `prisma migrate deploy` against the migrations core ships.
 *
 * `deploy`, never `dev`: `dev` is interactive, will offer to reset the
 * database, and needs a shadow database. This is the non-interactive,
 * forward-only one — the same command a deployment runs.
 *
 * A GENERATED CONFIG FILE, and why there is no way around it
 * ---------------------------------------------------------
 * Prisma 7 moved `datasource.url` out of `schema.prisma` and into a Prisma
 * config file, and `migrate deploy` now refuses to run without one — a
 * `DATABASE_URL` in the environment is no longer enough. Core's own config
 * lives at `apps/api/prisma.config.ts`, is TypeScript, and is found only when
 * the CLI's working directory is that of core's repo. None of which is true
 * for someone who installed core from npm.
 *
 * So one is written per call, into a temp directory, as `.mjs` — a consumer
 * needs no TypeScript loader for it — and passed with `--config`. It imports
 * `defineConfig` by absolute file URL because a temp directory has no
 * `node_modules` to resolve `prisma/config` through, and `defineConfig` is not
 * an identity function: it validates and fills defaults, so a hand-rolled
 * object literal would be a guess at Prisma's internal shape.
 */
export async function applyCoreMigrations(options?: {
  databaseUrl?: string;
  schemaPath?: string;
}): Promise<void> {
  const schema = options?.schemaPath ?? coreSchemaPath();
  const databaseUrl = options?.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "[testkit] applyCoreMigrations() needs a database URL: pass " +
        "`databaseUrl`, or call standaloneEnv() first so DATABASE_URL is set.",
    );
  }
  const require = createRequire(import.meta.url);
  let prismaBin: string;
  let prismaConfigModule: string;
  try {
    prismaBin = require.resolve("prisma/build/index.js");
    prismaConfigModule = require.resolve("prisma/config");
  } catch {
    throw new Error(
      "[testkit] could not resolve the prisma CLI. It is a dependency of this " +
        "package; a broken or deduped install is the usual cause.",
    );
  }

  const configDir = await mkdtemp(join(tmpdir(), "trellis-testkit-prisma-"));
  const configPath = join(configDir, "prisma.config.mjs");
  try {
    await writeFile(
      configPath,
      `import { defineConfig } from ${JSON.stringify(pathToFileURL(prismaConfigModule).href)};\n` +
        `export default defineConfig({\n` +
        `  schema: ${JSON.stringify(schema)},\n` +
        `  migrations: { path: ${JSON.stringify(join(dirname(schema), "migrations"))} },\n` +
        // No shadowDatabaseUrl: `deploy` never diffs, and Prisma rejects a
        // shadow equal to the main database — which is what it would be here.
        `  datasource: { url: ${JSON.stringify(databaseUrl)} },\n` +
        `});\n`,
      "utf8",
    );
    await execFileAsync(
      process.execPath,
      [prismaBin, "migrate", "deploy", `--config=${configPath}`],
      {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL ?? databaseUrl,
        },
      },
    );
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

/**
 * Enable GLOBAL feature toggles (`tenant_id IS NULL`).
 *
 * Core's handlers gate on toggles that default to **off**, so a lane that does
 * not seed them sees 403s and 404s that look like extension bugs.
 *
 * Written against `pg` rather than Prisma on purpose: an extension author has
 * no generated Prisma client — the schema lives in core, and Prisma 7's bare
 * `@prisma/client` exports nothing until generation. That means raw SQL, which
 * couples this function to core's column names. That coupling is real; keeping
 * it *here*, versioned with core, is the point of the testkit owning the step
 * rather than every downstream repo hand-rolling it.
 *
 * The manual find-then-write is not laziness: P1 replaced the `@unique` on
 * `key` with `@@unique([key, tenantId])`, and SQL treats `(key, NULL)` as
 * distinct from itself — so no upsert can target a global row.
 */
export async function seedGlobalFeatureToggles(
  keys: readonly string[],
  options?: { databaseUrl?: string; changedBy?: string },
): Promise<void> {
  if (keys.length === 0) return;
  const connectionString = options?.databaseUrl ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "[testkit] seedGlobalFeatureToggles() needs a database URL: pass " +
        "`databaseUrl`, or call standaloneEnv() first so DATABASE_URL is set.",
    );
  }
  const changedBy = options?.changedBy ?? "trellis-testkit";
  const { Client } = await import("pg");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const key of keys) {
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM feature_toggles WHERE key = $1 AND tenant_id IS NULL LIMIT 1",
        [key],
      );
      if (existing.rows.length > 0) {
        await client.query("UPDATE feature_toggles SET enabled = true WHERE id = $1", [
          existing.rows[0]!.id,
        ]);
      } else {
        await client.query(
          `INSERT INTO feature_toggles (id, key, enabled, changed_by, tenant_id)
           VALUES ($1, $2, true, $3, NULL)`,
          [`testkit-${key}`, key, changedBy],
        );
      }
    }
  } finally {
    await client.end();
  }
}

/** Poll `GET /health` until it answers 200, or the deadline passes. */
export async function waitForHealth(apiUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiUrl}/health`, {
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
    `[testkit] server did not become healthy at ${apiUrl}/health within ` +
      `${timeoutMs}ms: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}
