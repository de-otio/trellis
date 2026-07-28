/**
 * migrate.ts — one-shot DB schema-migration entrypoint for the container image.
 *
 * Runs `prisma migrate deploy` as a standalone container command, reusing:
 *   - the SAME connection resolution as the runtime (`resolveDbConnectionString`)
 *     so there is NO second copy of the URL-composition logic, and
 *   - the SAME committed `apps/api/prisma.config.ts` (schema + migrations paths)
 *     the repo uses for local/CI migrations.
 *
 * Intended to run as a one-shot Job BEFORE the app rolls (schema-before-serve).
 * Idempotent — applies only pending migrations; a fully-migrated DB is a fast
 * no-op. Safe under concurrency — Prisma takes a Postgres advisory lock for the
 * duration of `migrate deploy`, so two racing runners cannot corrupt each other.
 *
 * Exit code is the prisma CLI's exit code (0 = success/no-op) so an orchestrator
 * (the Job / the deploy script) fails loud and fail-closed on a bad migration.
 */

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { resolveDbConnectionString } from "../api/src/lib/lambda-prisma.js";

/** Absolute in-image paths (see apps/worker/Dockerfile runtime stage). */
const PRISMA_CLI = "/repo/node_modules/prisma/build/index.js";
/** `prisma.config.ts` lives here; its `../../prisma` paths resolve to /repo/prisma. */
const CONFIG_CWD = "/repo/apps/api";

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => { status: number | null };

/**
 * Resolve the DB connection the runtime way, then shell out to
 * `prisma migrate deploy`. Returns the CLI exit code. Injectable deps keep it
 * unit-testable without a real DB or child process.
 */
export async function runMigrate(
  deps: { spawn?: SpawnFn; resolveUrl?: (fresh: boolean) => Promise<string> } = {},
): Promise<number> {
  const spawn = deps.spawn ?? (spawnSync as unknown as SpawnFn);
  const resolveUrl = deps.resolveUrl ?? resolveDbConnectionString;

  // Same resolution the app boots with (DATABASE_URL → DB_SECRET_ARN → decomposed
  // DB_SECRET_* + DB_NAME). Migrations need a DIRECT connection: DIRECT == main
  // (no shadow DB) so the committed config skips shadowDatabaseUrl.
  const url = await resolveUrl(false);

  const res = spawn(process.execPath, [PRISMA_CLI, "migrate", "deploy"], {
    cwd: CONFIG_CWD,
    env: { ...process.env, DATABASE_URL: url, DIRECT_DATABASE_URL: url },
    stdio: "inherit",
  });
  return res.status ?? 1;
}

// Only run when executed directly (not when imported by tests).
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (isDirectRun) {
  runMigrate()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("migrate entrypoint failed:", err);
      process.exit(1);
    });
}
