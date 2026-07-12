/**
 * Docker-gated integration test for the O-1 L2 replay baseline (design §12.2).
 *
 * Exercises the imperative shell end-to-end against a LOCAL, EPHEMERAL Postgres:
 * replay the core migration history into a fresh baseline, apply the raw-SQL
 * sidecar, write it UNDER THE PLAN DIR (never prisma/migrations/), then verify
 * the round-trip diff is EMPTY (acceptance criterion c: the baseline is
 * equivalent to the shipped migration history, PostGIS/GiST/GIN raw SQL and all).
 *
 * GATED: skips unless BOTH shadow-DB URLs are provided via env. They MUST point
 * at ephemeral local databases (the prisma.config.ts uses DIRECT_DATABASE_URL as
 * the shadow for `--to-migrations`). Provision two empty local DBs and run:
 *
 *   O1_L2_SHADOW_DB_URL=postgresql://trellis:trellis_dev_password@localhost:5432/o1_l2_a \
 *   O1_L2_SHADOW_DIRECT_URL=postgresql://trellis:trellis_dev_password@localhost:5432/o1_l2_b \
 *   npm run test:integration -w @de-otio/trellis -- \
 *     test/integration/extension-schema-baseline.integration.test.ts
 *
 * When the compose Postgres is not up (no env vars), this suite SKIPS with a
 * recorded note — the pure composer + sidecar unit tests carry the correctness
 * gate that always runs.
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildReplayBaseline,
  verifyRoundTrip,
} from "../../src/lib/extension-schema-baseline.js";

const DB_URL = process.env.O1_L2_SHADOW_DB_URL;
const DIRECT_URL = process.env.O1_L2_SHADOW_DIRECT_URL;
const ENABLED = Boolean(DB_URL && DIRECT_URL && DB_URL !== DIRECT_URL);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(HERE, "../..");
const MIGRATIONS_DIR = path.resolve(API_DIR, "../../prisma/migrations");
// Baseline lands UNDER THE PLAN DIR — never prisma/migrations/ (PLAN §6/§7).
const OUT_DIR = path.resolve(
  API_DIR,
  "../../plans/010-o1-extension-owned-schema/generated/baseline",
);

describe.skipIf(!ENABLED)("O-1 L2 replay baseline (Docker-gated)", () => {
  const opts = {
    apiDir: API_DIR,
    migrationsDir: MIGRATIONS_DIR,
    outDir: OUT_DIR,
    databaseUrl: DB_URL!,
    directDatabaseUrl: DIRECT_URL!,
  };

  afterAll(async () => {
    await rm(OUT_DIR, { recursive: true, force: true });
  });

  it(
    "replays the core history, preserves raw SQL, and round-trips empty",
    async () => {
      const built = await buildReplayBaseline(opts);

      // Raw-SQL sidecar preserved core's non-DSL DDL verbatim.
      expect(built.sql).toContain("CREATE EXTENSION IF NOT EXISTS postgis;");
      expect(built.sql).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
      expect(built.sql).toContain("geography(Point,4326)");
      expect(built.sql).toContain('USING GIST ("location")');
      expect(built.sql).not.toContain("gin_trgm_ops ASC");

      // The equivalence gate: no difference vs the shipped migration history.
      const rt = await verifyRoundTrip(opts, built.baselineDir);
      expect(rt.empty, `round-trip diff was not empty:\n${rt.output}`).toBe(
        true,
      );
    },
    120_000,
  );

  it(
    "appends an extension CREATE TABLE section when supplied",
    async () => {
      const extSql = `CREATE TABLE "ext_widget__records" (\n  "id" TEXT NOT NULL,\n  CONSTRAINT "ext_widget__records_pkey" PRIMARY KEY ("id")\n);`;
      const built = await buildReplayBaseline({ ...opts, extensionSql: extSql });
      expect(built.sql).toContain("-- ---- extension-owned tables (ext_*) ----");
      expect(built.sql).toContain('CREATE TABLE "ext_widget__records"');
    },
    120_000,
  );
});

if (!ENABLED) {
  // Recorded note (visible in the test output) — see ASSUMPTIONS A-L2.3.
  describe("O-1 L2 replay baseline (Docker-gated)", () => {
    it.skip(
      "SKIPPED: set O1_L2_SHADOW_DB_URL + O1_L2_SHADOW_DIRECT_URL (ephemeral local DBs) to run",
      () => {},
    );
  });
}
