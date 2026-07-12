/**
 * Replay-baseline builder — IMPERATIVE SHELL (O-1 design §12.2, Q7; PLAN L2).
 *
 * Carved OUT of the coverage-gated pure composer (`extension-schema-composer.ts`)
 * by design (PLAN §5): this file spawns the `prisma` CLI, reads/writes files, and
 * is exercised only by the Docker-gated integration test — never in the pure
 * unit lane. Keep it thin; all decision logic that CAN be pure lives in the
 * composer.
 *
 * What it does (design §12.2):
 *   1. REPLAY the core migration history into a fresh baseline SQL via
 *      `prisma migrate diff --from-empty --to-migrations <migrations> --script`.
 *   2. Concatenate a **raw-SQL sidecar** onto the replayed body. The sidecar
 *      exists because `migrate diff --script` serialises through Prisma's DMMF,
 *      which is provably LOSSY for this schema's non-DSL SQL (empirically:
 *      it emits `geography()` instead of `geography(Point,4326)`, drops
 *      `CREATE EXTENSION`, and appends an invalid `ASC` to GiST/GIN opclass
 *      indexes). The sidecar prepends the extensions and restores the verbatim
 *      raw DDL — this is Q7's "linted raw-SQL sidecar", layered ON TOP of the
 *      replay (A-L2.2).
 *   3. Append the extension `CREATE TABLE ext_*` section (empty today — no
 *      extension owns tables yet; slot kept).
 *   4. Write the baseline UNDER THE PLAN DIR — never into `prisma/migrations/`
 *      (shipped schema is a human-checkpoint item; PLAN §6/§7).
 *   5. ROUND-TRIP verify: `prisma migrate diff --from-migrations <baseline>
 *      --to-migrations <migrations> --exit-code` must report no difference.
 *
 * The `prisma` CLI + shadow DB are injected as seams so the shell stays a thin
 * wrapper; the shadow database MUST be local/ephemeral (PLAN §6) — the caller
 * supplies its URLs.
 */

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Raw-SQL sidecar — verbatim repairs for DMMF-serialisation lossiness (Q7)
// ---------------------------------------------------------------------------

/**
 * One verbatim find→replace repair applied to the replayed baseline body. Each
 * repair asserts it applied AT LEAST once (unless `optional`), so a change in
 * the upstream diff shape fails loudly rather than silently shipping bad DDL.
 */
export interface RawSqlRepair {
  readonly reason: string;
  readonly find: string | RegExp;
  readonly replace: string;
  /** When true, zero matches is acceptable (e.g. an index that may move). */
  readonly optional?: boolean;
}

/**
 * The core raw-SQL repairs, keyed to the verbatim SQL in
 * `prisma/migrations/20260705050826_init/migration.sql`. Each restores what the
 * DMMF `--script` serialiser mangles. Validated empirically: with these three
 * repairs + the CREATE EXTENSION prepend, the round-trip reports
 * "No difference detected".
 */
export const CORE_RAW_SQL_REPAIRS: readonly RawSqlRepair[] = [
  {
    reason:
      "PostGIS geography column: DMMF renders Unsupported(\"geography(Point,4326)\") as bare geography()",
    find: /geography\(\) NOT NULL/g,
    replace: "geography(Point,4326) NOT NULL",
  },
  {
    reason:
      "GiST spatial index: DMMF appends an invalid opclass + ASC that GiST rejects",
    find: 'USING GIST ("location" gist_geography_ops ASC)',
    replace: 'USING GIST ("location")',
  },
  {
    reason: "GIN trigram indexes: DMMF appends an invalid ASC after the opclass",
    find: /(gin_trgm_ops) ASC\)/g,
    replace: "$1)",
  },
  {
    reason:
      "GiST expression (geography) index: DMMF appends an invalid opclass + ASC",
    find: "gist_geography_ops ASC)",
    replace: ")",
    optional: true,
  },
];

/** The extensions the core init migration installs (dropped by the diff). */
export const CORE_EXTENSION_PREAMBLE = [
  "-- O-1 replay baseline: raw-SQL sidecar (design §12.2). Extensions the DMMF",
  "-- diff drops because the shadow DB already has them — restored verbatim so",
  "-- a truly-empty target DB installs them before the tables that need them.",
  "CREATE EXTENSION IF NOT EXISTS postgis;",
  "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
  "",
].join("\n");

/**
 * Apply the raw-SQL sidecar to a replayed baseline body: prepend the extension
 * preamble, then apply every repair. Throws if a required repair matched zero
 * times (upstream diff shape drifted — fail loudly). PURE — exported for unit
 * testing without spawning prisma.
 */
export function applyRawSqlSidecar(
  replayBody: string,
  repairs: readonly RawSqlRepair[] = CORE_RAW_SQL_REPAIRS,
  preamble: string = CORE_EXTENSION_PREAMBLE,
): string {
  let body = replayBody;
  for (const repair of repairs) {
    const before = body;
    // replaceAll accepts string | (global) RegExp; every regexp repair here is /g.
    body = body.replaceAll(repair.find, repair.replace);
    if (body === before && !repair.optional) {
      throw new Error(
        `raw-SQL sidecar: repair did not apply (upstream diff drifted?): ${repair.reason}`,
      );
    }
  }
  return `${preamble}${body}`;
}

// ---------------------------------------------------------------------------
// Process seam
// ---------------------------------------------------------------------------

export interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type ExecFn = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

/** Default process runner — spawns and buffers stdout/stderr. */
export const defaultExec: ExecFn = (command, args, options) =>
  new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

// ---------------------------------------------------------------------------
// Baseline builder
// ---------------------------------------------------------------------------

export interface BuildBaselineOptions {
  /** apps/api dir (has prisma.config.ts) — cwd for the prisma CLI. */
  readonly apiDir: string;
  /** Absolute path to the core `prisma/migrations` directory. */
  readonly migrationsDir: string;
  /** Absolute dir UNDER THE PLAN DIR to write the baseline into. */
  readonly outDir: string;
  /**
   * Ephemeral, LOCAL shadow DB URL for `--to-migrations` replay (never shared /
   * prod). The prisma.config.ts sets `shadowDatabaseUrl` from DIRECT_DATABASE_URL
   * when it differs from DATABASE_URL — so pass two distinct local DBs.
   */
  readonly databaseUrl: string;
  readonly directDatabaseUrl: string;
  /** Extension `CREATE TABLE ext_*` DDL to append (empty today). */
  readonly extensionSql?: string;
  /** Path to the prisma CLI binary (default: resolve from node_modules/.bin). */
  readonly prismaBin?: string;
  /** Injected process runner (tests pass a fake; default spawns). */
  readonly exec?: ExecFn;
}

export interface BuildBaselineResult {
  /** Absolute path to the written baseline migration.sql. */
  readonly baselinePath: string;
  /** Absolute path to the baseline migrations dir (for round-trip). */
  readonly baselineDir: string;
  /** The full baseline SQL that was written. */
  readonly sql: string;
}

const BASELINE_MIGRATION_NAME = "00000000000000_o1_composed_baseline";

function prismaEnv(opts: BuildBaselineOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: opts.databaseUrl,
    DIRECT_DATABASE_URL: opts.directDatabaseUrl,
  };
}

/**
 * Build the replay baseline. Steps 1–4 of §12.2. Returns paths for the caller
 * (and the round-trip verify). Throws on a non-zero prisma exit or a sidecar
 * mismatch.
 */
export async function buildReplayBaseline(
  opts: BuildBaselineOptions,
): Promise<BuildBaselineResult> {
  const exec = opts.exec ?? defaultExec;
  const prismaBin =
    opts.prismaBin ?? path.resolve(opts.apiDir, "../../node_modules/.bin/prisma");
  const env = prismaEnv(opts);

  // 1. Replay: from-empty → to-migrations, as a --script.
  const replay = await exec(
    prismaBin,
    [
      "migrate",
      "diff",
      "--from-empty",
      "--to-migrations",
      opts.migrationsDir,
      "--script",
    ],
    { cwd: opts.apiDir, env },
  );
  if (replay.code !== 0) {
    throw new Error(
      `prisma migrate diff (replay) failed (code ${replay.code}): ${replay.stderr}`,
    );
  }

  // 2. Raw-SQL sidecar over the replayed body.
  const repaired = applyRawSqlSidecar(replay.stdout);

  // 3. Append the extension CREATE TABLE section (empty today; slot kept).
  const extSql = opts.extensionSql?.trim();
  const sql =
    extSql && extSql.length > 0
      ? `${repaired.trimEnd()}\n\n-- ---- extension-owned tables (ext_*) ----\n\n${extSql}\n`
      : repaired;

  // 4. Write UNDER THE PLAN DIR — never prisma/migrations/.
  const baselineDir = opts.outDir;
  const migrationDir = path.join(baselineDir, BASELINE_MIGRATION_NAME);
  await rm(baselineDir, { recursive: true, force: true });
  await mkdir(migrationDir, { recursive: true });
  const baselinePath = path.join(migrationDir, "migration.sql");
  await writeFile(baselinePath, sql, "utf8");
  await writeFile(
    path.join(baselineDir, "migration_lock.toml"),
    'provider = "postgresql"\n',
    "utf8",
  );

  return { baselinePath, baselineDir, sql };
}

/**
 * Round-trip verification (§12.2 step 4): the baseline must be equivalent to the
 * core migration history. Returns `{ empty: true }` when prisma reports no
 * difference (exit 0 under `--exit-code`), else the rendered diff for
 * diagnostics. `--exit-code`: Empty→0, Error→1, Not-empty→2.
 */
export async function verifyRoundTrip(
  opts: BuildBaselineOptions,
  baselineDir: string,
): Promise<{ readonly empty: boolean; readonly output: string }> {
  const exec = opts.exec ?? defaultExec;
  const prismaBin =
    opts.prismaBin ?? path.resolve(opts.apiDir, "../../node_modules/.bin/prisma");
  const result = await exec(
    prismaBin,
    [
      "migrate",
      "diff",
      "--from-migrations",
      baselineDir,
      "--to-migrations",
      opts.migrationsDir,
      "--exit-code",
    ],
    { cwd: opts.apiDir, env: prismaEnv(opts) },
  );
  if (result.code === 1) {
    throw new Error(
      `round-trip verify errored (code 1): ${result.stderr || result.stdout}`,
    );
  }
  return {
    empty: result.code === 0,
    output: `${result.stdout}\n${result.stderr}`.trim(),
  };
}
